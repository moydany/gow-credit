/**
 * Supabase Auth (GoTrue) del lado del servidor, para el login del backoffice por correo (ADR 0035).
 * Solo la API y el CLI lo usan, con la llave service_role (nunca llega al navegador):
 * - `ensureUser`: al dar de alta a un usuario del backoffice, crea su cuenta de Auth ya confirmada
 *   (o encuentra la existente) y devuelve su id, que se guarda como `tenant_users.user_id`;
 * - `sendMagicLink`: pide a GoTrue el correo con el enlace de acceso, sin crear cuentas;
 * - `refreshSession`: cambia un refresh token por un access token nuevo (ADR 0036; GoTrue rota el
 *   refresh token en cada uso);
 * - `revokeSession`: cierra la sesión de GoTrue de un access token (invalida su refresh token).
 *
 * Ningún error lleva el correo ni los tokens: solo el código HTTP.
 */
import { z } from 'zod'

export interface AuthDirectory {
  /**
   * Id de la cuenta de Auth con ese correo; la crea confirmada si no existe. `preferredId` se usa
   * como id de la cuenta nueva (para ligar una pertenencia que ya existía sin cambiar su id).
   */
  ensureUser(email: string, preferredId?: string): Promise<string>
  /** true si GoTrue mandó el correo; false si no hay cuenta con ese correo (no se crea). */
  sendMagicLink(email: string, redirectTo: string): Promise<boolean>
  /**
   * Tokens nuevos, o null si GoTrue rechazó el refresh token (vencido, ya usado fuera del intervalo de
   * reúso, sesión cerrada, usuario bloqueado). Un error transitorio (5xx, 429, red) se lanza.
   */
  refreshSession(refreshToken: string): Promise<RefreshedSession | null>
  revokeSession(accessToken: string): Promise<void>
}

export interface RefreshedSession {
  accessToken: string
  refreshToken: string
}

export interface SupabaseAuthConfig {
  url: string
  serviceRoleKey: string
  /** Para /otp y /logout basta la llave anon; sin ella se usa la service_role. */
  anonKey?: string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export class AuthDirectoryError extends Error {
  constructor(readonly status: number) {
    super(`Supabase Auth respondió ${String(status)}`)
  }
}

const AdminUser = z.object({ id: z.uuid(), email: z.string().nullish() })
const AdminUserList = z.object({ users: z.array(AdminUser) })
const TokenResponse = z.object({ access_token: z.string().min(20), refresh_token: z.string().min(1) })
const GoTrueError = z.object({ error_code: z.string().optional() }).loose()

/** Con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno; si falta alguno, null (modo sin Supabase). */
export function supabaseAuthFromEnv(env: NodeJS.ProcessEnv): AuthDirectory | null {
  const url = env.SUPABASE_URL?.trim()
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return null
  return supabaseAuth({ url, serviceRoleKey, anonKey: env.SUPABASE_ANON_KEY?.trim() || null })
}

export function supabaseAuth(cfg: SupabaseAuthConfig): AuthDirectory {
  const base = `${cfg.url.replace(/\/+$/, '')}/auth/v1`
  const doFetch = cfg.fetch ?? fetch
  const timeoutMs = cfg.timeoutMs ?? 10_000
  const publicKey = cfg.anonKey ?? cfg.serviceRoleKey

  async function call(method: string, path: string, opts: { key: string; bearer?: string; body?: unknown }): Promise<{ status: number; json: unknown }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { apikey: opts.key, authorization: `Bearer ${opts.bearer ?? opts.key}`, ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json }
  }
  const admin = (method: string, path: string, body?: unknown) => call(method, path, { key: cfg.serviceRoleKey, ...(body === undefined ? {} : { body }) })
  const errorCode = (json: unknown) => GoTrueError.safeParse(json).data?.error_code

  async function findByEmail(email: string): Promise<string | null> {
    // `filter` busca por coincidencia parcial: se compara exacto aquí.
    const r = await admin('GET', `/admin/users?filter=${encodeURIComponent(email)}&per_page=50`)
    if (r.status !== 200) throw new AuthDirectoryError(r.status)
    const found = AdminUserList.parse(r.json).users.find((u) => u.email?.toLowerCase() === email)
    return found?.id ?? null
  }

  return {
    async ensureUser(rawEmail, preferredId) {
      const email = rawEmail.trim().toLowerCase()
      const r = await admin('POST', '/admin/users', { email, email_confirm: true, ...(preferredId ? { id: preferredId } : {}) })
      if (r.status === 200 || r.status === 201) return AdminUser.parse(r.json).id
      if (r.status === 422 && errorCode(r.json) === 'email_exists') {
        const id = await findByEmail(email)
        if (id) return id
      }
      throw new AuthDirectoryError(r.status)
    },

    async sendMagicLink(rawEmail, redirectTo) {
      const email = rawEmail.trim().toLowerCase()
      const r = await call('POST', `/otp?redirect_to=${encodeURIComponent(redirectTo)}`, { key: publicKey, body: { email, create_user: false } })
      if (r.status === 200) return true
      // Sin cuenta: GoTrue no la crea (create_user: false) y responde 422 otp_disabled.
      if (r.status === 422) return false
      throw new AuthDirectoryError(r.status)
    },

    async refreshSession(refreshToken) {
      const r = await call('POST', '/token?grant_type=refresh_token', { key: publicKey, body: { refresh_token: refreshToken } })
      if (r.status === 200) {
        const t = TokenResponse.safeParse(r.json)
        if (!t.success) throw new AuthDirectoryError(r.status)
        return { accessToken: t.data.access_token, refreshToken: t.data.refresh_token }
      }
      // 429: el límite de renovaciones de GoTrue (por IP); no dice nada del token.
      if (r.status === 429 || r.status >= 500) throw new AuthDirectoryError(r.status)
      return null
    },

    async revokeSession(accessToken) {
      const r = await call('POST', '/logout?scope=local', { key: publicKey, bearer: accessToken })
      // 204 cerrada; 401/403/404: la sesión ya no existe. Nada que hacer en ningún caso.
      if (r.status >= 500) throw new AuthDirectoryError(r.status)
    },
  }
}
