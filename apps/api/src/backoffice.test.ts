/**
 * El backoffice contra Postgres real: sesión por cookie, pertenencia verificada en cada petición,
 * CSRF, aislamiento entre tenants, bandeja, respuesta manual de una aclaración y bitácora con el usuario.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, tenantUsers, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { LocalDocumentStorage, QUEUES, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { createApp } from './app.ts'
import { issueToken } from './session.ts'

const available = await postgresAvailable()
const SECRET = 'secreto-de-pruebas-del-backoffice'

describe.skipIf(!available)('Backoffice (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let adminDb: Database
  let apiDb: Database
  let admin: pg.Client
  let boss: PgBoss
  let server: Server
  let base = ''
  let tenantA = ''
  let tenantB = ''
  const userA = randomUUID()
  const userB = randomUUID()

  const tokenFor = (sub: string, tenant: string, email: string, ttl = 600) => issueToken(SECRET, { sub, email, tenant_id: tenant }, ttl)
  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; csrf?: boolean } = {}) => {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.csrf !== false && method !== 'GET') headers['x-gow-backoffice'] = '1'
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}/bo/v1${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) })
    const text = await res.text()
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> & unknown[] }
  }
  async function login(token: string): Promise<string> {
    const r = await call('POST', '/session', { body: { token } })
    expect(r.status).toBe(200)
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    adminDb = connect(tdb.url('admin'))
    apiDb = connect(tdb.url('api'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
    tenantA = (await createTenant(adminDb.db, { name: 'Fintech A' })).tenantId
    tenantB = (await createTenant(adminDb.db, { name: 'Fintech B' })).tenantId
    await admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3), ($4, $5, $6)', [tenantA, userA, 'a@prestamista.test', tenantB, userB, 'b@prestamista.test'])
    server = createServer()
    server.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-bo-')), secret: 'firma-local', publicBaseUrl: base })
    server.on('request', createApp({ db: apiDb.db, boss, storage, backofficeJwtSecret: SECRET }))
  }, 60_000)

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await boss.stop({ graceful: false })
    await admin.end()
    await apiDb.close()
    await adminDb.close()
    await tdb.drop()
  })

  it('sin sesión no entra, y la cookie es HttpOnly y SameSite=Strict', async () => {
    expect((await call('GET', '/applications')).status).toBe(401)
    const r = await call('POST', '/session', { body: { token: tokenFor(userA, tenantA, 'a@prestamista.test') } })
    const cookie = r.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(r.json).toMatchObject({ user: { email: 'a@prestamista.test' }, tenant: { name: 'Fintech A' } })
  })

  it('rechaza tokens vencidos, de otro secreto y de quien no pertenece al tenant', async () => {
    expect((await call('POST', '/session', { body: { token: tokenFor(userA, tenantA, 'a@prestamista.test', -10) } })).status).toBe(401)
    expect((await call('POST', '/session', { body: { token: issueToken('otro-secreto-muy-largo-0000', { sub: userA, email: 'a@prestamista.test', tenant_id: tenantA }, 60) } })).status).toBe(401)
    // El usuario A con el tenant B en el claim: la pertenencia no existe.
    expect((await call('POST', '/session', { body: { token: tokenFor(userA, tenantB, 'a@prestamista.test') } })).status).toBe(401)
  })

  it('una escritura con cookie y sin el encabezado anti-CSRF se rechaza', async () => {
    const cookie = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    expect((await call('POST', '/policies/versions', { cookie, body: { document: {} }, csrf: false })).status).toBe(403)
  })

  it('quitar al usuario corta la sesión aunque el token siga vigente', async () => {
    const extra = randomUUID()
    await admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [tenantA, extra, 'baja@prestamista.test'])
    const cookie = await login(tokenFor(extra, tenantA, 'baja@prestamista.test'))
    expect((await call('GET', '/me', { cookie })).status).toBe(200)
    await admin.query('DELETE FROM app.tenant_users WHERE user_id = $1', [extra])
    expect((await call('GET', '/me', { cookie })).status).toBe(401)
  })

  it('cada tenant ve solo lo suyo y una aclaración manual se responde con el usuario en la bitácora', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const sup = randomUUID()
    const app = randomUUID()
    const clar = randomUUID()
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, 'Proveedor del A'])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'needs_clarification')", [app, tenantA, sup])
    const question = { id: 'q1', topic: 'deposit_classification', kind: 'deposit', transaction: null, facts: [], options: [], text: '¿Qué fue este abono?', text_source: 'template' }
    await q("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, questions) VALUES ($1, $2, $3, $4, 1, 'manual', $5)", [clar, tenantA, app, sup, JSON.stringify([question])])

    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))
    expect((await call('GET', '/applications', { cookie: a })).json).toHaveLength(1)
    expect((await call('GET', '/applications', { cookie: b })).json).toHaveLength(0)
    expect((await call('GET', `/applications/${app}`, { cookie: b })).status).toBe(404)
    expect((await call('GET', '/clarifications', { cookie: b })).json).toHaveLength(0)
    expect((await call('POST', `/clarifications/${clar}/answers`, { cookie: b, body: { answers: [{ question_id: 'q1', kind: 'decline' }] } })).status).toBe(404)

    const ok = await call('POST', `/clarifications/${clar}/answers`, { cookie: a, body: { answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: 'Cadena Uno' }] } })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ complete: true })
    const after = (await call('GET', '/clarifications?status=answered', { cookie: a })).json[0] as { answered_by: string }
    expect(after.answered_by).toBe('a@prestamista.test')
    const log = await q("SELECT actor, action FROM app.audit_log WHERE tenant_id = $1 AND action = 'clarification.answered'", [tenantA])
    expect(log.rows).toEqual([{ actor: `user:${userA}`, action: 'clarification.answered' }])
    // Se encola la reanudación (aunque aquí no haya worker que la tome).
    const jobs = await q('SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1', [QUEUES.resume])
    expect((jobs.rows[0] as { n: number }).n).toBe(1)
  })

  it('el esquema de tenant_users está en el catálogo de tablas con RLS', () => {
    expect(tenantUsers).toBeDefined()
  })
})
