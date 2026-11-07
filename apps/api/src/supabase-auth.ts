/**
 * Server-side Supabase Auth (GoTrue), for backoffice email login. Only the API and the CLI use
 * it, with the service_role key (never sent to the browser):
 * - `ensureUser`: when a backoffice user is added, creates their already-confirmed Auth account
 *   (or finds the existing one) and returns its id, stored as `tenant_users.user_id`;
 * - `sendMagicLink`: asks GoTrue to email the access link, without creating accounts;
 * - `refreshSession`: swaps a refresh token for a new access token (GoTrue rotates the refresh
 *   token on every use);
 * - `revokeSession`: closes the GoTrue session of an access token (invalidates its refresh token).
 *
 * No error carries the email or tokens: only the HTTP code.
 */
import { z } from 'zod'

export interface AuthDirectory {
  /**
   * Id of the Auth account with that email; creates it confirmed if missing. `preferredId` is
   * used as the new account's id (to link a membership that already existed without changing its id).
   */
  ensureUser(email: string, preferredId?: string): Promise<string>
  /** true if GoTrue sent the email; false if no account has that email (none is created). */
  sendMagicLink(email: string, redirectTo: string): Promise<boolean>
  /**
   * New tokens, or null if GoTrue rejected the refresh token (expired, already used outside the
   * reuse interval, session closed, user banned). A transient error (5xx, 429, network) is thrown.
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
  /** /otp and /logout only need the anon key; without it the service_role key is used. */
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

/** With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment; if either is missing, null (no-Supabase mode). */
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
    // `filter` matches partially: compare exactly here.
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
      // No account: GoTrue does not create one (create_user: false) and answers 422 otp_disabled.
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
      // 429: GoTrue's renewal limit (per IP); says nothing about the token.
      if (r.status === 429 || r.status >= 500) throw new AuthDirectoryError(r.status)
      return null
    },

    async revokeSession(accessToken) {
      const r = await call('POST', '/logout?scope=local', { key: publicKey, bearer: accessToken })
      // 204 closed; 401/403/404: the session no longer exists. Nothing to do either way.
      if (r.status >= 500) throw new AuthDirectoryError(r.status)
    },
  }
}
