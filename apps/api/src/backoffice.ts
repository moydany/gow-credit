/**
 * API del backoffice (docs/08): lo que lee y hace un usuario del prestamista desde el navegador.
 * Misma regla que `/v1`: el tenant sale de la credencial (aquí la sesión), nunca de un parámetro,
 * y todo corre en `withTenant` con el rol `gow_api`. Cada mutación entra a la bitácora con el
 * usuario; la vista de una solicitud también (docs/08 §2, "quién vio qué").
 */
import { createHash, randomUUID } from 'node:crypto'
import { apiKeys, applicationDocuments, applications, decisions, documents, extractions, outcomes, policyVersions, supplierContacts, suppliers, tenants, tenantUsers, whatsappSessions, withTenant, type Db, type Tx } from '@gow/db'
import { applyCorrections } from '@gow/extraction/corrections'
import { ApiKeyCreateBody, ClarificationStatus, CorrectionTarget, MagicLinkBody, SupplierCreateBody, SupplierUpdateBody, TenantUserCreateBody, type ApiKeyCreated, type ApiKeyItem, type ApplicationDetail, type Correction, type MagicLinkAccepted, type SessionConfig, SessionCreateBody, type ApplicationRow, type AuditEntry, type BackofficeMe, type ClarificationItem, type PolicyVersionItem, ApplicationStatus, type SupplierDetail, type SupplierRow, type TenantSettings, TenantSettingsUpdateBody, type TenantUserCreated, type TenantUserItem, type WhatsAppLinkState, type WhatsAppUnlinkRequested } from '@gow/contracts'
import { pathBelongsTo, type DocumentStorage, type PgBoss } from '@gow/platform'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { hashSecret, newApiKey } from './admin.ts'
import { answerClarification, audit, createPolicyDraft, discardDocument, HttpError, parse, PolicyBody, recordCorrections, recordOutcome, simulateVersion, transitionVersion } from './ops.ts'
import { clearedCookies, CSRF_HEADER, issueToken, openRefresh, readCookie, REFRESH_COOKIE, refreshCookie, refreshRemaining, sealRefresh, SESSION_COOKIE, sessionCookie, verifyToken, type RefreshPayload, type SessionClaims, type SessionLimits } from './session.ts'
import type { AuthDirectory } from './supabase-auth.ts'

export interface BackofficeDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  backofficeJwtSecret: string
  secureCookies?: boolean
  /** Origen del backoffice para el enlace de acceso de un usuario invitado (`BACKOFFICE_URL`). */
  backofficeUrl?: string | null
  /**
   * Supabase Auth (ADR 0035): con él, dar de alta a un usuario crea su cuenta de Auth y se entra con
   * un enlace que llega por correo. Sin él, el enlace con el JWT de desarrollo de siempre.
   */
  auth?: AuthDirectory | null
  /**
   * Con Supabase Auth la sesión se renueva sola (ADR 0036) hasta `sessionMaxHours` desde el login
   * (`BACKOFFICE_SESSION_MAX_HOURS`, 12 por defecto) o hasta `sessionIdleHours` sin renovarse
   * (`BACKOFFICE_SESSION_IDLE_HOURS`, 8 por defecto).
   */
  sessionMaxHours?: number
  sessionIdleHours?: number
  logger?: { error(message: string): void }
}

interface Who {
  userId: string
  email: string
  tenantId: string
}

/** Nombre que se muestra de un proveedor que se registra por WhatsApp y aún no confirma sus datos (ADR 0047). */
const PENDING_SUPPLIER_NAME = 'Por confirmar (registro por WhatsApp)'

const SESSION_SECONDS = 8 * 60 * 60
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
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error')
/** Ruta del backoffice que termina el login: lee el token del fragmento y lo cambia por la cookie. */
const ENTER_PATH = '/entrar'

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

const who = (res: Response) => res.locals.who as Who
const actorOf = (w: Who) => `user:${w.userId}`
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

/** Violación de unicidad de Postgres, venga directa o envuelta por Drizzle. */
function uniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { code?: unknown }).code === '23505') return true
  }
  return false
}

/** Columnas visibles de una llave de API: el hash nunca sale de la base (ni siquiera hay privilegio para leerlo). */
const apiKeyColumns = { id: apiKeys.id, prefix: apiKeys.prefix, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt }
const apiKeyItem = (k: { id: string; prefix: string; scopes: string[]; createdAt: Date; revokedAt: Date | null }): ApiKeyItem => ({ id: k.id, prefix: k.prefix, scopes: k.scopes as ApiKeyItem['scopes'], created_at: k.createdAt.toISOString(), revoked_at: iso(k.revokedAt) })

/** Sin latido en este lapso, el proceso de WhatsApp se da por detenido (late cada ~10 s). */
const WHATSAPP_STALE_SECONDS = 30

/**
 * Estado de la sesión de WhatsApp del tenant. Vigencia del latido y del QR con el reloj de la base,
 * el mismo con el que escribe el proceso: sin desfase entre máquinas.
 */
async function whatsappSession(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({
      status: whatsappSessions.status,
      linkedNumber: whatsappSessions.linkedNumber,
      qr: whatsappSessions.qr,
      qrExpiresAt: whatsappSessions.qrExpiresAt,
      updatedAt: whatsappSessions.updatedAt,
      running: sql<boolean>`coalesce(${whatsappSessions.heartbeatAt} > now() - make_interval(secs => ${WHATSAPP_STALE_SECONDS}), false)`,
      qrFresh: sql<boolean>`coalesce(${whatsappSessions.qrExpiresAt} > now(), false)`,
      unlinkPending: sql<boolean>`coalesce(${whatsappSessions.unlinkRequestedAt} > coalesce(${whatsappSessions.unlinkHandledAt}, '-infinity'::timestamptz), false)`,
    })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.tenantId, tenantId))
  return row ?? null
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
  const backofficeBase = (deps.backofficeUrl ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
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
    return new HttpError(401, 'sesión requerida')
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
    auth.sendMagicLink(email, `${backofficeBase}${ENTER_PATH}`).catch((e: unknown) => {
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
    if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
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

  r.get('/session/config', (_req, res) => {
    const out: SessionConfig = { magic_link: Boolean(deps.auth) }
    res.json(out)
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
    if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
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
    if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
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
      if (!w) throw new HttpError(401, 'sesión requerida')
      res.locals.who = w
      next()
      return
    }
    // Con cookie, toda escritura debe traer el encabezado: un formulario de otro sitio no puede. Se
    // revisa antes de renovar nada.
    const header = req.header('cookie')
    const withCookies = Boolean(readCookie(header, SESSION_COOKIE) ?? readCookie(header, REFRESH_COOKIE))
    if (withCookies && !['GET', 'HEAD'].includes(req.method) && req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
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
      if (!s) throw new HttpError(404, 'proveedor no encontrado')
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

  // ---------- Proveedores: lista, alta, detalle y edición (docs/08 §2)
  r.get('/suppliers', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.execute<{ id: string; legal_name: string; rfc: string | null; external_ref: string | null; created_at: Date; applications: number; last_id: string | null; last_status: ApplicationRow['status'] | null; last_at: Date | null }>(sql`
        select s.id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name, s.rfc, s.external_ref, s.created_at,
               (select count(*)::int from app.applications a where a.supplier_id = s.id) as applications,
               l.id as last_id, l.status as last_status, l.created_at as last_at
          from app.suppliers s
          left join lateral (select a.id, a.status, a.created_at from app.applications a where a.supplier_id = s.id order by a.created_at desc limit 1) l on true
         order by coalesce(l.created_at, s.created_at) desc
         limit 500`),
    )
    const list: SupplierRow[] = rows.rows.map((x) => ({
      id: x.id,
      legal_name: x.legal_name,
      rfc: x.rfc,
      external_ref: x.external_ref,
      applications: x.applications,
      last_application: x.last_id && x.last_status && x.last_at ? { id: x.last_id, status: x.last_status, created_at: new Date(x.last_at).toISOString() } : null,
      created_at: new Date(x.created_at).toISOString(),
    }))
    res.json(list)
  })

  /** Alta sin contactos: un vínculo verificado entra por la API de integración (KYC del tenant, docs/05 §2b). */
  r.post('/suppliers', async (req, res) => {
    const w = who(res)
    const body = parse(SupplierCreateBody, req.body)
    try {
      const id = await withTenant(deps.db, w.tenantId, async (tx) => {
        const [s] = await tx.insert(suppliers).values({ tenantId: w.tenantId, legalName: body.legal_name, rfc: body.rfc, externalRef: body.external_ref, clabes: body.clabes }).returning({ id: suppliers.id })
        if (!s) throw new HttpError(500, 'no se creó el proveedor')
        await audit(tx, w.tenantId, actorOf(w), 'supplier.created', s.id, { contacts: 0 })
        return s.id
      })
      res.status(201).json({ id })
    } catch (e) {
      if (uniqueViolation(e)) throw new HttpError(409, 'ya existe un proveedor con esa referencia externa', [{ path: 'external_ref', message: 'referencia repetida' }])
      throw e
    }
  })

  r.get('/suppliers/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, id))
      if (!s) throw new HttpError(404, 'proveedor no encontrado')
      const contacts = await tx.select().from(supplierContacts).where(eq(supplierContacts.supplierId, id)).orderBy(supplierContacts.createdAt)
      const apps = await tx.execute<{ id: string; status: ApplicationRow['status']; request: ApplicationRow['request']; created_at: Date; decision_status: NonNullable<ApplicationRow['decision']>['status'] | null; limit_amount: string | null; score: string | null; outcomes: { outcome: 'paid' | 'late' | 'default' | 'fraud'; observed_at: string }[] }>(sql`
        select a.id, a.status, a.request, a.created_at, d.status as decision_status, d.limit_amount, d.score,
               coalesce((select jsonb_agg(jsonb_build_object('outcome', o.outcome, 'observed_at', o.observed_at) order by o.observed_at desc) from app.outcomes o where o.application_id = a.id), '[]'::jsonb) as outcomes
          from app.applications a
          left join lateral (select dd.status, dd.limit_amount, dd.score from app.decisions dd where dd.application_id = a.id and dd.kind = 'active' order by dd.created_at desc limit 1) d on true
         where a.supplier_id = ${id}::uuid
         order by a.created_at desc`)
      // Ver un proveedor es ver su RFC y sus CLABEs: queda en la bitácora como ver una solicitud.
      await audit(tx, w.tenantId, actorOf(w), 'supplier.viewed', id)
      return { s, contacts, apps: apps.rows }
    })
    const detail: SupplierDetail = {
      id: out.s.id,
      legal_name: out.s.legalName ?? PENDING_SUPPLIER_NAME,
      rfc: out.s.rfc,
      external_ref: out.s.externalRef,
      clabes: out.s.clabes,
      created_at: out.s.createdAt.toISOString(),
      contacts: out.contacts.map((c) => ({ id: c.id, channel: c.channel, address: c.address, verified_at: iso(c.verifiedAt), verification_method: c.verificationMethod, created_at: c.createdAt.toISOString() })),
      applications: out.apps.map((a) => ({
        id: a.id,
        status: a.status,
        request: a.request,
        decision: a.decision_status ? { status: a.decision_status, limit: a.limit_amount === null ? null : Number(a.limit_amount), score: a.score === null ? null : Number(a.score) } : null,
        outcomes: a.outcomes.map((o) => ({ outcome: o.outcome, observed_at: new Date(o.observed_at).toISOString() })),
        created_at: new Date(a.created_at).toISOString(),
      })),
    }
    res.json(detail)
  })

  /** Edición de razón social, RFC y CLABEs; la bitácora lleva solo los nombres de los campos, nunca los valores. */
  r.patch('/suppliers/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const body = parse(SupplierUpdateBody, req.body)
    const set = { ...(body.legal_name === undefined ? {} : { legalName: body.legal_name }), ...(body.rfc === undefined ? {} : { rfc: body.rfc }), ...(body.clabes === undefined ? {} : { clabes: body.clabes }) }
    const fields = (['legal_name', 'rfc', 'clabes'] as const).filter((f) => body[f] !== undefined)
    await withTenant(deps.db, w.tenantId, async (tx) => {
      const [s] = await tx.update(suppliers).set(set).where(eq(suppliers.id, id)).returning({ id: suppliers.id })
      if (!s) throw new HttpError(404, 'proveedor no encontrado')
      await audit(tx, w.tenantId, actorOf(w), 'supplier.updated', id, { fields })
    })
    res.json({ id, fields })
  })

  // ---------- Configuración: canales del tenant (solo lectura) y ajustes del análisis
  const settingsOf = (t: typeof tenants.$inferSelect): TenantSettings => ({
    tenant: { id: t.id, name: t.name, created_at: t.createdAt.toISOString() },
    whatsapp: { number: t.whatsappNumber },
    email: { from: t.emailFrom },
    analysis: { statement_max_age_months: t.statementMaxAgeMonths },
  })
  r.get('/settings', async (_req, res) => {
    const w = who(res)
    const [t] = await withTenant(deps.db, w.tenantId, (tx) => tx.select().from(tenants).where(eq(tenants.id, w.tenantId)))
    if (!t) throw new HttpError(404, 'tenant no encontrado')
    res.json(settingsOf(t))
  })

  /**
   * Antigüedad máxima del estado de cuenta (ADR 0049). Aplica a las solicitudes que se analicen desde
   * ahora y a las reevaluaciones; una solicitud ya en curso conserva el ajuste con que empezó.
   */
  r.patch('/settings', async (req, res) => {
    const w = who(res)
    const body = parse(TenantSettingsUpdateBody, req.body)
    const t = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [before] = await tx.select({ months: tenants.statementMaxAgeMonths }).from(tenants).where(eq(tenants.id, w.tenantId))
      if (!before) throw new HttpError(404, 'tenant no encontrado')
      await tx.update(tenants).set({ statementMaxAgeMonths: body.statement_max_age_months }).where(eq(tenants.id, w.tenantId))
      await audit(tx, w.tenantId, actorOf(w), 'settings.updated', w.tenantId, { statement_max_age_months: { from: before.months, to: body.statement_max_age_months } })
      const [after] = await tx.select().from(tenants).where(eq(tenants.id, w.tenantId))
      return after
    })
    if (!t) throw new HttpError(404, 'tenant no encontrado')
    res.json(settingsOf(t))
  })

  // ---------- Configuración: vincular WhatsApp escaneando el QR (ADR 0033)
  /**
   * El QR solo sale con el proceso vivo, en `waiting_qr` y sin caducar. Quien lo escanee vincula su
   * cuenta al bot del tenant: verlo queda en la bitácora una vez por valor del QR y usuario (el
   * navegador lo consulta cada 2 s), con una huella truncada del valor y nunca el valor.
   */
  r.get('/whatsapp', async (_req, res) => {
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const s = await whatsappSession(tx, w.tenantId)
      const qr = s?.running && s.status === 'waiting_qr' && s.qrFresh ? s.qr : null
      if (s && qr) {
        const digest = createHash('sha256').update(qr).digest('hex').slice(0, 16)
        const seen = await tx.execute(sql`
          select 1 from app.audit_log
           where action = 'whatsapp.qr_viewed' and actor = ${actorOf(w)} and details->>'qr_digest' = ${digest} and at > now() - interval '15 minutes'
           limit 1`)
        if (!seen.rows.length) await audit(tx, w.tenantId, actorOf(w), 'whatsapp.qr_viewed', null, { qr_digest: digest })
      }
      return { s, qr }
    })
    const s = out.s
    const state: WhatsAppLinkState = {
      process_running: s?.running ?? false,
      status: s?.status ?? null,
      linked_number: s?.linkedNumber ?? null,
      qr: out.qr,
      qr_expires_at: out.qr ? iso(s?.qrExpiresAt ?? null) : null,
      unlink_pending: s?.unlinkPending ?? false,
      updated_at: iso(s?.updatedAt ?? null),
    }
    res.json(state)
  })

  /**
   * Desvincular (o pedir un QR nuevo tras cerrar la sesión desde el teléfono): el proceso lo atiende
   * en segundos, cierra la sesión en WhatsApp y publica un QR nuevo. Sin proceso vivo no hay quién
   * lo atienda: 409.
   */
  r.post('/whatsapp/unlink', async (_req, res) => {
    const w = who(res)
    const at = await withTenant(deps.db, w.tenantId, async (tx) => {
      const s = await whatsappSession(tx, w.tenantId)
      if (!s?.running) throw new HttpError(409, 'el proceso de WhatsApp no está corriendo')
      const [row] = await tx.update(whatsappSessions).set({ unlinkRequestedAt: sql`now()` }).where(eq(whatsappSessions.tenantId, w.tenantId)).returning({ at: whatsappSessions.unlinkRequestedAt })
      if (!row?.at) throw new HttpError(409, 'el proceso de WhatsApp no está corriendo')
      await audit(tx, w.tenantId, actorOf(w), 'whatsapp.unlink_requested', null, { status: s.status })
      return row.at
    })
    const out: WhatsAppUnlinkRequested = { unlink_requested_at: at.toISOString() }
    res.status(202).json(out)
  })

  // ---------- Configuración: usuarios del backoffice
  r.get('/users', async (_req, res) => {
    const w = who(res)
    const rows = await withTenant(deps.db, w.tenantId, (tx) =>
      tx.execute<{ user_id: string; email: string; created_at: Date; invited_by: string | null }>(sql`
        select u.user_id, u.email, u.created_at, i.email as invited_by
          from app.tenant_users u left join app.tenant_users i on i.user_id = u.invited_by
         order by u.created_at`),
    )
    const list: TenantUserItem[] = rows.rows.map((u) => ({ id: u.user_id, email: u.email, created_at: new Date(u.created_at).toISOString(), invited_by: u.invited_by, is_me: u.user_id === w.userId }))
    res.json(list)
  })

  /**
   * Invitar: da de alta la pertenencia. Sin Supabase Auth devuelve, una sola vez, el enlace de acceso
   * con el mismo JWT que emite `pnpm tenant user add`. Con Supabase Auth (ADR 0035) crea o encuentra
   * la cuenta de Auth, guarda su id como `user_id` y le manda el enlace por correo; no hay enlace que
   * compartir. Un usuario que ya existe no recibe enlace nuevo por aquí: sería entrar a nombre de otro.
   */
  r.post('/users', async (req, res) => {
    const w = who(res)
    const body = parse(TenantUserCreateBody, req.body)
    const conflict = new HttpError(409, 'ese correo ya tiene acceso al backoffice', [{ path: 'email', message: 'correo ya registrado' }])
    const memberOfThisTenant = async (tx: Tx) => (await tx.select({ id: tenantUsers.userId }).from(tenantUsers).where(eq(tenantUsers.email, body.email))).length > 0
    let userId: string = randomUUID()
    if (deps.auth) {
      // Antes de tocar Auth, para no crear cuentas por un conflicto que ya se ve aquí.
      if (await withTenant(deps.db, w.tenantId, memberOfThisTenant)) throw conflict
      try {
        userId = await deps.auth.ensureUser(body.email)
      } catch (e) {
        deps.logger?.error(`backoffice: no se creó la cuenta de Auth (${e instanceof Error ? e.message : 'error'})`)
        throw new HttpError(502, 'no se pudo crear la cuenta de acceso; intenta de nuevo')
      }
    }
    let row: { userId: string; email: string; createdAt: Date }
    try {
      row = await withTenant(deps.db, w.tenantId, async (tx) => {
        if (await memberOfThisTenant(tx)) throw conflict
        const [u] = await tx.insert(tenantUsers).values({ tenantId: w.tenantId, userId, email: body.email, invitedBy: w.userId }).returning()
        if (!u) throw new HttpError(500, 'no se agregó el usuario')
        await audit(tx, w.tenantId, actorOf(w), 'user.added', u.userId)
        return u
      })
    } catch (e) {
      // El correo es único entre tenants: si es de otro, RLS no deja verlo y la unicidad lo detiene.
      // Con Supabase la cuenta de Auth ya existe y se queda sin pertenencia: sin tenant_id no entra.
      if (uniqueViolation(e)) throw conflict
      throw e
    }
    const user = { id: row.userId, email: row.email, created_at: row.createdAt.toISOString(), invited_by: w.email, is_me: false }
    if (deps.auth) {
      const sent = await deps.auth.sendMagicLink(row.email, `${backofficeBase}${ENTER_PATH}`).catch((e: unknown) => {
        deps.logger?.error(`backoffice: no se mandó el enlace al invitado (${e instanceof Error ? e.message : 'error'})`)
        return false
      })
      const out: TenantUserCreated = { user, access_link: null, expires_at: null, email_sent: sent }
      return void res.status(201).json(out)
    }
    const token = issueToken(deps.backofficeJwtSecret, { sub: row.userId, email: row.email, tenant_id: w.tenantId }, SESSION_SECONDS)
    const out: TenantUserCreated = {
      user,
      access_link: `${backofficeBase}${ENTER_PATH}#token=${token}`,
      expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
      email_sent: false,
    }
    res.status(201).json(out)
  })

  /**
   * Quitar a un usuario corta su sesión en la siguiente petición (la pertenencia se lee siempre). Con
   * Supabase Auth solo se quita la pertenencia: la cuenta de Auth se queda (sin tenant_id no entra) y
   * su id sigue explicando la bitácora.
   */
  r.delete('/users/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    if (id === w.userId) throw new HttpError(409, 'no puedes quitarte a ti mismo')
    await withTenant(deps.db, w.tenantId, async (tx) => {
      const [u] = await tx.delete(tenantUsers).where(eq(tenantUsers.userId, id)).returning({ id: tenantUsers.userId })
      if (!u) throw new HttpError(404, 'usuario no encontrado')
      await audit(tx, w.tenantId, actorOf(w), 'user.removed', id)
    })
    res.status(204).end()
  })

  // ---------- Configuración: llaves de API (la completa se muestra una vez; se guarda el hash)
  r.get('/api-keys', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) => tx.select(apiKeyColumns).from(apiKeys).orderBy(desc(apiKeys.createdAt)))
    res.json(rows.map(apiKeyItem))
  })

  r.post('/api-keys', async (req, res) => {
    const w = who(res)
    const body = parse(ApiKeyCreateBody, req.body)
    const key = newApiKey()
    const row = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [k] = await tx.insert(apiKeys).values({ tenantId: w.tenantId, prefix: key.prefix, keyHash: hashSecret(key.secret), scopes: body.scopes }).returning(apiKeyColumns)
      if (!k) throw new HttpError(500, 'no se creó la llave')
      await audit(tx, w.tenantId, actorOf(w), 'api_key.created', k.id, { prefix: k.prefix, scopes: k.scopes })
      return k
    })
    const out: ApiKeyCreated = { key: apiKeyItem(row), secret_key: key.key }
    res.status(201).json(out)
  })

  /** Revocar es inmediato: `resolve_api_key` ignora las revocadas. La fila se conserva para la bitácora. */
  r.post('/api-keys/:id/revoke', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const row = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [k] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning(apiKeyColumns)
      if (!k) {
        const [exists] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id))
        throw exists ? new HttpError(409, 'la llave ya está revocada') : new HttpError(404, 'llave no encontrada')
      }
      await audit(tx, w.tenantId, actorOf(w), 'api_key.revoked', k.id, { prefix: k.prefix })
      return k
    })
    res.json(apiKeyItem(row))
  })

  return r
}
