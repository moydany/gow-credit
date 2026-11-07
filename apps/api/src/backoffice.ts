/**
 * Backoffice API: what a lender's user reads and does from the browser. Same rule as `/v1`: the
 * tenant comes from the credential (here the session), never from a parameter, and everything runs
 * in `withTenant` with the `gow_api` role. Every mutation is audit-logged with the user, and so is
 * viewing a request ("who saw what").
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { applicationDocuments, applications, decisions, documents, extractions, outcomes, policyVersions, suppliers, tenants, tenantUsers, withTenant, type Db } from '@gow/db'
import { applyCorrections } from '@gow/extraction/corrections'
import { ClarificationStatus, CorrectionTarget, EmailLinkBody, MagicLinkBody, type ApplicationDetail, type Correction, type MagicLinkAccepted, type SessionConfig, SessionCreateBody, SetupBody, type ApplicationRow, type AuditEntry, type BackofficeMe, type ClarificationItem, type PolicyVersionItem, ApplicationStatus } from '@gow/contracts'
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
import { jobsRouter } from './bo/jobs.ts'
import { statementsRouter } from './bo/statements.ts'
import { suppliersRouter } from './bo/suppliers.ts'
import { teamRouter } from './bo/team.ts'
import { timelineRouter } from './bo/timeline.ts'
import type { AuthDirectory } from './supabase-auth.ts'

export type { BackofficeDeps }

/**
 * With less life than this left, the access token is renewed on the next request: 5 min, or half
 * its life if shorter (a 2 min `JWT_EXPIRY` must not renew on every request).
 */
const REFRESH_BEFORE_SECONDS = 5 * 60
const refreshBefore = (c: SessionClaims) => (c.iat === undefined ? REFRESH_BEFORE_SECONDS : Math.min(REFRESH_BEFORE_SECONDS, Math.floor((c.exp - c.iat) / 2)))
/**
 * A renewal is shared with requests carrying the same refresh token within this window (the ones
 * the browser sent in parallel before receiving the new cookies).
 */
const REFRESH_SHARE_MS = 30_000
const nowSeconds = () => Math.floor(Date.now() / 1000)
const SESSION_REQUIRED = 'sesión requerida'
const SET_COOKIE = 'Set-Cookie'
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error')
/** Constant-time comparison of the first-run password (hashes first, so lengths don't leak). */
function samePassword(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** A cookie-authenticated write must carry the header: a form on another site cannot set it. */
function assertCsrf(req: Request): void {
  if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
}

/**
 * Fixed per-key window in memory (one API process). Self-pruning as it grows, so an attacker
 * rotating keys cannot make it grow without bound.
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
    // Tenant data: never in shared caches.
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  const attempts = new Map<string, { start: number; count: number }>()
  const secure = deps.secureCookies === true
  const backofficeOrigin = backofficeBase(deps)
  // Link requests: 429 per IP; per email they are dropped silently (the response is the same).
  const magicLinkPerIp = windowLimiter(5, 60_000)
  const magicLinkPerEmail = windowLimiter(4, 15 * 60_000)
  // First-run password: a few tries per IP so it can't be guessed by brute force.
  const setupPerIp = windowLimiter(10, 60_000)

  const limits: SessionLimits = { maxSeconds: (deps.sessionMaxHours ?? 12) * 3600, idleSeconds: (deps.sessionIdleHours ?? 8) * 3600 }

  /** Current membership for already-verified claims, or null if no longer a member. */
  async function memberOf(claims: SessionClaims): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
    const [m] = await withTenant(deps.db, claims.tenant_id, (tx) => tx.select().from(tenantUsers).where(and(eq(tenantUsers.tenantId, claims.tenant_id), eq(tenantUsers.userId, claims.sub))))
    return m ? { userId: m.userId, email: m.email, tenantId: m.tenantId, exp: claims.exp, supabaseSession: claims.session_id !== undefined } : null
  }

  async function membership(token: string): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
    const claims = verifyToken(deps.backofficeJwtSecret, token)
    return claims ? memberOf(claims) : null
  }

  /** Closes the GoTrue session for an access token; on failure only the code is logged. */
  async function revokeQuietly(auth: AuthDirectory, accessToken: string, what: string): Promise<void> {
    await auth.revokeSession(accessToken).catch((e: unknown) => {
      deps.logger?.error(`backoffice: no se cerró la sesión de Auth ${what} (${errorText(e)})`)
    })
  }

  /**
   * Renewals in flight or just done, keyed by refresh token hash (never the token itself).
   * Parallel requests with the same cookie make one GoTrue call and get the same new tokens.
   * Across instances, GoTrue's reuse interval covers it.
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
    // A transient error is not shared beyond those already waiting: the next request retries.
    result.catch(() => {
      if (refreshes.get(key)?.result === result) refreshes.delete(key)
    })
    return result
  }

  /** Cookies for a renewed session: the access token and the new, encrypted refresh token. */
  function renewedCookies(accessToken: string, exp: number, payload: RefreshPayload): string[] {
    const now = nowSeconds()
    const left = refreshRemaining(payload, limits, now)
    return [sessionCookie(accessToken, { maxAgeSeconds: Math.min(SESSION_SECONDS, exp - now, left), secure }), refreshCookie(sealRefresh(deps.backofficeJwtSecret, payload), { maxAgeSeconds: left, secure })]
  }

  function unauthorized(res: Response, clear: boolean): HttpError {
    if (clear) res.setHeader(SET_COOKIE, clearedCookies(secure))
    return new HttpError(401, SESSION_REQUIRED)
  }

  /**
   * Cookie session. With a valid access token from a member it passes; if under 5 min remain and
   * there is a refresh cookie, it renews first. Without a valid access token it renews with the
   * refresh cookie or answers 401 and clears the cookies. While the current access token still
   * works, a failed renewal does not log anyone out.
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
        // User removed: out, and their GoTrue session is closed with the token they sent.
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
      // GoTrue rejected the refresh token. If the current access token works, carry on with it:
      // a parallel request may already have rotated the refresh token, and its cookies are the good ones.
      if (current) return current
      throw unauthorized(res, true)
    }
    const next = verifyToken(deps.backofficeJwtSecret, fresh.accessToken)
    const renewed = next && next.sub === rc.sub ? await memberOf(next) : null
    if (!next || !renewed) {
      // No `tenant_id` (the hook no longer sets it) or no membership: out, and the GoTrue session is closed.
      await revokeQuietly(auth, fresh.accessToken, 'de un usuario sin pertenencia')
      throw unauthorized(res, true)
    }
    res.setHeader(SET_COOKIE, renewedCookies(fresh.accessToken, next.exp, { ...rc, rt: fresh.refreshToken, rat: now }))
    return renewed
  }

  /** Sends the access link email outside the request, so response time does not reveal whether the account exists. */
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

  // ---------- Session: the access link carries the JWT; the API swaps it for an HttpOnly cookie
  /** Sign-in attempts per IP: 20 a minute. */
  function countAttempt(req: Request): void {
    const key = req.ip ?? 'local'
    const now = Date.now()
    const w0 = attempts.get(key)
    if (!w0 || now - w0.start > 60_000) attempts.set(key, { start: now, count: 1 })
    else if (++w0.count > 20) throw new HttpError(429, 'demasiados intentos')
  }

  /** Opens the session with an access token (and, with Supabase Auth, its refresh token). */
  async function openSession(res: Response, token: string, refreshToken: string | undefined): Promise<void> {
    const w = await membership(token)
    if (!w) throw new HttpError(401, 'el enlace de acceso no es válido o ya venció')
    const at = nowSeconds()
    if (deps.auth && w.supabaseSession && refreshToken) {
      // Supabase Auth: the refresh token stays on the API side, encrypted in an HttpOnly cookie,
      // and the session renews itself up to its limits.
      res.setHeader(SET_COOKIE, renewedCookies(token, w.exp, { v: 1, rt: refreshToken, sub: w.userId, iat: at, rat: at }))
    } else {
      // Dev link: the cookie lives as long as the token (8 h at most).
      res.setHeader(SET_COOKIE, sessionCookie(token, { maxAgeSeconds: Math.min(SESSION_SECONDS, w.exp - at), secure }))
      // A Supabase token without its refresh token: nobody will use that refresh token, which
      // travelled in the URL. Its Auth session is closed; the access token stays valid until `exp`.
      if (deps.auth && w.supabaseSession) await revokeQuietly(deps.auth, token, 'sin refresh token')
    }
    res.json(await meOf(w))
  }

  r.post('/session', async (req, res) => {
    countAttempt(req)
    assertCsrf(req)
    const body = parse(SessionCreateBody, req.body)
    await openSession(res, body.token, body.refresh_token)
  })

  /**
   * The emailed link brings a one-time code (`#token_hash=`), exchanged here only when the person
   * presses "Entrar": opening the link spends nothing, so mail scanners and reloads don't burn it.
   */
  r.post('/session/email-link', async (req, res) => {
    const auth = deps.auth
    if (!auth?.verifyEmailLink) throw new HttpError(404, 'no encontrado')
    countAttempt(req)
    assertCsrf(req)
    const body = parse(EmailLinkBody, req.body)
    let tokens: { accessToken: string; refreshToken: string } | null
    try {
      tokens = await auth.verifyEmailLink(body.token_hash)
    } catch (e) {
      deps.logger?.error(`backoffice: no se verificó el enlace de acceso (${errorText(e)})`)
      throw new HttpError(502, 'no se pudo verificar el enlace; intenta de nuevo')
    }
    if (!tokens) throw new HttpError(401, 'ese enlace ya se usó o venció; pide otro')
    await openSession(res, tokens.accessToken, tokens.refreshToken)
  })

  /** Whether no tenant exists yet (`app.setup_pending`). Answers only a boolean. */
  async function setupPending(): Promise<boolean> {
    const found = await deps.db.execute<{ pending: boolean }>(sql`select app.setup_pending() as pending`)
    return found.rows[0]?.pending === true
  }

  r.get('/session/config', async (_req, res) => {
    const out: SessionConfig = { magic_link: Boolean(deps.auth), setup_required: await setupPending(), setup_password: Boolean(deps.setupPassword) }
    res.json(out)
  })

  /**
   * First run: creates the tenant, its active base policy and its admin, and opens the session
   * with the same cookie as the dev link. Works only while no tenant exists (the database function
   * decides, with a lock); afterwards it answers 409. With `SETUP_PASSWORD` (a shared demo) it
   * also asks for that password, limited per IP; without it, whoever reaches the page first wins.
   */
  r.post('/setup', async (req, res) => {
    assertCsrf(req)
    if (deps.setupPassword && !setupPerIp(req.ip ?? 'local')) throw new HttpError(429, 'demasiados intentos; espera un minuto')
    const body = parse(SetupBody, req.body)
    const taken = new HttpError(409, 'el sistema ya tiene una institución crediticia configurada')
    if (!(await setupPending())) throw taken
    if (deps.setupPassword && !samePassword(body.password ?? '', deps.setupPassword)) throw new HttpError(403, 'contraseña incorrecta', [{ path: 'password', message: 'Contraseña incorrecta' }])
    let userId: string = randomUUID()
    if (deps.auth) {
      // The Auth account is created first, so the email already works with the email link afterwards.
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
    res.setHeader(SET_COOKIE, sessionCookie(token, { maxAgeSeconds: SESSION_SECONDS, secure }))
    res.status(201).json(await meOf({ userId, email: body.email, tenantId }))
  })

  /**
   * Request the access link by email (Supabase Auth). Always 202 with the same body whether or not
   * the account exists, so it does not reveal who has access. GoTrue does not create accounts here
   * (`create_user: false`). The email never goes to the logs.
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
   * Sign out: clears both cookies and, with Supabase Auth, closes the GoTrue session (its refresh
   * token stops working). If the access token already expired, it renews once just to close it.
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
    res.setHeader(SET_COOKIE, clearedCookies(secure))
    res.status(204).end()
  })

  // ---------- Everything else requires a valid session and tenant membership
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1]
    if (bearer) {
      // With Bearer there are no cookies or renewal: the token is good for what its `exp` says.
      const w = await membership(bearer)
      if (!w) throw new HttpError(401, SESSION_REQUIRED)
      res.locals.who = w
      next()
      return
    }
    // With a cookie, every write must carry the header: a form on another site cannot. Checked
    // before renewing anything.
    const header = req.header('cookie')
    const withCookies = Boolean(readCookie(header, SESSION_COOKIE) ?? readCookie(header, REFRESH_COOKIE))
    if (withCookies && !['GET', 'HEAD'].includes(req.method)) assertCsrf(req)
    res.locals.who = await cookieSession(req, res)
    next()
  })

  r.get('/me', async (_req, res) => {
    res.json(await meOf(who(res)))
  })

  // ---------- Request inbox
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

  // ---------- Detail: document, extraction, decision, clarifications
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
      // The stored extraction is immutable: shown with the analyst's corrections on top.
      extraction: (out.ex ? applyCorrections(out.ex.payload as NonNullable<ApplicationDetail['extraction']>, fixes) : null),
      decision: out.dec ? { id: out.dec.id, policy_version: version(out.dec.policyVersionId), created_at: out.dec.createdAt.toISOString(), payload: out.dec.payload as NonNullable<ApplicationDetail['decision']>['payload'] } : null,
      shadow: out.shadow ? { policy_version: version(out.shadow.policyVersionId), status: out.shadow.status, limit: out.shadow.limitAmount === null ? null : Number(out.shadow.limitAmount), score: out.shadow.score === null ? null : Number(out.shadow.score) } : null,
      clarifications: out.clar,
      outcomes: out.outs.map((o) => ({ outcome: o.outcome, observed_at: o.observedAt.toISOString() })),
      corrections: fixes,
    }
    res.json(detail)
  })

  /** The PDF, from our own storage and only if it belongs to this tenant (RLS + path prefix). */
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

  /** Value corrections in human review: stores the read/correct pairs and re-enqueues to decide. */
  r.post('/applications/:id/corrections', async (req, res) => {
    const w = who(res)
    res.status(202).json(await recordCorrections(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  /** Discard the document in human review: closes the request without re-evaluating. */
  r.post('/applications/:id/discard', async (req, res) => {
    const w = who(res)
    res.json(await discardDocument(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Clarifications with a manual answer
  r.get('/clarifications', async (req, res) => {
    const status = typeof req.query.status === 'string' ? ClarificationStatus.safeParse(req.query.status) : null
    const items = await withTenant(deps.db, who(res).tenantId, (tx) => clarificationItems(tx, status?.success ? sql`c.status = ${status.data}::app.clarification_status` : sql`true`))
    res.json(items)
  })

  /** Answer on the supplier's behalf: goes through the same operation as the API, with the user in the audit log. */
  r.post('/clarifications/:id/answers', async (req, res) => {
    const w = who(res)
    res.json(await answerClarification(deps, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Policies
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

  // ---------- Outcomes and audit log
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
  r.use(statementsRouter(deps))
  r.use(settingsRouter(deps))
  r.use(teamRouter(deps))
  r.use(llmRouter(deps))
  r.use(jobsRouter(deps))
  r.use(timelineRouter(deps))
  r.use(promptsRouter(deps))

  return r
}
