/**
 * Sesión del backoffice (docs/08 §1 y §4). El navegador presenta un JWT HS256 con `sub`,
 * `email`, `tenant_id` y `exp`: Supabase Auth lo emite tras el enlace por correo (`tenant_id` lo
 * agrega el custom access token hook, ADR 0035) y `pnpm tenant user add` uno equivalente sin
 * Supabase. La API lo verifica una vez y lo guarda en una cookie `HttpOnly; SameSite=Strict`:
 * ninguna pieza de JavaScript del navegador toca el token después (sin `localStorage`). La pertenencia al tenant se vuelve a leer de `tenant_users`
 * en cada petición, así que quitar a un usuario surte efecto de inmediato.
 *
 * Con Supabase Auth, el refresh token va en una segunda cookie `HttpOnly`, cifrado con AES-256-GCM
 * junto con el inicio de la sesión y la última renovación (ADR 0036): la API renueva el access token
 * sin estado en el servidor y corta la sesión al pasar el límite absoluto o el de inactividad.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SESSION_COOKIE = 'gow_session'
/** Refresh token de Supabase Auth, cifrado (ADR 0036). Sin Supabase Auth no existe. */
export const REFRESH_COOKIE = 'gow_refresh'
/** Los POST/PUT/DELETE del backoffice exigen este encabezado: un formulario de otro sitio no puede mandarlo. */
export const CSRF_HEADER = 'x-gow-backoffice'

const Claims = z.object({
  sub: z.uuid(),
  email: z.email(),
  tenant_id: z.uuid(),
  exp: z.number().int(),
  iat: z.number().int().optional(),
  /** Solo en tokens de Supabase Auth: la sesión de GoTrue que los emitió. */
  session_id: z.string().optional(),
})
export type SessionClaims = z.infer<typeof Claims>

const b64 = (input: string | Buffer) => Buffer.from(input).toString('base64url')

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/** JWT HS256 mínimo. En desarrollo lo emite el CLI; la verificación es la misma que para Supabase. */
export function issueToken(secret: string, claims: Omit<SessionClaims, 'exp' | 'iat' | 'session_id'>, ttlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify({ ...claims, exp: nowSeconds + ttlSeconds }))
  return `${head}.${body}.${b64(sign(secret, `${head}.${body}`))}`
}

/** Los claims de un token vigente y bien firmado, o null (nunca dice cuál de las dos cosas falló). */
export function verifyToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts as [string, string, string]
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown }
    // Solo HS256: nada de `alg: none` ni de confundir algoritmos.
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

/** Borra las dos cookies (la de refresh puede no existir: borrarla no estorba). */
export function clearedCookies(secure: boolean): string[] {
  return [cookie(SESSION_COOKIE, '', 0, secure), cookie(REFRESH_COOKIE, '', 0, secure)]
}

// ---------- Cookie de refresh (ADR 0036)

const RefreshPayload = z.strictObject({
  v: z.literal(1),
  /** Refresh token de GoTrue. Rota en cada renovación. */
  rt: z.string().min(1).max(4000),
  /** Usuario del access token con el que se abrió la sesión: el renovado debe ser el mismo. */
  sub: z.uuid(),
  /** Inicio de la sesión (segundos). No cambia al renovar: de aquí se cuenta el límite absoluto. */
  iat: z.number().int(),
  /** Última renovación (segundos): de aquí se cuenta el límite por inactividad. */
  rat: z.number().int(),
})
export type RefreshPayload = z.infer<typeof RefreshPayload>

export interface SessionLimits {
  /** Vida máxima de la sesión desde el login; después hay que pedir otro enlace. */
  maxSeconds: number
  /** Sin renovar en este lapso (sin peticiones), la sesión termina. */
  idleSeconds: number
}

const IV_BYTES = 12
const TAG_BYTES = 16
/** Liga el texto cifrado a esta cookie y a esta versión del formato. */
const AAD = Buffer.from(`${REFRESH_COOKIE}.v1`)
const keys = new Map<string, Buffer>()

/**
 * Llave AES-256 derivada con HKDF-SHA256 de `BACKOFFICE_JWT_SECRET` con una etiqueta fija: nunca es
 * la misma llave que firma los JWT, y no hay un secreto más que desplegar ni rotar.
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
 * El contenido de una cookie de refresh íntegra y dentro de los límites, o null: alterada, de otra
 * llave, con otro formato, pasada del límite absoluto o del de inactividad (nunca dice cuál).
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

/** Segundos que le quedan a una sesión antes del primero de sus dos límites. */
export function refreshRemaining(p: RefreshPayload, limits: SessionLimits, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.min(p.iat + limits.maxSeconds, p.rat + limits.idleSeconds) - nowSeconds
}
