/** Cliente de GoTrue con `fetch` simulado: lo que pide, con qué llave y qué hace con cada respuesta. */
import { describe, expect, it } from 'vitest'
import { AuthDirectoryError, supabaseAuth, supabaseAuthFromEnv } from './supabase-auth.ts'

interface Seen {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(reply: (req: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = []
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const req: Seen = { method: init?.method ?? 'GET', url, headers: init?.headers as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
    seen.push(req)
    const r = reply(req)
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }))
  }) as typeof fetch
  return { fn, seen }
}

const ID = '7b0c1c9e-3c1f-4a39-9d55-2f4f3c1f0a11'
const OTHER = '0d9a4b9a-6d5e-4b8e-8f2a-111111111111'
const cfg = { url: 'http://gotrue.test/', serviceRoleKey: 'service-key', anonKey: 'anon-key' }

describe('Supabase Auth del lado del servidor', () => {
  it('sin SUPABASE_URL o sin la llave service_role no hay cliente', () => {
    expect(supabaseAuthFromEnv({})).toBeNull()
    expect(supabaseAuthFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: '' })).toBeNull()
    expect(supabaseAuthFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k' })).not.toBeNull()
  })

  it('crea la cuenta confirmada con la llave service_role y devuelve su id', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: ID, email: 'nueva@prestamista.test' } }))
    expect(await supabaseAuth({ ...cfg, fetch: f.fn }).ensureUser(' Nueva@Prestamista.test ')).toBe(ID)
    expect(f.seen[0]).toMatchObject({ method: 'POST', url: 'http://gotrue.test/auth/v1/admin/users', headers: { apikey: 'service-key', authorization: 'Bearer service-key' }, body: { email: 'nueva@prestamista.test', email_confirm: true } })
  })

  it('con preferredId crea la cuenta con ese id', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: ID } }))
    await supabaseAuth({ ...cfg, fetch: f.fn }).ensureUser('a@prestamista.test', ID)
    expect(f.seen[0]?.body).toMatchObject({ id: ID })
  })

  it('si el correo ya tiene cuenta, la encuentra por coincidencia exacta', async () => {
    const f = fakeFetch((req) =>
      req.method === 'POST'
        ? { status: 422, body: { code: 422, error_code: 'email_exists', msg: 'ya existe' } }
        : { status: 200, body: { users: [{ id: OTHER, email: 'xa@prestamista.test' }, { id: ID, email: 'a@prestamista.test' }], aud: 'authenticated' } },
    )
    expect(await supabaseAuth({ ...cfg, fetch: f.fn }).ensureUser('a@prestamista.test')).toBe(ID)
    expect(f.seen[1]?.url).toBe('http://gotrue.test/auth/v1/admin/users?filter=a%40prestamista.test&per_page=50')
  })

  it('un error de GoTrue lleva solo el código, nunca el correo', async () => {
    const f = fakeFetch(() => ({ status: 500, body: { msg: 'boom' } }))
    const err = await supabaseAuth({ ...cfg, fetch: f.fn }).ensureUser('secreto@prestamista.test').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthDirectoryError)
    expect((err as Error).message).toBe('Supabase Auth respondió 500')
  })

  it('el enlace se pide con la llave anon, sin crear cuentas y con el destino del backoffice', async () => {
    const f = fakeFetch((req) => ((req.body as { email: string }).email === 'a@prestamista.test' ? { status: 200, body: {} } : { status: 422, body: { error_code: 'otp_disabled' } }))
    const auth = supabaseAuth({ ...cfg, fetch: f.fn })
    expect(await auth.sendMagicLink('A@prestamista.test', 'http://127.0.0.1:5173/entrar')).toBe(true)
    expect(await auth.sendMagicLink('nadie@prestamista.test', 'http://127.0.0.1:5173/entrar')).toBe(false)
    expect(f.seen[0]).toMatchObject({ method: 'POST', url: 'http://gotrue.test/auth/v1/otp?redirect_to=http%3A%2F%2F127.0.0.1%3A5173%2Fentrar', headers: { apikey: 'anon-key' }, body: { email: 'a@prestamista.test', create_user: false } })
  })

  it('cerrar la sesión de Auth usa el access token y tolera una sesión que ya no existe', async () => {
    const f = fakeFetch(() => ({ status: 404 }))
    await supabaseAuth({ ...cfg, fetch: f.fn }).revokeSession('el-token')
    expect(f.seen[0]).toMatchObject({ url: 'http://gotrue.test/auth/v1/logout?scope=local', headers: { apikey: 'anon-key', authorization: 'Bearer el-token' } })
    const down = fakeFetch(() => ({ status: 503 }))
    await expect(supabaseAuth({ ...cfg, fetch: down.fn }).revokeSession('t')).rejects.toBeInstanceOf(AuthDirectoryError)
  })

  it('renovar manda el refresh token con la llave anon y devuelve el par nuevo', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: 'a'.repeat(40), refresh_token: 'nuevo', expires_in: 3600, token_type: 'bearer', user: {} } }))
    expect(await supabaseAuth({ ...cfg, fetch: f.fn }).refreshSession('viejo')).toEqual({ accessToken: 'a'.repeat(40), refreshToken: 'nuevo' })
    expect(f.seen[0]).toMatchObject({ method: 'POST', url: 'http://gotrue.test/auth/v1/token?grant_type=refresh_token', headers: { apikey: 'anon-key' }, body: { refresh_token: 'viejo' } })
  })

  it('renovar: un rechazo de GoTrue es null; 429, 5xx o una respuesta rara son errores transitorios', async () => {
    const rejected = fakeFetch(() => ({ status: 400, body: { error_code: 'refresh_token_already_used' } }))
    expect(await supabaseAuth({ ...cfg, fetch: rejected.fn }).refreshSession('x')).toBeNull()
    for (const reply of [{ status: 429 }, { status: 503 }, { status: 200, body: { access_token: 'corto' } }]) {
      const f = fakeFetch(() => reply)
      await expect(supabaseAuth({ ...cfg, fetch: f.fn }).refreshSession('x')).rejects.toBeInstanceOf(AuthDirectoryError)
    }
  })
})
