/**
 * API del backoffice (docs/08): lo que lee y hace un usuario del prestamista desde el navegador.
 * Misma regla que `/v1`: el tenant sale de la credencial (aquí la sesión), nunca de un parámetro,
 * y todo corre en `withTenant` con el rol `gow_api`. Cada mutación entra a la bitácora con el
 * usuario; la vista de una solicitud también (docs/08 §2, "quién vio qué").
 */
import { createHash, randomUUID } from 'node:crypto'
import { applicationDocuments, applications, decisions, documents, extractions, outcomes, policyVersions, suppliers, tenants, tenantUsers, withTenant, type Db } from '@gow/db'
import { applyCorrections } from '@gow/extraction/corrections'
import { ClarificationStatus, CorrectionTarget, MagicLinkBody, type ApplicationDetail, type Correction, type MagicLinkAccepted, type SessionConfig, SessionCreateBody, SetupBody, type ApplicationRow, type AuditEntry, type BackofficeMe, type ClarificationItem, type PolicyVersionItem, ApplicationStatus } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { pathBelongsTo } from '@gow/platform'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { answerClarification, audit, createPolicyDraft, discardDocument, HttpError, parse, PolicyBody, recordCorrections, recordOutcome, simulateVersion, transitionVersion } from './ops.ts'
import { clearedCookies, CSRF_HEADER, issueToken, openRefresh, readCookie, REFRESH_COOKIE, refreshCookie, refreshRemaining, sealRefresh, SESSION_COOKIE, sessionCookie, verifyToken, type RefreshPayload, type SessionClaims, type SessionLimits } from './session.ts'
import { llmRouter } from './bo/llm.ts'
import { promptsRouter } from './bo/prompts.ts'
import { settingsRouter } from './bo/settings.ts'
import { actorOf, backofficeBase, ENTER_PATH, iso, PENDING_SUPPLIER_NAME, SESSION_SECONDS, SUPPLIER_NOT_FOUND, type BackofficeDeps, type Who, who, whatsappSession } from './bo/shared.ts'
import { suppliersRouter } from './bo/suppliers.ts'
import { teamRouter } from './bo/team.ts'
import { timelineRouter } from './bo/timeline.ts'
import type { AuthDirectory } from './supabase-auth.ts'

export type { BackofficeDeps }

/**
 * Con menos de esto de vida, el access token se renueva en la petición que llegue: 5 min, o la mitad
 * de su vida si es más corta (un `JWT_EXPIRY` de 2 min no renueva en cada petición).
 */
const REFRESH_BEFORE_SECONDS = 5 * 60
const refreshBefore = (c: SessionClaims) => (c.iat === undefined ? REFRESH_BEFORE_SECONDS : Math.min(REFRESH_BEFORE_SECONDS, Math.floor((c.exp - c.iat) / 2)))
/**
 * Una renovación se comparte con las peticiones que lleguen con el mismo refresh token en este lapso
 * (las que salieron en paralelo del navegador antes de recibir las cookies nuevas).
 */
const REFRESH_SHARE_MS = 30_000
const nowSeconds = () => Math.floor(Date.now() / 1000)
const SESSION_REQUIRED = 'sesión requerida'
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error')
/** Una escritura con cookie debe traer el encabezado: un formulario de otro sitio no puede ponerlo. */
function assertCsrf(req: Request): void {
  if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
}

/**
 * Ventana fija por llave en memoria (un proceso de API). Se limpia sola al crecer: un atacante que
 * rota llaves no la hace crecer sin límite.
 */
function windowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { start: number; count: number }>()
  return (key: string): boolean => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k)
    const w = hits.get(key)
    if (!w || now - w.start > windowMs) {
      hits.set(key, { start: now, count: 1 })
      return true
    }
    return ++w.count <= limit
  }
}

export function backofficeRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.use(express.json({ limit: '2mb' }))
  r.use((_req, res, next) => {
    // Datos de un tenant: nunca en cachés compartidas.
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  const attempts = new Map<string, { start: number; count: number }>()
  const secure = deps.secureCookies === true
  const backofficeOrigin = backofficeBase(deps)
  // Pedir enlaces: por IP responde 429; por correo se descarta en silencio (la respuesta no cambia).
  const magicLinkPerIp = windowLimiter(5, 60_000)
  const magicLinkPerEmail = windowLimiter(3, 15 * 60_000)

  const limits: SessionLimits = { maxSeconds: (deps.sessionMaxHours ?? 12) * 3600, idleSeconds: (deps.sessionIdleHours ?? 8) * 3600 }

  /** La pertenencia vigente de unos claims ya verificados, o null si ya no es miembro. */
  async function memberOf(claims: SessionClaims): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
    const [m] = await withTenant(deps.db, claims.tenant_id, (tx) => tx.select().from(tenantUsers).where(and(eq(tenantUsers.tenantId, claims.tenant_id), eq(tenantUsers.userId, claims.sub))))
    return m ? { userId: m.userId, email: m.email, tenantId: m.tenantId, exp: claims.exp, supabaseSession: claims.session_id !== undefined } : null
  }

  async function membership(token: string): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
    const claims = verifyToken(deps.backofficeJwtSecret, token)
    return claims ? memberOf(claims) : null
  }

  /** Cierra la sesión de GoTrue de un access token; si falla, solo se registra el código. */
  async function revokeQuietly(auth: AuthDirectory, accessToken: string, what: string): Promise<void> {
    await auth.revokeSession(accessToken).catch((e: unknown) => {
      deps.logger?.error(`backoffice: no se cerró la sesión de Auth ${what} (${errorText(e)})`)
    })
  }

  /**
   * Renovaciones en curso o recién hechas, por hash del refresh token (nunca el token como llave).
   * Varias peticiones en paralelo con la misma cookie hacen una sola llamada a GoTrue y reciben los
   * mismos tokens nuevos. Entre instancias, lo cubre el intervalo de reúso de GoTrue (ADR 0036).
   */
  const refreshes = new Map<string, { at: number; result: Promise<{ accessToken: string; refreshToken: string } | null> }>()
  function refreshOnce(auth: AuthDirectory, refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const key = createHash('sha256').update(refreshToken).digest('base64url')
    const now = Date.now()
    if (refreshes.size > 1_000) for (const [k, v] of refreshes) if (now - v.at > REFRESH_SHARE_MS) refreshes.delete(k)
    const hit = refreshes.get(key)
    if (hit && now - hit.at <= REFRESH_SHARE_MS) return hit.result
    const result = auth.refreshSession(refreshToken)
    refreshes.set(key, { at: now, result })
    // Un error transitorio no se comparte más allá de quien ya esperaba: la siguiente petición reintenta.
    result.catch(() => {
      if (refreshes.get(key)?.result === result) refreshes.delete(key)
    })
    return result
  }

  /** Las cookies de una sesión renovada: el access token y el refresh token nuevo, cifrado. */
  function renewedCookies(accessToken: string, exp: number, payload: RefreshPayload): string[] {
    const now = nowSeconds()
    const left = refreshRemaining(payload, limits, now)
    return [sessionCookie(accessToken, { maxAgeSeconds: Math.min(SESSION_SECONDS, exp - now, left), secure }), refreshCookie(sealRefresh(deps.backofficeJwtSecret, payload), { maxAgeSeconds: left, secure })]
  }

  function unauthorized(res: Response, clear: boolean): HttpError {
    if (clear) res.setHeader('Set-Cookie', clearedCookies(secure))
    return new HttpError(401, SESSION_REQUIRED)
  }

  /**
   * Sesión por cookie (ADR 0036). Con un access token vigente y de un miembro, entra; si le quedan
   * menos de 5 min y hay cookie de refresh, se renueva antes. Sin access token vigente, se renueva
   * con la cookie de refresh o se responde 401 y se borran las cookies. Mientras el access token
   * actual sirva, un fallo al renovar no saca a nadie.
   */
  async function cookieSession(req: Request, res: Response): Promise<Who> {
    const header = req.header('cookie')
    const token = readCookie(header, SESSION_COOKIE)
    const sealed = deps.auth ? readCookie(header, REFRESH_COOKIE) : null
    const hadCookies = Boolean(token ?? readCookie(header, REFRESH_COOKIE))
    const now = nowSeconds()
    const claims = token ? verifyToken(deps.backofficeJwtSecret, token, now) : null
    let rc = sealed ? openRefresh(deps.backofficeJwtSecret, sealed, limits, now) : null
    if (rc && claims && rc.sub !== claims.sub) rc = null

    let current: Who | null = null
    if (claims && token) {
      current = await memberOf(claims)
      if (!current) {
        // Quitaron al usuario: fuera, y su sesión de GoTrue se cierra con el token que trae.
        if (deps.auth && claims.session_id !== undefined) await revokeQuietly(deps.auth, token, 'de un usuario sin pertenencia')
        throw unauthorized(res, true)
      }
      if (!rc || claims.exp - now > refreshBefore(claims)) return current
    }
    const auth = deps.auth
    if (!rc || !auth) throw unauthorized(res, hadCookies)

    let fresh: { accessToken: string; refreshToken: string } | null
    try {
      fresh = await refreshOnce(auth, rc.rt)
    } catch (e) {
      deps.logger?.error(`backoffice: no se renovó la sesión (${errorText(e)})`)
      if (current) return current
      throw new HttpError(503, 'no se pudo renovar la sesión; intenta de nuevo')
    }
    if (!fresh) {
      // GoTrue rechazó el refresh token. Si el access token actual sirve, se sigue con él: otra
      // petición en paralelo pudo haber rotado ya el refresh token y sus cookies son las buenas.
      if (current) return current
      throw unauthorized(res, true)
    }
    const next = verifyToken(deps.backofficeJwtSecret, fresh.accessToken)
    const renewed = next && next.sub === rc.sub ? await memberOf(next) : null
    if (!next || !renewed) {
      // Sin `tenant_id` (el hook ya no lo pone) o sin pertenencia: fuera, y se cierra su sesión de GoTrue.
      await revokeQuietly(auth, fresh.accessToken, 'de un usuario sin pertenencia')
      throw unauthorized(res, true)
    }
    res.setHeader('Set-Cookie', renewedCookies(fresh.accessToken, next.exp, { ...rc, rt: fresh.refreshToken, rat: now }))
    return renewed
  }

  /** Correo con el enlace de acceso, fuera de la petición: el tiempo de respuesta no dice si la cuenta existe. */
  function sendMagicLink(auth: AuthDirectory, email: string): void {
    auth.sendMagicLink(email, `${backofficeOrigin}${ENTER_PATH}`).catch((e: unknown) => {
      deps.logger?.error(`backoffice: no se pidió el enlace de acceso (${e instanceof Error ? e.message : 'error'})`)
    })
  }

  async function meOf(w: Who): Promise<BackofficeMe> {
    const { t, wa } = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [t] = await tx.select({ id: tenants.id, name: tenants.name, whatsapp: tenants.whatsappNumber }).from(tenants).where(eq(tenants.id, w.tenantId))
      return { t, wa: await whatsappSession(tx, w.tenantId) }
    })
    if (!t) throw new HttpError(401, 'sesión inválida')
    const linked = wa?.running && wa.status === 'open' ? wa.linkedNumber : null
    return { user: { id: w.userId, email: w.email }, tenant: { id: t.id, name: t.name, whatsapp_number: t.whatsapp, whatsapp_linked_number: linked } }
  }

  // ---------- Sesión: el enlace de acceso trae el JWT; la API lo cambia por una cookie HttpOnly
  r.post('/session', async (req, res) => {
    const key = req.ip ?? 'local'
    const now = Date.now()
    const w0 = attempts.get(key)
    if (!w0 || now - w0.start > 60_000) attempts.set(key, { start: now, count: 1 })
    else if (++w0.count > 20) throw new HttpError(429, 'demasiados intentos')
    assertCsrf(req)
    const body = parse(SessionCreateBody, req.body)
    const w = await membership(body.token)
    if (!w) throw new HttpError(401, 'el enlace de acceso no es válido o ya venció')
    const at = nowSeconds()
    if (deps.auth && w.supabaseSession && body.refresh_token) {
      // Supabase Auth (ADR 0036): el refresh token se queda del lado de la API, cifrado en una cookie
      // HttpOnly, y la sesión se renueva sola hasta sus límites.
      res.setHeader('Set-Cookie', renewedCookies(body.token, w.exp, { v: 1, rt: body.refresh_token, sub: w.userId, iat: at, rat: at }))
    } else {
      // Enlace de desarrollo: la cookie vive lo que el token (8 h como máximo).
      res.setHeader('Set-Cookie', sessionCookie(body.token, { maxAgeSeconds: Math.min(SESSION_SECONDS, w.exp - at), secure }))
      // Un token de Supabase sin su refresh token: nadie va a usar ese refresh token, que viajó en
      // la URL. Se cierra su sesión de Auth; el access token sigue valiendo hasta `exp` (ADR 0035).
      if (deps.auth && w.supabaseSession) await revokeQuietly(deps.auth, body.token, 'sin refresh token')
    }
    res.json(await meOf(w))
  })

  /** Si todavía no existe ningún tenant (`app.setup_pending`, ADR 0060). Solo contesta un booleano. */
  async function setupPending(): Promise<boolean> {
    const found = await deps.db.execute<{ pending: boolean }>(sql`select app.setup_pending() as pending`)
    return found.rows[0]?.pending === true
  }

  r.get('/session/config', async (_req, res) => {
    const out: SessionConfig = { magic_link: Boolean(deps.auth), setup_required: await setupPending() }
    res.json(out)
  })

  /**
   * Primer inicio (ADR 0060): crea el tenant, su política base activa y a su administrador, y deja la
   * sesión abierta con la misma cookie que el enlace de desarrollo. Solo funciona mientras no exista
   * ningún tenant (la función de la base lo decide con un candado); después responde 409. Pensado para
   * una instalación local: no pide más prueba de quién llama que esa.
   */
  r.post('/setup', async (req, res) => {
    assertCsrf(req)
    const body = parse(SetupBody, req.body)
    const taken = new HttpError(409, 'el sistema ya tiene una institución crediticia configurada')
    if (!(await setupPending())) throw taken
    let userId: string = randomUUID()
    if (deps.auth) {
      // La cuenta de Auth se crea antes, para que el correo ya sirva con el enlace por correo después.
      try {
        userId = await deps.auth.ensureUser(body.email)
      } catch (e) {
        deps.logger?.error(`backoffice: no se creó la cuenta de Auth del primer inicio (${errorText(e)})`)
        throw new HttpError(502, 'no se pudo crear la cuenta de acceso; intenta de nuevo')
      }
    }
    const created = await deps.db.execute<{ tenant: string | null }>(
      sql`select app.setup_first_tenant(${body.tenant_name}, ${body.whatsapp_number}, ${JSON.stringify(basePolicyTemplate())}::jsonb, ${userId}::uuid, ${body.email})::text as tenant`,
    )
    const tenantId = created.rows[0]?.tenant
    if (!tenantId) throw taken
    const token = issueToken(deps.backofficeJwtSecret, { sub: userId, email: body.email, tenant_id: tenantId }, SESSION_SECONDS)
    res.setHeader('Set-Cookie', sessionCookie(token, { maxAgeSeconds: SESSION_SECONDS, secure }))
    res.status(201).json(await meOf({ userId, email: body.email, tenantId }))
  })

  /**
   * Pedir el enlace de acceso por correo (Supabase Auth). Siempre 202 con el mismo cuerpo, exista o
   * no la cuenta: no revela quién tiene acceso. GoTrue no crea cuentas aquí (`create_user: false`).
   * El correo nunca va a los registros.
   */
  r.post('/session/magic-link', (req, res) => {
    const auth = deps.auth
    if (!auth) throw new HttpError(404, 'no encontrado')
    if (!magicLinkPerIp(req.ip ?? 'local')) throw new HttpError(429, 'demasiados intentos; espera un minuto')
    assertCsrf(req)
    const { email } = parse(MagicLinkBody, req.body)
    if (magicLinkPerEmail(createHash('sha256').update(email).digest('hex'))) sendMagicLink(auth, email)
    const out: MagicLinkAccepted = { accepted: true }
    res.status(202).json(out)
  })

  /**
   * Salir: borra las dos cookies y, con Supabase Auth, cierra la sesión de GoTrue (su refresh token
   * deja de servir). Si el access token ya venció, se renueva una vez solo para poder cerrarla.
   */
  r.delete('/session', async (req, res) => {
    assertCsrf(req)
    const auth = deps.auth
    if (auth) {
      const header = req.header('cookie')
      let token = readCookie(header, SESSION_COOKIE)
      let claims = token ? verifyToken(deps.backofficeJwtSecret, token) : null
      const sealed = readCookie(header, REFRESH_COOKIE)
      const rc = sealed ? openRefresh(deps.backofficeJwtSecret, sealed, limits) : null
      if (!claims && rc) {
        const fresh = await refreshOnce(auth, rc.rt).catch(() => null)
        token = fresh?.accessToken ?? null
        claims = token ? verifyToken(deps.backofficeJwtSecret, token) : null
      }
      if (token && claims?.session_id !== undefined) await revokeQuietly(auth, token, 'al salir')
    }
    res.setHeader('Set-Cookie', clearedCookies(secure))
    res.status(204).end()
  })

  // ---------- Todo lo demás exige sesión vigente y miembro del tenant
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1]
    if (bearer) {
      // Con Bearer no hay cookies ni renovación: el token vale lo que dice su `exp`.
      const w = await membership(bearer)
      if (!w) throw new HttpError(401, SESSION_REQUIRED)
      res.locals.who = w
      next()
      return
    }
    // Con cookie, toda escritura debe traer el encabezado: un formulario de otro sitio no puede. Se
    // revisa antes de renovar nada.
    const header = req.header('cookie')
    const withCookies = Boolean(readCookie(header, SESSION_COOKIE) ?? readCookie(header, REFRESH_COOKIE))
    if (withCookies && !['GET', 'HEAD'].includes(req.method)) assertCsrf(req)
    res.locals.who = await cookieSession(req, res)
    next()
  })

  r.get('/me', async (_req, res) => {
    res.json(await meOf(who(res)))
  })

  // ---------- Bandeja de solicitudes
  r.get('/applications', async (req, res) => {
    const w = who(res)
    const statuses = typeof req.query.status === 'string' && req.query.status ? z.array(ApplicationStatus).parse(req.query.status.split(',')) : null
    const rows = await withTenant(deps.db, w.tenantId, async (tx) => {
      const out = await tx.execute<{
        id: string; status: ApplicationRow['status']; failure_reason: string | null; request: ApplicationRow['request']; created_at: Date; updated_at: Date
        supplier_id: string; legal_name: string
        decision_status: NonNullable<ApplicationRow['decision']>['status'] | null; limit_amount: string | null; score: string | null; policy_version: number | null; reasons: { code: string; message: string }[] | null
        file_name: string | null; bank: string | null; page_count: number | null; issues: number | null; flags: string[] | null; has_extraction: boolean
        open_clarifications: number; outcome: ApplicationRow['outcome']
      }>(sql`
        select a.id, a.status, a.failure_reason, a.request, a.created_at, a.updated_at,
               s.id as supplier_id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name,
               d.status as decision_status, d.limit_amount, d.score, pv.version as policy_version, d.reasons,
               e.file_name, e.bank, e.page_count, e.issues, e.flags, (e.file_name is not null) as has_extraction,
               (select count(*)::int from app.clarifications c where c.application_id = a.id and c.status = 'open') as open_clarifications,
               (select o.outcome from app.outcomes o where o.application_id = a.id order by o.observed_at desc limit 1) as outcome
          from app.applications a
          join app.suppliers s on s.id = a.supplier_id
          left join lateral (select dd.status, dd.limit_amount, dd.score, dd.policy_version_id, dd.payload->'reasons' as reasons from app.decisions dd where dd.application_id = a.id and dd.kind = 'active' order by dd.created_at desc limit 1) d on true
          left join app.policy_versions pv on pv.id = d.policy_version_id
          left join lateral (
            select ex.payload->'document'->>'file_name' as file_name, ex.payload->'bank_name'->>'value' as bank,
                   (ex.payload->'document'->>'page_count')::int as page_count, jsonb_array_length(ex.payload->'issues')::int as issues,
                   array(select jsonb_array_elements_text(ex.payload->'flags')) as flags
              from app.application_documents ad join app.extractions ex on ex.document_id = ad.document_id
             where ad.application_id = a.id order by ex.created_at limit 1) e on true
         ${statuses ? sql`where a.status in (${sql.join(statuses.map((s) => sql`${s}::app.application_status`), sql`, `)})` : sql``}
         order by a.created_at desc
         limit 300`)
      return out.rows
    })
    const list: ApplicationRow[] = rows.map((x) => ({
      id: x.id,
      status: x.status,
      failure_reason: x.failure_reason,
      supplier: { id: x.supplier_id, legal_name: x.legal_name },
      request: x.request,
      decision: x.decision_status ? { status: x.decision_status, limit: x.limit_amount === null ? null : Number(x.limit_amount), score: x.score === null ? null : Number(x.score), policy_version: x.policy_version, reasons: (x.reasons ?? []).map((r) => ({ code: r.code, message: r.message })) } : null,
      document: x.has_extraction ? { file_name: x.file_name, bank: x.bank, page_count: x.page_count, issues: x.issues ?? 0, flags: x.flags ?? [] } : null,
      open_clarifications: x.open_clarifications,
      outcome: x.outcome,
      created_at: new Date(x.created_at).toISOString(),
      updated_at: new Date(x.updated_at).toISOString(),
    }))
    res.json(list)
  })

  // ---------- Detalle: documento, extracción, decisión, aclaraciones
  async function clarificationItems(tx: Parameters<Parameters<Db['transaction']>[0]>[0], where: ReturnType<typeof sql>): Promise<ClarificationItem[]> {
    const rows = await tx.execute<{
      id: string; application_id: string; legal_name: string; round: number; status: ClarificationItem['status']; channel: ClarificationItem['channel']
      questions: ClarificationItem['questions']; answers: ClarificationItem['answers']; created_at: Date; answered_at: Date | null; answered_by: string | null
    }>(sql`
      select c.id, c.application_id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name, c.round, c.status, c.channel, c.questions, c.answers, c.created_at, c.answered_at,
             (select u.email from app.audit_log l join app.tenant_users u on 'user:' || u.user_id::text = l.actor
               where l.subject = c.id::text and l.action = 'clarification.answered' order by l.at desc limit 1) as answered_by
        from app.clarifications c join app.suppliers s on s.id = c.supplier_id
       where ${where}
       order by c.created_at desc`)
    return rows.rows.map((c) => ({ id: c.id, application_id: c.application_id, supplier_name: c.legal_name, round: c.round, status: c.status, channel: c.channel, questions: c.questions, answers: c.answers, created_at: new Date(c.created_at).toISOString(), answered_at: iso(c.answered_at), answered_by: c.answered_by }))
  }

  r.get('/applications/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [a] = await tx.select().from(applications).where(eq(applications.id, id))
      if (!a) throw new HttpError(404, 'solicitud no encontrada')
      const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, a.supplierId))
      if (!s) throw new HttpError(404, SUPPLIER_NOT_FOUND)
      const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, id))
      const docs = links.length ? await tx.select().from(documents).where(inArray(documents.id, links.map((l) => l.documentId))) : []
      const [ex] = docs.length ? await tx.select().from(extractions).where(inArray(extractions.documentId, docs.map((d) => d.id))).orderBy(extractions.createdAt).limit(1) : []
      const [dec] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
      const [shadow] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'shadow'))).orderBy(desc(decisions.createdAt)).limit(1)
      const versionIds = [dec?.policyVersionId, shadow?.policyVersionId].filter((v): v is string => !!v)
      const versions = versionIds.length ? await tx.select({ id: policyVersions.id, version: policyVersions.version }).from(policyVersions).where(inArray(policyVersions.id, versionIds)) : []
      const clar = await clarificationItems(tx, sql`c.application_id = ${id}::uuid`)
      const outs = await tx.select().from(outcomes).where(eq(outcomes.applicationId, id)).orderBy(desc(outcomes.observedAt))
      const fixes = await tx.execute<{ id: string; target: unknown; read_value: string | number | null; value: string | number; page: number | null; created_by: string | null; created_at: Date }>(sql`
        select c.id, c.target, c.read_value, c.value, c.page, u.email as created_by, c.created_at
          from app.corrections c left join app.tenant_users u on u.user_id = c.created_by
         where c.application_id = ${id}::uuid order by c.created_at`)
      await audit(tx, w.tenantId, actorOf(w), 'application.viewed', id)
      return { a, s, docs, ex, dec, shadow, versions, clar, outs, fixes: fixes.rows }
    })
    const fixes: Correction[] = out.fixes.map((c) => ({ id: c.id, target: CorrectionTarget.parse(c.target), read_value: c.read_value, value: c.value, page: c.page, created_by: c.created_by, created_at: new Date(c.created_at).toISOString() }))
    const version = (vid: string | null | undefined) => out.versions.find((v) => v.id === vid)?.version ?? null
    const detail: ApplicationDetail = {
      id: out.a.id,
      status: out.a.status,
      failure_reason: out.a.failureReason,
      request: out.a.request as ApplicationDetail['request'],
      as_of: out.a.asOf,
      created_at: out.a.createdAt.toISOString(),
      updated_at: out.a.updatedAt.toISOString(),
      supplier: { id: out.s.id, legal_name: out.s.legalName ?? PENDING_SUPPLIER_NAME, rfc: out.s.rfc, external_ref: out.s.externalRef, clabes: out.s.clabes },
      documents: out.docs.map((d) => ({ id: d.id, sha256: d.sha256, size_bytes: d.sizeBytes, media_type: d.mediaType })),
      // La extracción guardada es inmutable: se muestra con las correcciones del analista encima.
      extraction: (out.ex ? applyCorrections(out.ex.payload as NonNullable<ApplicationDetail['extraction']>, fixes) : null),
      decision: out.dec ? { id: out.dec.id, policy_version: version(out.dec.policyVersionId), created_at: out.dec.createdAt.toISOString(), payload: out.dec.payload as NonNullable<ApplicationDetail['decision']>['payload'] } : null,
      shadow: out.shadow ? { policy_version: version(out.shadow.policyVersionId), status: out.shadow.status, limit: out.shadow.limitAmount === null ? null : Number(out.shadow.limitAmount), score: out.shadow.score === null ? null : Number(out.shadow.score) } : null,
      clarifications: out.clar,
      outcomes: out.outs.map((o) => ({ outcome: o.outcome, observed_at: o.observedAt.toISOString() })),
      corrections: fixes,
    }
    res.json(detail)
  })

  /** El PDF, desde el almacenamiento propio y solo si es de este tenant (RLS + prefijo de ruta). */
  r.get('/documents/:id/file', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const [d] = await withTenant(deps.db, w.tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, id)))
    if (!d || !pathBelongsTo(d.storagePath, w.tenantId) || d.mediaType !== 'application/pdf') throw new HttpError(404, 'documento no encontrado')
    const bytes = await deps.storage.read(d.storagePath)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  })

  /** Corrección de valores en revisión humana: guarda los pares leído/correcto y reencola a decidir. */
  r.post('/applications/:id/corrections', async (req, res) => {
    const w = who(res)
    res.status(202).json(await recordCorrections(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  /** Descartar el documento en revisión humana: cierra la solicitud sin reevaluar. */
  r.post('/applications/:id/discard', async (req, res) => {
    const w = who(res)
    res.json(await discardDocument(deps.db, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Aclaraciones con respuesta manual
  r.get('/clarifications', async (req, res) => {
    const status = typeof req.query.status === 'string' ? ClarificationStatus.safeParse(req.query.status) : null
    const items = await withTenant(deps.db, who(res).tenantId, (tx) => clarificationItems(tx, status?.success ? sql`c.status = ${status.data}::app.clarification_status` : sql`true`))
    res.json(items)
  })

  /** Respuesta a nombre del proveedor: entra por la misma operación que la API, con el usuario en la bitácora. */
  r.post('/clarifications/:id/answers', async (req, res) => {
    const w = who(res)
    res.json(await answerClarification(deps, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Políticas
  r.get('/policies/versions', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) => tx.select().from(policyVersions).orderBy(desc(policyVersions.version)))
    const list: PolicyVersionItem[] = rows.map((v) => ({ id: v.id, version: v.version, status: v.status, document: v.document, simulation: v.simulation as PolicyVersionItem['simulation'], created_at: v.createdAt.toISOString(), activated_at: iso(v.activatedAt) }))
    res.json(list)
  })

  r.post('/policies/versions', async (req, res) => {
    const w = who(res)
    const body = parse(PolicyBody, req.body)
    res.status(201).json(await createPolicyDraft(deps.db, w.tenantId, actorOf(w), body.document))
  })

  r.post('/policies/versions/:id/simulate', async (req, res) => {
    const w = who(res)
    res.json(await simulateVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id)))
  })
  r.post('/policies/versions/:id/shadow', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'shadow'))
  })
  r.post('/policies/versions/:id/activate', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'active'))
  })

  // ---------- Outcomes y bitácora
  r.post('/outcomes', async (req, res) => {
    const w = who(res)
    await recordOutcome(deps.db, w.tenantId, actorOf(w), req.body)
    res.status(201).json({ ok: true })
  })

  r.get('/audit', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.execute<{ id: string; actor: string; actor_label: string | null; action: string; subject: string | null; details: Record<string, unknown>; at: Date }>(sql`
        select l.id, l.actor, u.email as actor_label, l.action, l.subject, l.details, l.at
          from app.audit_log l left join app.tenant_users u on 'user:' || u.user_id::text = l.actor
         order by l.at desc limit 200`),
    )
    const list: AuditEntry[] = rows.rows.map((l) => ({ id: l.id, actor: l.actor, actor_label: l.actor_label, action: l.action, subject: l.subject, details: l.details, at: new Date(l.at).toISOString() }))
    res.json(list)
  })

  r.use(suppliersRouter(deps))
  r.use(settingsRouter(deps))
  r.use(teamRouter(deps))
  r.use(llmRouter(deps))
  r.use(timelineRouter(deps))
  r.use(promptsRouter(deps))

  return r
}
