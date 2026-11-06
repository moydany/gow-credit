/**
 * Sesión renovable con Supabase Auth (ADR 0036), contra Postgres real y con GoTrue simulado: el
 * refresh token vive cifrado en una cookie HttpOnly; la API renueva cerca del vencimiento o ya
 * vencido, comparte una renovación entre peticiones en paralelo, respeta la pertenencia y los
 * límites, y al salir cierra la sesión de GoTrue.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import type { DocumentStorage, PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { createApp } from './app.ts'
import { openRefresh, sealRefresh } from './session.ts'
import type { AuthDirectory } from './supabase-auth.ts'

const available = await postgresAvailable()
const SECRET = 'secreto-de-pruebas-del-backoffice'
const LIMITS = { maxSeconds: 12 * 3600, idleSeconds: 8 * 3600 }
const now = () => Math.floor(Date.now() / 1000)

/**
 * Un access token como los de GoTrue: HS256 con el JWT secret, `session_id` y, si hay pertenencia,
 * `tenant_id`. Vence en `ttl` segundos y su vida total es `life` (emitido hace `life - ttl`).
 */
function accessToken(claims: { sub: string; email: string; session_id: string; tenant_id?: string | null }, ttl: number, life = 3600): string {
  const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const t = now()
  const { tenant_id, ...rest } = claims
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'authenticated', role: 'authenticated', ...rest, ...(tenant_id ? { tenant_id } : {}), iat: t + ttl - life, exp: t + ttl })}`
  return `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`
}
const sessionOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { session_id: string }).session_id

/** GoTrue en memoria: rota el refresh token en cada uso y rechaza uno ya usado o de una sesión cerrada. */
function fakeGoTrue() {
  const state = {
    live: new Map<string, { sub: string; email: string; sessionId: string }>(),
    /** El tenant que pondría el hook (lo que diga la prueba, aunque la pertenencia ya no exista). */
    hook: new Map<string, string | null>(),
    closed: new Set<string>(),
    refreshCalls: 0,
    revoked: [] as string[],
    down: false,
    delayMs: 0,
    ttl: 3600,
  }
  const auth: AuthDirectory = {
    ensureUser: () => Promise.reject(new Error('no se usa aquí')),
    sendMagicLink: () => Promise.resolve(false),
    async refreshSession(rt) {
      state.refreshCalls++
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
      if (state.down) throw new Error('Supabase Auth respondió 503')
      const s = state.live.get(rt)
      if (!s || state.closed.has(s.sessionId)) return null
      state.live.delete(rt)
      const next = `rt-${randomUUID()}`
      state.live.set(next, s)
      return { accessToken: accessToken({ sub: s.sub, email: s.email, session_id: s.sessionId, tenant_id: state.hook.get(s.sub) ?? null }, state.ttl), refreshToken: next }
    },
    revokeSession(token) {
      const sid = sessionOf(token)
      state.revoked.push(sid)
      state.closed.add(sid)
      return Promise.resolve()
    },
  }
  /** Lo que trae el fragmento de `/entrar` al abrir el enlace. */
  function signIn(sub: string, email: string, tenant: string, ttl: number) {
    const sessionId = randomUUID()
    const rt = `rt-${randomUUID()}`
    state.live.set(rt, { sub, email, sessionId })
    state.hook.set(sub, tenant)
    return { token: accessToken({ sub, email, session_id: sessionId, tenant_id: tenant }, ttl), refresh_token: rt, sessionId }
  }
  return { state, auth, signIn }
}

/** Las cookies de un `Set-Cookie` (nombre → { valor, atributos }). */
function setCookies(h: Headers): Map<string, { value: string; attrs: string }> {
  const out = new Map<string, { value: string; attrs: string }>()
  for (const line of h.getSetCookie()) {
    const [pair = '', ...attrs] = line.split('; ')
    const i = pair.indexOf('=')
    out.set(pair.slice(0, i), { value: pair.slice(i + 1), attrs: attrs.join('; ') })
  }
  return out
}
const jar = (c: Map<string, { value: string }>) => [...c].filter(([, v]) => v.value).map(([k, v]) => `${k}=${v.value}`).join('; ')

describe.skipIf(!available)('Sesión renovable con Supabase Auth (necesita Postgres)', () => {
  let tdb: TestDatabase
  let adminDb: Database
  let apiDb: Database
  let admin: pg.Client
  let server: Server
  let plain: Server
  let base = ''
  let plainBase = ''
  let tenant = ''
  const gotrue = fakeGoTrue()

  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; at?: string } = {}) => {
    const headers: Record<string, string> = { 'x-gow-backoffice': '1' }
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${opts.at ?? base}/bo/v1${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) })
    await res.text()
    return { status: res.status, cookies: setCookies(res.headers) }
  }

  async function member(email: string): Promise<string> {
    const id = randomUUID()
    await admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [tenant, id, email])
    return id
  }

  /**
   * Entra por `/entrar` y devuelve las cookies. Con `ttl`, la cookie de sesión lleva después un access
   * token de la misma sesión que vence en `ttl` segundos (negativo: ya vencido).
   */
  async function login(email: string, ttl?: number, life?: number) {
    const sub = await member(email)
    const s = gotrue.signIn(sub, email, tenant, 3600)
    const r = await call('POST', '/session', { body: { token: s.token, refresh_token: s.refresh_token } })
    expect(r.status).toBe(200)
    const token = ttl === undefined ? s.token : accessToken({ sub, email, session_id: s.sessionId, tenant_id: tenant }, ttl, life)
    const cookies = new Map(r.cookies)
    cookies.set('gow_session', { value: token, attrs: '' })
    return { sub, ...s, token, cookies, cookie: jar(cookies) }
  }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    adminDb = connect(tdb.url('admin'))
    apiDb = connect(tdb.url('api'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    tenant = (await createTenant(adminDb.db, { name: 'Prestamista Renovable' })).tenantId
    const deps = { db: apiDb.db, boss: {} as PgBoss, storage: {} as DocumentStorage, backofficeJwtSecret: SECRET }
    server = createServer(createApp({ ...deps, auth: gotrue.auth, logger: { error: () => undefined } }))
    plain = createServer(createApp(deps))
    for (const s of [server, plain]) {
      s.listen(0)
      await new Promise((r) => s.once('listening', r))
    }
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    plainBase = `http://127.0.0.1:${String((plain.address() as AddressInfo).port)}`
  }, 60_000)

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await new Promise((r) => plain.close(r))
    await admin.end()
    await apiDb.close()
    await adminDb.close()
    await tdb.drop()
  })

  beforeEach(() => {
    Object.assign(gotrue.state, { refreshCalls: 0, down: false, delayMs: 0, ttl: 3600 })
    gotrue.state.revoked.length = 0
  })

  it('al entrar, el refresh token queda cifrado en una cookie HttpOnly y la sesión de GoTrue sigue abierta', async () => {
    const s = await login('entra@prestamista.test')
    const rc = s.cookies.get('gow_refresh')
    expect(rc?.attrs).toMatch(/^Path=\/bo; HttpOnly; SameSite=Strict; Max-Age=(\d+)$/)
    expect(Number(/Max-Age=(\d+)/.exec(rc?.attrs ?? '')?.[1])).toBe(8 * 3600)
    expect(rc?.value).not.toContain(s.refresh_token)
    expect(openRefresh(SECRET, rc?.value ?? '', LIMITS)).toMatchObject({ rt: s.refresh_token, sub: s.sub })
    expect(gotrue.state.revoked).toEqual([])
    expect((await call('GET', '/me', { cookie: s.cookie })).status).toBe(200)
    expect(gotrue.state.refreshCalls).toBe(0)
  })

  it('a menos de 5 min de vencer, renueva: cookies nuevas, mismo inicio de sesión, refresh token rotado', async () => {
    const s = await login('casi@prestamista.test', 120)
    const before = openRefresh(SECRET, s.cookies.get('gow_refresh')?.value ?? '', LIMITS)
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(200)
    expect(gotrue.state.refreshCalls).toBe(1)
    const access = r.cookies.get('gow_session')?.value ?? ''
    expect(access).not.toBe(s.token)
    expect(Number(/Max-Age=(\d+)/.exec(r.cookies.get('gow_session')?.attrs ?? '')?.[1])).toBeGreaterThan(3500)
    const after = openRefresh(SECRET, r.cookies.get('gow_refresh')?.value ?? '', LIMITS)
    expect(after?.rt).not.toBe(s.refresh_token)
    expect(after?.iat).toBe(before?.iat)
    // Con las cookies nuevas sigue sin renovar otra vez; el refresh token viejo ya no sirve en GoTrue.
    expect((await call('GET', '/me', { cookie: jar(r.cookies) })).status).toBe(200)
    expect(gotrue.state.refreshCalls).toBe(1)
    expect(gotrue.state.live.has(s.refresh_token)).toBe(false)
  })

  it('con un JWT_EXPIRY corto, renueva a la mitad de la vida del token y no en cada petición', async () => {
    const fresh = await login('corto1@prestamista.test', 100, 120)
    expect((await call('GET', '/me', { cookie: fresh.cookie })).cookies.size).toBe(0)
    expect(gotrue.state.refreshCalls).toBe(0)
    const half = await login('corto2@prestamista.test', 50, 120)
    expect((await call('GET', '/me', { cookie: half.cookie })).cookies.get('gow_session')?.value).toBeTruthy()
    expect(gotrue.state.refreshCalls).toBe(1)
  })

  it('con el access token vencido (o ya sin su cookie), renueva con la cookie de refresh', async () => {
    const s = await login('vencido@prestamista.test', -5)
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(200)
    expect(r.cookies.get('gow_session')?.value).toBeTruthy()
    const onlyRefresh = await login('solorefresh@prestamista.test')
    expect((await call('GET', '/me', { cookie: `gow_refresh=${onlyRefresh.cookies.get('gow_refresh')?.value ?? ''}` })).status).toBe(200)
  })

  it('vencido y GoTrue rechaza el refresh token: 401 y se borran las dos cookies', async () => {
    const s = await login('rechazo@prestamista.test', -5)
    gotrue.state.closed.add(s.sessionId)
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(401)
    expect(r.cookies.get('gow_session')).toMatchObject({ value: '', attrs: expect.stringContaining('Max-Age=0') as unknown })
    expect(r.cookies.get('gow_refresh')).toMatchObject({ value: '', attrs: expect.stringContaining('Max-Age=0') as unknown })
  })

  it('carrera: peticiones en paralelo con la misma cookie hacen una sola renovación y ninguna saca al usuario', async () => {
    const s = await login('paralelo@prestamista.test', -5)
    gotrue.state.delayMs = 50
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('GET', '/me', { cookie: s.cookie })))
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(gotrue.state.refreshCalls).toBe(1)
    expect(new Set(rs.map((r) => r.cookies.get('gow_session')?.value)).size).toBe(1)
    // Una rezagada con la cookie vieja, ya rotada en GoTrue, recibe los mismos tokens nuevos.
    const late = await call('GET', '/me', { cookie: s.cookie })
    expect(late.status).toBe(200)
    expect(late.cookies.get('gow_session')?.value).toBe(rs[0]?.cookies.get('gow_session')?.value)
    expect(gotrue.state.refreshCalls).toBe(1)
  })

  it('carrera entre instancias: si GoTrue ya rotó el refresh token pero el access token sirve, se sigue sin tocar las cookies', async () => {
    const s = await login('otrainstancia@prestamista.test', 120)
    // Otra instancia de la API ya lo usó (fuera de su intervalo de reúso, GoTrue lo rechaza).
    await gotrue.auth.refreshSession(s.refresh_token)
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(200)
    expect(r.cookies.size).toBe(0)
  })

  it('GoTrue caído: con access token vigente se sigue; vencido, 503 sin borrar cookies', async () => {
    gotrue.state.down = true
    const near = await login('caido1@prestamista.test', 120)
    expect((await call('GET', '/me', { cookie: near.cookie })).status).toBe(200)
    const gone = await login('caido2@prestamista.test', -5)
    const r = await call('GET', '/me', { cookie: gone.cookie })
    expect(r.status).toBe(503)
    expect(r.cookies.size).toBe(0)
  })

  it('quien ya no es miembro no entra aunque la renovación funcione, y se cierra su sesión de GoTrue', async () => {
    const s = await login('baja@prestamista.test', -5)
    await admin.query('DELETE FROM app.tenant_users WHERE user_id = $1', [s.sub])
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(401)
    expect(gotrue.state.refreshCalls).toBe(1)
    expect(gotrue.state.revoked).toEqual([s.sessionId])
    expect(r.cookies.get('gow_refresh')?.value).toBe('')
  })

  it('quitar a un usuario con el access token vigente lo saca en la siguiente petición y cierra su sesión de GoTrue', async () => {
    const s = await login('baja2@prestamista.test')
    await admin.query('DELETE FROM app.tenant_users WHERE user_id = $1', [s.sub])
    const r = await call('GET', '/me', { cookie: s.cookie })
    expect(r.status).toBe(401)
    expect(gotrue.state.refreshCalls).toBe(0)
    expect(gotrue.state.revoked).toEqual([s.sessionId])
  })

  it('pasado el límite absoluto, una cookie de refresh íntegra ya no renueva; una alterada tampoco', async () => {
    const s = await login('viejo@prestamista.test', -5)
    const t = now()
    const old = sealRefresh(SECRET, { v: 1, rt: s.refresh_token, sub: s.sub, iat: t - 12 * 3600 - 1, rat: t - 60 })
    expect((await call('GET', '/me', { cookie: `gow_session=${s.token}; gow_refresh=${old}` })).status).toBe(401)
    const raw = Buffer.from(s.cookies.get('gow_refresh')?.value ?? '', 'base64url')
    raw[20] = (raw[20] ?? 0) ^ 0xff
    expect((await call('GET', '/me', { cookie: `gow_session=${s.token}; gow_refresh=${raw.toString('base64url')}` })).status).toBe(401)
    expect(gotrue.state.refreshCalls).toBe(0)
  })

  it('una cookie de refresh de otro usuario no renueva la sesión de este', async () => {
    const a = await login('mezcla-a@prestamista.test', -5)
    const b = await login('mezcla-b@prestamista.test', 120)
    const r = await call('GET', '/me', { cookie: `gow_session=${b.token}; gow_refresh=${a.cookies.get('gow_refresh')?.value ?? ''}` })
    expect(r.status).toBe(200)
    expect(gotrue.state.refreshCalls).toBe(0)
  })

  it('salir cierra la sesión de GoTrue (aun con el access token vencido) y borra las dos cookies', async () => {
    const s = await login('sale@prestamista.test')
    const r = await call('DELETE', '/session', { cookie: s.cookie })
    expect(r.status).toBe(204)
    expect(gotrue.state.revoked).toEqual([s.sessionId])
    expect(r.cookies.get('gow_session')?.value).toBe('')
    expect(r.cookies.get('gow_refresh')?.value).toBe('')
    // Quien hubiera copiado la cookie de refresh ya no renueva nada.
    expect((await call('GET', '/me', { cookie: `gow_refresh=${s.cookies.get('gow_refresh')?.value ?? ''}` })).status).toBe(401)

    const expired = await login('sale2@prestamista.test', -5)
    expect((await call('DELETE', '/session', { cookie: expired.cookie })).status).toBe(204)
    expect(gotrue.state.revoked).toEqual([s.sessionId, expired.sessionId])
  })

  it('sin Supabase Auth (enlace de desarrollo) no hay cookie de refresh y una que llegue se ignora', async () => {
    const sub = await member('plano@prestamista.test')
    const s = gotrue.signIn(sub, 'plano@prestamista.test', tenant, -5)
    const r = await call('POST', '/session', { at: plainBase, body: { token: accessToken({ sub, email: 'plano@prestamista.test', session_id: s.sessionId, tenant_id: tenant }, 600), refresh_token: s.refresh_token } })
    expect(r.status).toBe(200)
    expect([...r.cookies.keys()]).toEqual(['gow_session'])
    const sealed = sealRefresh(SECRET, { v: 1, rt: s.refresh_token, sub, iat: now(), rat: now() })
    expect((await call('GET', '/me', { at: plainBase, cookie: `gow_refresh=${sealed}` })).status).toBe(401)
    expect(gotrue.state.refreshCalls).toBe(0)
  })
})
