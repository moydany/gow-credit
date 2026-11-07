/**
 * First-run setup against real Postgres and an empty database: the wizard creates the tenant, its
 * base policy and the admin, leaves the session open, and stops working once created.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { LocalDocumentStorage, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { AuthDirectory } from './supabase-auth.ts'

const available = await postgresAvailable()
const SECRET = 'secreto-de-pruebas-del-primer-inicio'

describe.skipIf(!available)('Primer inicio (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let apiDb: Database
  let admin: pg.Client
  let boss: PgBoss
  let server: Server
  let base = ''
  let serverSb: Server
  let baseSb = ''
  // The same API with SETUP_PASSWORD, as in the shared demo.
  let serverPw: Server
  let basePw = ''
  const ensured: string[] = []
  const AUTH_ID = '5b0e1c52-1a0c-4f0a-9d7e-3f1f6a1e7b11'
  const auth: AuthDirectory = {
    ensureUser: (email) => {
      ensured.push(email)
      return Promise.resolve(AUTH_ID)
    },
    sendMagicLink: () => Promise.resolve(true),
    refreshSession: () => Promise.resolve(null),
    revokeSession: () => Promise.resolve(),
  }

  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; csrf?: boolean; base?: string } = {}) => {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.csrf !== false && method !== 'GET') headers['x-gow-backoffice'] = '1'
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${opts.base ?? base}/bo/v1${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) })
    const text = await res.text()
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }
  const countOf = async (table: string, where = 'true', values: unknown[] = []): Promise<number> => {
    const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table} WHERE ${where}`, values)
    return rows[0]?.n ?? -1
  }
  const valid = { tenant_name: 'Fintech Demo', email: 'Admin@Prestamista.test', whatsapp_number: '+5215512345678' }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    apiDb = connect(tdb.url('api'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
    server = createServer()
    server.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-setup-')), secret: 'firma-local', publicBaseUrl: base })
    server.on('request', createApp({ db: apiDb.db, boss, storage, backofficeJwtSecret: SECRET }))
    serverSb = createServer(createApp({ db: apiDb.db, boss, storage, backofficeJwtSecret: SECRET, auth }))
    serverSb.listen(0)
    await new Promise((r) => serverSb.once('listening', r))
    baseSb = `http://127.0.0.1:${String((serverSb.address() as AddressInfo).port)}`
    serverPw = createServer(createApp({ db: apiDb.db, boss, storage, backofficeJwtSecret: SECRET, setupPassword: 'clave-de-prueba' }))
    serverPw.listen(0)
    await new Promise((r) => serverPw.once('listening', r))
    basePw = `http://127.0.0.1:${String((serverPw.address() as AddressInfo).port)}`
  }, 60_000)

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await new Promise((r) => serverSb.close(r))
    await new Promise((r) => serverPw.close(r))
    await boss.stop({ graceful: false })
    await admin.end()
    await apiDb.close()
    await tdb.drop()
  })

  it('con el sistema vacío pide el primer inicio, y rechaza cuerpos inválidos y peticiones sin CSRF', async () => {
    expect((await call('GET', '/session/config')).json).toMatchObject({ setup_required: true })
    expect((await call('POST', '/setup', { body: valid, csrf: false })).status).toBe(403)
    expect((await call('POST', '/setup', { body: { ...valid, email: 'no-es-correo' } })).status).toBe(400)
    expect((await call('POST', '/setup', { body: { ...valid, whatsapp_number: '5512345678' } })).status).toBe(400)
    expect((await call('POST', '/setup', { body: { ...valid, tenant_name: 'x' } })).status).toBe(400)
    expect(await countOf('tenants')).toBe(0)
  })

  it('con SETUP_PASSWORD, config lo avisa y sin la contraseña correcta no se crea nada', async () => {
    expect((await call('GET', '/session/config')).json).toMatchObject({ setup_required: true, setup_password: false })
    expect((await call('GET', '/session/config', { base: basePw })).json).toMatchObject({ setup_required: true, setup_password: true })
    expect((await call('POST', '/setup', { body: valid, base: basePw })).status).toBe(403)
    const wrong = await call('POST', '/setup', { body: { ...valid, password: 'otra' }, base: basePw })
    expect(wrong.status).toBe(403)
    expect(wrong.json).toMatchObject({ issues: [{ path: 'password' }] })
    expect(await countOf('tenants')).toBe(0)
    // The password never reaches the audit log.
    expect(await countOf('audit_log', "details::text LIKE '%otra%'")).toBe(0)
    // Brute force: after 10 tries in a minute, 429.
    for (let i = 0; i < 8; i++) await call('POST', '/setup', { body: { ...valid, password: `x${String(i)}` }, base: basePw })
    expect((await call('POST', '/setup', { body: { ...valid, password: 'clave-de-prueba' }, base: basePw })).status).toBe(429)
    expect(await countOf('tenants')).toBe(0)
  })

  it('crea tenant, política base activa y administrador, y deja la sesión abierta', async () => {
    const r = await call('POST', '/setup', { body: valid })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ user: { email: 'admin@prestamista.test' }, tenant: { name: 'Fintech Demo', whatsapp_number: '+5215512345678' } })
    const cookie = r.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)

    const me = await call('GET', '/me', { cookie: cookie.split(';')[0] ?? '' })
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({ user: { email: 'admin@prestamista.test' } })

    const tenant = (r.json as { tenant: { id: string } }).tenant.id
    const versions = await admin.query('SELECT version, status FROM app.policy_versions WHERE tenant_id = $1', [tenant])
    expect(versions.rows).toEqual([{ version: 1, status: 'active' }])
    const audit = await admin.query("SELECT actor FROM app.audit_log WHERE tenant_id = $1 AND action = 'tenant.setup'", [tenant])
    expect(audit.rows).toHaveLength(1)
    // The wizard issues no API key: it is created later from Settings.
    expect(await countOf('api_keys', 'tenant_id = $1', [tenant])).toBe(0)
  })

  it('una vez creado el tenant ya no funciona y config deja de pedirlo', async () => {
    expect((await call('GET', '/session/config')).json).toMatchObject({ setup_required: false })
    const again = await call('POST', '/setup', { body: { ...valid, tenant_name: 'Otro', email: 'otro@prestamista.test' } })
    expect(again.status).toBe(409)
    expect(await countOf('tenants')).toBe(1)
  })

  it('dos llamadas simultáneas crean un solo tenant', async () => {
    await admin.query('DELETE FROM app.audit_log; DELETE FROM app.tenant_users; DELETE FROM app.policy_versions; DELETE FROM app.policies; DELETE FROM app.tenants')
    const both = await Promise.all([call('POST', '/setup', { body: valid }), call('POST', '/setup', { body: { ...valid, email: 'segundo@prestamista.test' } })])
    expect(both.map((x) => x.status).sort()).toEqual([201, 409])
    expect(await countOf('tenants')).toBe(1)
  })

  it('con Supabase Auth, la cuenta del administrador se crea en Auth y su id es el de la pertenencia', async () => {
    await admin.query('DELETE FROM app.audit_log; DELETE FROM app.tenant_users; DELETE FROM app.policy_versions; DELETE FROM app.policies; DELETE FROM app.tenants')
    const r = await call('POST', '/setup', { body: valid, base: baseSb })
    expect(r.status).toBe(201)
    expect(ensured).toEqual(['admin@prestamista.test'])
    expect(r.json).toMatchObject({ user: { id: AUTH_ID } })
    expect(await countOf('tenant_users', 'user_id = $1', [AUTH_ID])).toBe(1)
  })
})
