/**
 * Backoffice session. The browser presents an HS256 JWT with `sub`, `email`, `tenant_id` and
 * `exp`: Supabase Auth issues it after the emailed link (`tenant_id` is added by the custom access
 * token hook) and `pnpm tenant user add` issues an equivalent one without Supabase. The API
 * verifies it once and stores it in an `HttpOnly; SameSite=Strict` cookie, so no browser
 * JavaScript touches the token afterwards (no `localStorage`). Tenant membership is re-read from
 * `tenant_users` on every request, so removing a user takes effect immediately.
 *
 * With Supabase Auth, the refresh token goes in a second `HttpOnly` cookie, encrypted with
 * AES-256-GCM together with the session start and last renewal: the API renews the access token
 * with no server-side state and ends the session at the absolute or idle limit.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SESSION_COOKIE = 'gow_session'
/** Supabase Auth refresh token, encrypted. Does not exist without Supabase Auth. */
export const REFRESH_COOKIE = 'gow_refresh'
/** Backoffice POST/PUT/DELETE require this header: a form on another site cannot send it. */
export const CSRF_HEADER = 'x-gow-backoffice'

const Claims = z.object({
  sub: z.uuid(),
  email: z.email(),
  tenant_id: z.uuid(),
  exp: z.number().int(),
  iat: z.number().int().optional(),
  /** Supabase Auth tokens only: the GoTrue session that issued them. */
  session_id: z.string().optional(),
})
export type SessionClaims = z.infer<typeof Claims>

const b64 = (input: string | Buffer) => Buffer.from(input).toString('base64url')

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/** Minimal HS256 JWT. In development the CLI issues it; verification is the same as for Supabase. */
export function issueToken(secret: string, claims: Omit<SessionClaims, 'exp' | 'iat' | 'session_id'>, ttlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify({ ...claims, exp: nowSeconds + ttlSeconds }))
  return `${head}.${body}.${b64(sign(secret, `${head}.${body}`))}`
}

/** Claims of a valid, correctly signed token, or null (never says which of the two failed). */
export function verifyToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts as [string, string, string]
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown }
    // HS256 only: no `alg: none` and no algorithm confusion.
    if (header.alg !== 'HS256') return null
    const expected = sign(secret, `${head}.${body}`)
    const got = Buffer.from(sig, 'base64url')
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
    const claims = Claims.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    if (!claims.success || claims.data.exp < nowSeconds) return null
    return claims.data
  } catch {
    return null
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=') || null
  }
  return null
}

function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}${secure ? '; Secure' : ''}`
}

export function sessionCookie(token: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  return cookie(SESSION_COOKIE, token, opts.maxAgeSeconds, opts.secure)
}

export function refreshCookie(sealed: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  return cookie(REFRESH_COOKIE, sealed, opts.maxAgeSeconds, opts.secure)
}

/** Clears both cookies (the refresh one may not exist; clearing it is harmless). */
export function clearedCookies(secure: boolean): string[] {
  return [cookie(SESSION_COOKIE, '', 0, secure), cookie(REFRESH_COOKIE, '', 0, secure)]
}

// ---------- Refresh cookie

const RefreshPayload = z.strictObject({
  v: z.literal(1),
  /** GoTrue refresh token. Rotates on every renewal. */
  rt: z.string().min(1).max(4000),
  /** User of the access token the session was opened with: the renewed one must match. */
  sub: z.uuid(),
  /** Session start (seconds). Unchanged on renewal: the absolute limit counts from here. */
  iat: z.number().int(),
  /** Last renewal (seconds): the idle limit counts from here. */
  rat: z.number().int(),
})
export type RefreshPayload = z.infer<typeof RefreshPayload>

export interface SessionLimits {
  /** Maximum session life since login; after that another link is needed. */
  maxSeconds: number
  /** Without renewal (no requests) in this window, the session ends. */
  idleSeconds: number
}

const IV_BYTES = 12
const TAG_BYTES = 16
/** Binds the ciphertext to this cookie and this format version. */
const AAD = Buffer.from(`${REFRESH_COOKIE}.v1`)
const keys = new Map<string, Buffer>()

/**
 * AES-256 key derived with HKDF-SHA256 from `BACKOFFICE_JWT_SECRET` and a fixed label: never the
 * same key that signs the JWTs, and no extra secret to deploy or rotate.
 */
function refreshKey(secret: string): Buffer {
  let k = keys.get(secret)
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'gow-credit', 'backoffice refresh cookie v1', 32))
    keys.set(secret, k)
  }
  return k
}

export function sealRefresh(secret: string, payload: RefreshPayload): string {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', refreshKey(secret), iv, { authTagLength: TAG_BYTES })
  c.setAAD(AAD)
  const body = Buffer.concat([c.update(JSON.stringify(RefreshPayload.parse(payload)), 'utf8'), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')
}

/**
 * Contents of an intact refresh cookie within its limits, or null: tampered, other key, other
 * format, past the absolute or idle limit (never says which).
 */
export function openRefresh(secret: string, sealed: string, limits: SessionLimits, nowSeconds = Math.floor(Date.now() / 1000)): RefreshPayload | null {
  try {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const d = createDecipheriv('aes-256-gcm', refreshKey(secret), raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES })
    d.setAAD(AAD)
    d.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const plain = Buffer.concat([d.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), d.final()])
    const p = RefreshPayload.safeParse(JSON.parse(plain.toString('utf8')))
    if (!p.success) return null
    const { iat, rat } = p.data
    if (iat > nowSeconds + 60 || rat < iat) return null
    if (nowSeconds - iat >= limits.maxSeconds || nowSeconds - rat >= limits.idleSeconds) return null
    return p.data
  } catch {
    return null
  }
}

/** Seconds left in a session before the first of its two limits. */
export function refreshRemaining(p: RefreshPayload, limits: SessionLimits, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.min(p.iat + limits.maxSeconds, p.rat + limits.idleSeconds) - nowSeconds
}
