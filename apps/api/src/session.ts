/**
 * Sesión del backoffice (docs/08 §1 y §4). El navegador presenta un JWT HS256 con `sub`,
 * `email`, `tenant_id` y `exp`: Supabase Auth lo emite en producción (con `tenant_id` como claim
 * firmado) y `pnpm tenant user add` uno equivalente en desarrollo. La API lo verifica una vez y lo
 * guarda en una cookie `HttpOnly; SameSite=Strict`: ninguna pieza de JavaScript del navegador
 * toca el token (sin `localStorage`). La pertenencia al tenant se vuelve a leer de `tenant_users`
 * en cada petición, así que quitar a un usuario surte efecto de inmediato.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SESSION_COOKIE = 'gow_session'
/** Los POST/PUT/DELETE del backoffice exigen este encabezado: un formulario de otro sitio no puede mandarlo. */
export const CSRF_HEADER = 'x-gow-backoffice'

const Claims = z.object({
  sub: z.uuid(),
  email: z.email(),
  tenant_id: z.uuid(),
  exp: z.number().int(),
})
export type SessionClaims = z.infer<typeof Claims>

const b64 = (input: string | Buffer) => Buffer.from(input).toString('base64url')

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/** JWT HS256 mínimo. En desarrollo lo emite el CLI; la verificación es la misma que para Supabase. */
export function issueToken(secret: string, claims: Omit<SessionClaims, 'exp'>, ttlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
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

export function sessionCookie(token: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  return `${SESSION_COOKIE}=${token}; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=${String(opts.maxAgeSeconds)}${opts.secure ? '; Secure' : ''}`
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}
