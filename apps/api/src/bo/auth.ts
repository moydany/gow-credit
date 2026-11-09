import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  EmailLinkBody,
  MagicLinkBody,
  SessionCreateBody,
  SetupBody,
  type BackofficeMe,
  type MagicLinkAccepted,
  type SessionConfig,
} from '@gow/contracts'
import { tenantUsers, tenants, withTenant } from '@gow/db'
import { basePolicyTemplate } from '@gow/decision'
import { and, eq, sql } from 'drizzle-orm'
import express, { type NextFunction, type Request, type Response } from 'express'
import { HttpError, parse } from '../ops.ts'
import { createWindowLimiter } from '../rate-limit.ts'
import {
  CSRF_HEADER,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  clearedCookies,
  issueToken,
  openRefresh,
  readCookie,
  refreshCookie,
  refreshRemaining,
  sealRefresh,
  sessionCookie,
  verifyToken,
  type RefreshPayload,
  type SessionClaims,
  type SessionLimits,
} from '../session.ts'
import type { AuthDirectory } from '../supabase-auth.ts'
import {
  ENTER_PATH,
  SESSION_SECONDS,
  whatsappSession,
  type BackofficeDeps,
  type Who,
} from './shared.ts'

export type { SessionLimits }

const nowSeconds = () => Math.floor(Date.now() / 1000)

const SET_COOKIE = 'Set-Cookie'
const SESSION_REQUIRED = 'sesión requerida'
const REFRESH_SHARE_MS = 30_000
const REFRESH_BEFORE_SECONDS = 5 * 60

const refreshBefore = (c: SessionClaims) =>
  c.iat === undefined ? REFRESH_BEFORE_SECONDS : Math.min(REFRESH_BEFORE_SECONDS, Math.floor((c.exp - c.iat) / 2))

function assertCsrf(req: Request): void {
  if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
}

function samePassword(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'error'
}

function backofficeBase(deps: BackofficeDeps): string {
  return (deps.backofficeUrl ?? 'http://localhost:3000').replace(/\/+$/, '')
}

export async function memberOf(
  deps: BackofficeDeps,
  claims: SessionClaims,
): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
  const [m] = await withTenant(deps.db, claims.tenant_id, (tx) =>
    tx
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, claims.tenant_id), eq(tenantUsers.userId, claims.sub))),
  )
  return m
    ? {
        userId: m.userId,
        email: m.email,
        tenantId: m.tenantId,
        exp: claims.exp,
        supabaseSession: claims.session_id !== undefined,
      }
    : null
}

export async function membership(
  deps: BackofficeDeps,
  token: string,
): Promise<(Who & { exp: number; supabaseSession: boolean }) | null> {
  const claims = verifyToken(deps.backofficeJwtSecret, token)
  return claims ? memberOf(deps, claims) : null
}

async function revokeQuietly(
  deps: BackofficeDeps,
  auth: AuthDirectory,
  accessToken: string,
  what: string,
): Promise<void> {
  await auth.revokeSession(accessToken).catch((e: unknown) => {
    deps.logger?.error(`backoffice: no se cerró la sesión de Auth ${what} (${errorText(e)})`)
  })
}

const refreshes = new Map<string, { at: number; result: Promise<{ accessToken: string; refreshToken: string } | null> }>()

export function refreshOnce(
  auth: AuthDirectory,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const key = createHash('sha256').update(refreshToken).digest('base64url')
  const now = Date.now()
  if (refreshes.size > 1_000) {
    for (const [k, v] of refreshes) {
      if (now - v.at > REFRESH_SHARE_MS) refreshes.delete(k)
    }
  }
  const hit = refreshes.get(key)
  if (hit && now - hit.at <= REFRESH_SHARE_MS) return hit.result
  const result = auth.refreshSession(refreshToken)
  refreshes.set(key, { at: now, result })
  result.catch(() => {
    if (refreshes.get(key)?.result === result) refreshes.delete(key)
  })
  return result
}

function renewedCookies(
  secret: string,
  accessToken: string,
  exp: number,
  payload: RefreshPayload,
  limits: SessionLimits,
  secure: boolean,
): string[] {
  const now = nowSeconds()
  const left = refreshRemaining(payload, limits, now)
  return [
    sessionCookie(accessToken, { maxAgeSeconds: Math.min(SESSION_SECONDS, exp - now, left), secure }),
    refreshCookie(sealRefresh(secret, payload), { maxAgeSeconds: left, secure }),
  ]
}

function unauthorized(res: Response, clear: boolean, secure: boolean): HttpError {
  if (clear) res.setHeader(SET_COOKIE, clearedCookies(secure))
  return new HttpError(401, SESSION_REQUIRED)
}

export async function validateActiveAccessToken(
  token: string | null,
  deps: BackofficeDeps,
  now: number,
  res: Response,
): Promise<{ current: Who | null; claims: SessionClaims | null }> {
  if (!token) return { current: null, claims: null }
  const claims = verifyToken(deps.backofficeJwtSecret, token, now)
  if (!claims) return { current: null, claims: null }
  const current = await memberOf(deps, claims)
  if (!current) {
    if (deps.auth && claims.session_id !== undefined) {
      await revokeQuietly(deps, deps.auth, token, 'de un usuario sin pertenencia')
    }
    throw unauthorized(res, true, deps.secureCookies === true)
  }
  return { current, claims }
}

export async function renewFromRefreshCookie(
  rc: RefreshPayload | null,
  current: Who | null,
  deps: BackofficeDeps,
  limits: SessionLimits,
  now: number,
  res: Response,
  hadCookies: boolean,
): Promise<Who> {
  const auth = deps.auth
  const secure = deps.secureCookies === true
  if (!rc || !auth) throw unauthorized(res, hadCookies, secure)

  let fresh: { accessToken: string; refreshToken: string } | null
  try {
    fresh = await refreshOnce(auth, rc.rt)
  } catch (e) {
    deps.logger?.error(`backoffice: no se renovó la sesión (${errorText(e)})`)
    if (current) return current
    throw new HttpError(503, 'no se pudo renovar la sesión; intenta de nuevo')
  }
  if (!fresh) {
    if (current) return current
    throw unauthorized(res, true, secure)
  }
  const next = verifyToken(deps.backofficeJwtSecret, fresh.accessToken)
  const renewed = next && next.sub === rc.sub ? await memberOf(deps, next) : null
  if (!next || !renewed) {
    await revokeQuietly(deps, auth, fresh.accessToken, 'de un usuario sin pertenencia')
    throw unauthorized(res, true, secure)
  }
  res.setHeader(
    SET_COOKIE,
    renewedCookies(deps.backofficeJwtSecret, fresh.accessToken, next.exp, { ...rc, rt: fresh.refreshToken, rat: now }, limits, secure),
  )
  return renewed
}

export async function cookieSession(
  req: Request,
  res: Response,
  deps: BackofficeDeps,
  limits: SessionLimits,
): Promise<Who> {
  const header = req.header('cookie')
  const token = readCookie(header, SESSION_COOKIE)
  const sealed = deps.auth ? readCookie(header, REFRESH_COOKIE) : null
  const hadCookies = Boolean(token ?? readCookie(header, REFRESH_COOKIE))
  const now = nowSeconds()
  let rc = sealed ? openRefresh(deps.backofficeJwtSecret, sealed, limits, now) : null

  const { current, claims } = await validateActiveAccessToken(token, deps, now, res)
  if (rc && claims && rc.sub !== claims.sub) rc = null

  if (current && claims && (!rc || claims.exp - now > refreshBefore(claims))) return current

  return renewFromRefreshCookie(rc, current, deps, limits, now, res, hadCookies)
}

function sendMagicLink(auth: AuthDirectory, email: string, origin: string, deps: BackofficeDeps): void {
  auth.sendMagicLink(email, `${origin}${ENTER_PATH}`).catch((e: unknown) => {
    deps.logger?.error(`backoffice: no se pidió el enlace de acceso (${errorText(e)})`)
  })
}

export async function meOf(deps: BackofficeDeps, w: Who): Promise<BackofficeMe> {
  const { t, wa } = await withTenant(deps.db, w.tenantId, async (tx) => {
    const [found] = await tx
      .select({ id: tenants.id, name: tenants.name, whatsapp: tenants.whatsappNumber })
      .from(tenants)
      .where(eq(tenants.id, w.tenantId))
    return { t: found, wa: await whatsappSession(tx, w.tenantId) }
  })
  if (!t) throw new HttpError(401, 'sesión inválida')
  const linked = wa?.running && wa.status === 'open' ? wa.linkedNumber : null
  return {
    user: { id: w.userId, email: w.email },
    tenant: { id: t.id, name: t.name, whatsapp_number: t.whatsapp, whatsapp_linked_number: linked },
  }
}

async function setupPending(deps: BackofficeDeps): Promise<boolean> {
  const found = await deps.db.execute<{ pending: boolean }>(sql`select app.setup_pending() as pending`)
  return found.rows[0]?.pending === true
}

async function openSession(
  deps: BackofficeDeps,
  res: Response,
  token: string,
  refreshToken: string | undefined,
  limits: SessionLimits,
): Promise<void> {
  const secure = deps.secureCookies === true
  const w = await membership(deps, token)
  if (!w) throw new HttpError(401, 'el enlace de acceso no es válido o ya venció')
  const at = nowSeconds()
  if (deps.auth && w.supabaseSession && refreshToken) {
    res.setHeader(
      SET_COOKIE,
      renewedCookies(deps.backofficeJwtSecret, token, w.exp, { v: 1, rt: refreshToken, sub: w.userId, iat: at, rat: at }, limits, secure),
    )
  } else {
    res.setHeader(SET_COOKIE, sessionCookie(token, { maxAgeSeconds: Math.min(SESSION_SECONDS, w.exp - at), secure }))
    if (deps.auth && w.supabaseSession) await revokeQuietly(deps, deps.auth, token, 'sin refresh token')
  }
  res.json(await meOf(deps, w))
}

function mountSessionRoutes(
  r: express.Router,
  deps: BackofficeDeps,
  limits: SessionLimits,
  countAttempt: (req: Request) => void,
): void {
  r.post('/session', async (req, res) => {
    countAttempt(req)
    assertCsrf(req)
    const body = parse(SessionCreateBody, req.body)
    await openSession(deps, res, body.token, body.refresh_token, limits)
  })

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
    await openSession(deps, res, tokens.accessToken, tokens.refreshToken, limits)
  })

  r.get('/session/config', async (_req, res) => {
    const out: SessionConfig = {
      magic_link: Boolean(deps.auth),
      setup_required: await setupPending(deps),
      setup_password: Boolean(deps.setupPassword),
    }
    res.json(out)
  })
}

async function createSetupUser(deps: BackofficeDeps, email: string): Promise<string> {
  if (!deps.auth) return randomUUID()
  try {
    return await deps.auth.ensureUser(email)
  } catch (e) {
    deps.logger?.error(`backoffice: no se creó la cuenta de Auth del primer inicio (${errorText(e)})`)
    throw new HttpError(502, 'no se pudo crear la cuenta de acceso; intenta de nuevo')
  }
}

function mountSetupRoute(
  r: express.Router,
  deps: BackofficeDeps,
  setupPerIp: (key: string) => boolean,
  secure: boolean,
): void {
  r.post('/setup', async (req, res) => {
    assertCsrf(req)
    if (deps.setupPassword && !setupPerIp(req.ip ?? 'local')) {
      throw new HttpError(429, 'demasiados intentos; espera un minuto')
    }
    const body = parse(SetupBody, req.body)
    const taken = new HttpError(409, 'el sistema ya tiene una institución crediticia configurada')
    if (!(await setupPending(deps))) throw taken
    if (deps.setupPassword && !samePassword(body.password ?? '', deps.setupPassword)) {
      throw new HttpError(403, 'contraseña incorrecta', [{ path: 'password', message: 'Contraseña incorrecta' }])
    }
    const userId = await createSetupUser(deps, body.email)
    const created = await deps.db.execute<{ tenant: string | null }>(
      sql`select app.setup_first_tenant(${body.tenant_name}, ${body.whatsapp_number}, ${JSON.stringify(basePolicyTemplate())}::jsonb, ${userId}::uuid, ${body.email})::text as tenant`,
    )
    const tenantId = created.rows[0]?.tenant
    if (!tenantId) throw taken
    const token = issueToken(deps.backofficeJwtSecret, { sub: userId, email: body.email, tenant_id: tenantId }, SESSION_SECONDS)
    res.setHeader(SET_COOKIE, sessionCookie(token, { maxAgeSeconds: SESSION_SECONDS, secure }))
    res.status(201).json(await meOf(deps, { userId, email: body.email, tenantId }))
  })
}

function mountMagicLinkRoute(
  r: express.Router,
  deps: BackofficeDeps,
  backofficeOrigin: string,
  magicLinkPerIp: (key: string) => boolean,
  magicLinkPerEmail: (key: string) => boolean,
): void {
  r.post('/session/magic-link', (req, res) => {
    const auth = deps.auth
    if (!auth) throw new HttpError(404, 'no encontrado')
    if (!magicLinkPerIp(req.ip ?? 'local')) throw new HttpError(429, 'demasiados intentos; espera un minuto')
    assertCsrf(req)
    const { email } = parse(MagicLinkBody, req.body)
    if (magicLinkPerEmail(createHash('sha256').update(email).digest('hex'))) {
      sendMagicLink(auth, email, backofficeOrigin, deps)
    }
    const out: MagicLinkAccepted = { accepted: true }
    res.status(202).json(out)
  })
}

function mountDeleteSessionRoute(
  r: express.Router,
  deps: BackofficeDeps,
  limits: SessionLimits,
  secure: boolean,
): void {
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
      if (token && claims?.session_id !== undefined) await revokeQuietly(deps, auth, token, 'al salir')
    }
    res.setHeader(SET_COOKIE, clearedCookies(secure))
    res.status(204).end()
  })
}

export function authPublicRouter(deps: BackofficeDeps, limits: SessionLimits): express.Router {
  const r = express.Router()
  const secure = deps.secureCookies === true
  const backofficeOrigin = backofficeBase(deps)
  const magicLinkPerIp = createWindowLimiter(5, 60_000)
  const magicLinkPerEmail = createWindowLimiter(4, 15 * 60_000)
  const setupPerIp = createWindowLimiter(10, 60_000)
  const attemptsLimiter = createWindowLimiter(20, 60_000)

  const countAttempt = (req: Request) => {
    if (!attemptsLimiter(req.ip ?? 'local')) throw new HttpError(429, 'demasiados intentos')
  }

  mountSessionRoutes(r, deps, limits, countAttempt)
  mountSetupRoute(r, deps, setupPerIp, secure)
  mountMagicLinkRoute(r, deps, backofficeOrigin, magicLinkPerIp, magicLinkPerEmail)
  mountDeleteSessionRoute(r, deps, limits, secure)

  return r
}

export function authMiddleware(
  deps: BackofficeDeps,
  limits: SessionLimits,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1]
    if (bearer) {
      const w = await membership(deps, bearer)
      if (!w) throw new HttpError(401, SESSION_REQUIRED)
      res.locals.who = w
      next()
      return
    }
    const header = req.header('cookie')
    const withCookies = Boolean(readCookie(header, SESSION_COOKIE) ?? readCookie(header, REFRESH_COOKIE))
    if (withCookies && !['GET', 'HEAD'].includes(req.method)) assertCsrf(req)
    res.locals.who = await cookieSession(req, res, deps, limits)
    next()
  }
}

export function authMeRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.get('/me', async (_req, res) => {
    res.json(await meOf(deps, res.locals.who as Who))
  })
  return r
}
