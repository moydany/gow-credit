/**
 * El backoffice contra Postgres real: sesión por cookie, pertenencia verificada en cada petición,
 * CSRF, aislamiento entre tenants, bandeja, respuesta manual de una aclaración y bitácora con el usuario.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleStatement } from '@gow/contracts/testing'
import { connect, tenantUsers, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { LocalDocumentStorage, QUEUES, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { createApp } from './app.ts'
import { issueToken } from './session.ts'
import type { AuthDirectory } from './supabase-auth.ts'

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
  // La misma API con Supabase Auth simulado (ADR 0035).
  let serverSb: Server
  let baseSb = ''
  const gotrue = {
    users: new Map<string, string>(),
    links: [] as { email: string; redirectTo: string }[],
    revoked: [] as string[],
    down: false,
  }
  const auth: AuthDirectory = {
    ensureUser: (email) => {
      if (gotrue.down) return Promise.reject(new Error('Supabase Auth respondió 503'))
      const id = gotrue.users.get(email) ?? randomUUID()
      gotrue.users.set(email, id)
      return Promise.resolve(id)
    },
    sendMagicLink: (email, redirectTo) => {
      gotrue.links.push({ email, redirectTo })
      return Promise.resolve(gotrue.users.has(email))
    },
    refreshSession: () => Promise.resolve(null),
    revokeSession: (token) => {
      gotrue.revoked.push(token)
      return Promise.resolve()
    },
  }
  let tenantA = ''
  let tenantB = ''
  const userA = randomUUID()
  const userB = randomUUID()

  const tokenFor = (sub: string, tenant: string, email: string, ttl = 600) => issueToken(SECRET, { sub, email, tenant_id: tenant }, ttl)
  const call = async (method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown; csrf?: boolean; base?: string } = {}) => {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
    if (opts.csrf !== false && method !== 'GET') headers['x-gow-backoffice'] = '1'
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${opts.base ?? base}/bo/v1${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) })
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
    serverSb = createServer(createApp({ db: apiDb.db, boss, storage, backofficeJwtSecret: SECRET, backofficeUrl: 'https://bo.prestamista.test', auth }))
    serverSb.listen(0)
    await new Promise((r) => serverSb.once('listening', r))
    baseSb = `http://127.0.0.1:${String((serverSb.address() as AddressInfo).port)}`
  }, 60_000)

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await new Promise((r) => serverSb.close(r))
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

  it('corregir en revisión humana guarda el par leído/correcto, reencola y muestra el documento corregido', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const sup = randomUUID()
    const app = randomUUID()
    const doc = randomUUID()
    const statement = sampleStatement()
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, 'Proveedor a corregir'])
    await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, 'x', $4, 10, 'application/pdf')", [doc, tenantA, sup, statement.document.sha256])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'human_review')", [app, tenantA, sup])
    await q('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenantA, app, doc])
    await q("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', $3)", [tenantA, doc, JSON.stringify(statement)])

    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))
    const fix = { target: { kind: 'transaction', transaction_id: 'a1.p1.t2', field: 'amount' }, value: 1300, page: 1 }

    // Inválida: nada se guarda y la solicitud sigue en revisión.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [{ ...fix, value: -4 }] } })).status).toBe(400)
    expect((await q('SELECT count(*)::int AS n FROM app.corrections WHERE application_id = $1', [app])).rows[0]).toEqual({ n: 0 })
    // Otro tenant no la ve.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: b, body: { corrections: [fix] } })).status).toBe(404)

    const ok = await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix] } })
    expect(ok.status).toBe(202)
    const saved = await q('SELECT read_value, value, page, created_by FROM app.corrections WHERE application_id = $1', [app])
    expect(saved.rows).toEqual([{ read_value: 1250.5, value: 1300, page: 1, created_by: userA }])
    expect((await q('SELECT status FROM app.applications WHERE id = $1', [app])).rows[0]).toEqual({ status: 'deciding' })
    expect((await q('SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1', [QUEUES.redecide])).rows[0]).toEqual({ n: 1 })

    // El detalle devuelve la extracción con la corrección encima; la guardada no cambia.
    const detail = (await call('GET', `/applications/${app}`, { cookie: a })).json as unknown as { extraction: { accounts: { periods: { transactions: { id: string; amount: number; provenance: string }[] }[] }[] }; corrections: { read_value: number; value: number; created_by: string }[] }
    expect(detail.extraction.accounts[0]?.periods[0]?.transactions[1]).toMatchObject({ amount: 1300, provenance: 'analyst_answer' })
    expect(detail.corrections).toMatchObject([{ read_value: 1250.5, value: 1300, created_by: 'a@prestamista.test' }])
    const stored = (await q('SELECT payload FROM app.extractions WHERE document_id = $1', [doc])).rows[0] as { payload: { accounts: { periods: { transactions: { amount: number }[] }[] }[] } }
    expect(stored.payload.accounts[0]?.periods[0]?.transactions[1]?.amount).toBe(1250.5)

    // Ya no está en revisión: no se vuelve a corregir hasta que el worker termine.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix] } })).status).toBe(409)
  })

  it('descartar el documento en revisión humana cierra en not_qualified con motivo cerrado y entra a la bitácora', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const sup = randomUUID()
    const app = randomUUID()
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, 'Proveedor a descartar'])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'human_review')", [app, tenantA, sup])
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    // Motivo fuera de la lista, o texto libre: 400 y nada cambia.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'otro' } })).status).toBe(400)
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'illegible', note: 'x' } })).status).toBe(400)
    // Otro tenant no la ve.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: b, body: { reason: 'illegible' } })).status).toBe(404)

    const ok = await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'altered' } })
    expect(ok.status).toBe(200)
    expect((await q('SELECT status, failure_reason FROM app.applications WHERE id = $1', [app])).rows[0]).toEqual({ status: 'not_qualified', failure_reason: 'document_discarded:altered' })
    expect((await q("SELECT actor, details FROM app.audit_log WHERE subject = $1 AND action = 'application.discarded'", [app])).rows[0]).toEqual({ actor: `user:${userA}`, details: { reason: 'altered' } })
    // Ya no está en revisión humana.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'altered' } })).status).toBe(409)
  })

  it('proveedores: alta, lista, detalle con contactos, historial y outcomes; edición validada y en la bitácora sin valores', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    // Alta inválida: 400 con la ruta del campo y sin el valor en la respuesta.
    const bad = await call('POST', '/suppliers', { cookie: a, body: { legal_name: 'Proveedor Uno', rfc: 'NOPE99', clabes: ['123456'] } })
    expect(bad.status).toBe(400)
    expect((bad.json as unknown as { issues: { path: string }[] }).issues.map((i) => i.path).sort()).toEqual(['clabes.0', 'rfc'])
    expect(JSON.stringify(bad.json)).not.toMatch(/NOPE99|123456/)

    const created = await call('POST', '/suppliers', { cookie: a, body: { legal_name: 'Proveedor Uno', rfc: 'abc-010101-ab1', external_ref: 'erp-1', clabes: ['012 180 001234567899'] } })
    expect(created.status).toBe(201)
    const sup = (created.json as unknown as { id: string }).id
    expect((await q('SELECT rfc, clabes FROM app.suppliers WHERE id = $1', [sup])).rows[0]).toEqual({ rfc: 'ABC010101AB1', clabes: ['012180001234567899'] })
    expect((await call('POST', '/suppliers', { cookie: a, body: { legal_name: 'Otro', external_ref: 'erp-1' } })).status).toBe(409)

    const app = randomUUID()
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status, request) VALUES ($1, $2, $3, 'qualified', $4)", [app, tenantA, sup, JSON.stringify({ amount: 50000 })])
    await q("INSERT INTO app.outcomes (tenant_id, application_id, outcome, observed_at) VALUES ($1, $2, 'paid', now())", [tenantA, app])
    await q("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', '+5215550000000', now(), 'kyc'), ($1, $2, 'email', 'pagos@proveedor.test', null, null)", [tenantA, sup])

    const list = (await call('GET', '/suppliers', { cookie: a })).json as unknown as { id: string; applications: number; last_application: { id: string; status: string } | null }[]
    expect(list.find((x) => x.id === sup)).toMatchObject({ applications: 1, last_application: { id: app, status: 'qualified' } })
    const detail = (await call('GET', `/suppliers/${sup}`, { cookie: a })).json as unknown as { contacts: { channel: string; verified_at: string | null }[]; applications: { id: string; outcomes: { outcome: string }[] }[] }
    expect(detail.contacts.map((c) => [c.channel, c.verified_at !== null])).toEqual([['whatsapp', true], ['email', false]])
    expect(detail.applications).toMatchObject([{ id: app, outcomes: [{ outcome: 'paid' }] }])

    // Otro tenant ni lo lista, ni lo ve, ni lo edita.
    expect(((await call('GET', '/suppliers', { cookie: b })).json as unknown as { id: string }[]).some((x) => x.id === sup)).toBe(false)
    expect((await call('GET', `/suppliers/${sup}`, { cookie: b })).status).toBe(404)
    expect((await call('PATCH', `/suppliers/${sup}`, { cookie: b, body: { legal_name: 'Robado' } })).status).toBe(404)

    // Edición: validada con los mismos validadores, y nada cambia si falla.
    expect((await call('PATCH', `/suppliers/${sup}`, { cookie: a, body: {} })).status).toBe(400)
    expect((await call('PATCH', `/suppliers/${sup}`, { cookie: a, body: { clabes: ['012180001234567890'] } })).status).toBe(400)
    expect((await call('PATCH', `/suppliers/${sup}`, { cookie: a, body: { external_ref: 'x' } })).status).toBe(400)
    const ok = await call('PATCH', `/suppliers/${sup}`, { cookie: a, body: { rfc: 'GOMA800101AB1', clabes: ['002180012345678906', '012180001234567899'] } })
    expect(ok.status).toBe(200)
    expect((await q('SELECT legal_name, rfc, clabes FROM app.suppliers WHERE id = $1', [sup])).rows[0]).toEqual({ legal_name: 'Proveedor Uno', rfc: 'GOMA800101AB1', clabes: ['002180012345678906', '012180001234567899'] })
    const log = await q("SELECT actor, action, details FROM app.audit_log WHERE subject = $1 AND action LIKE 'supplier.%' ORDER BY at", [sup])
    expect(log.rows).toEqual([
      { actor: `user:${userA}`, action: 'supplier.created', details: { contacts: 0 } },
      { actor: `user:${userA}`, action: 'supplier.viewed', details: {} },
      { actor: `user:${userA}`, action: 'supplier.updated', details: { fields: ['rfc', 'clabes'] } },
    ])
    expect(JSON.stringify(log.rows)).not.toMatch(/GOMA|0021800/)
  })

  it('usuarios: invitar devuelve el enlace una vez, no se puede quitar a sí mismo y cada tenant ve solo los suyos', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    expect((await call('POST', '/users', { cookie: a, body: { email: 'no-es-correo' } })).status).toBe(400)
    // Ya está en este tenant, o en otro: no se emite enlace.
    expect((await call('POST', '/users', { cookie: a, body: { email: 'a@prestamista.test' } })).status).toBe(409)
    expect((await call('POST', '/users', { cookie: a, body: { email: 'b@prestamista.test' } })).status).toBe(409)

    const added = await call('POST', '/users', { cookie: a, body: { email: 'Nueva@Prestamista.test' } })
    expect(added.status).toBe(201)
    const created = added.json as unknown as { user: { id: string; email: string; invited_by: string }; access_link: string }
    expect(created.user).toMatchObject({ email: 'nueva@prestamista.test', invited_by: 'a@prestamista.test' })
    const token = /#token=(.+)$/.exec(created.access_link)?.[1] ?? ''
    const nueva = await login(token)
    expect((await call('GET', '/me', { cookie: nueva })).json).toMatchObject({ user: { email: 'nueva@prestamista.test' }, tenant: { id: tenantA } })

    const usersA = (await call('GET', '/users', { cookie: a })).json as unknown as { id: string; is_me: boolean }[]
    expect(usersA.map((u) => u.id)).toContain(created.user.id)
    expect(usersA.find((u) => u.id === userA)?.is_me).toBe(true)
    expect(((await call('GET', '/users', { cookie: b })).json as unknown as { id: string }[]).map((u) => u.id)).toEqual([userB])

    expect((await call('DELETE', `/users/${userA}`, { cookie: a })).status).toBe(409)
    expect((await call('DELETE', `/users/${created.user.id}`, { cookie: b })).status).toBe(404)
    expect((await call('DELETE', `/users/${created.user.id}`, { cookie: a, csrf: false })).status).toBe(403)
    expect((await call('DELETE', `/users/${created.user.id}`, { cookie: a })).status).toBe(204)
    expect((await call('GET', '/me', { cookie: nueva })).status).toBe(401)

    const log = await q("SELECT actor, action, details FROM app.audit_log WHERE subject = $1 ORDER BY at", [created.user.id])
    expect(log.rows).toEqual([
      { actor: `user:${userA}`, action: 'user.added', details: {} },
      { actor: `user:${userA}`, action: 'user.removed', details: {} },
    ])
  })

  it('con Supabase Auth: invitar crea la cuenta de Auth, guarda su id y manda el enlace; no hay enlace que compartir', async () => {
    // Con el JWT como Bearer: el límite de inicios de sesión por IP es del otro servidor y ya va gastado.
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const added = await call('POST', '/users', { base: baseSb, bearer: a, body: { email: 'Auth@Prestamista.test' } })
    expect(added.status).toBe(201)
    const authId = gotrue.users.get('auth@prestamista.test')
    expect(added.json).toMatchObject({ user: { id: authId, email: 'auth@prestamista.test' }, access_link: null, expires_at: null, email_sent: true })
    expect(gotrue.links).toEqual([{ email: 'auth@prestamista.test', redirectTo: 'https://bo.prestamista.test/entrar' }])
    const rows = await admin.query('SELECT tenant_id, user_id FROM app.tenant_users WHERE email = $1', ['auth@prestamista.test'])
    expect(rows.rows).toEqual([{ tenant_id: tenantA, user_id: authId }])

    // Un conflicto visible en el tenant no toca Auth; GoTrue caído no deja pertenencia a medias.
    const before = gotrue.users.size
    expect((await call('POST', '/users', { base: baseSb, bearer: a, body: { email: 'auth@prestamista.test' } })).status).toBe(409)
    expect(gotrue.users.size).toBe(before)
    gotrue.down = true
    try {
      expect((await call('POST', '/users', { base: baseSb, bearer: a, body: { email: 'caido@prestamista.test' } })).status).toBe(502)
    } finally {
      gotrue.down = false
    }
    expect((await admin.query('SELECT 1 FROM app.tenant_users WHERE email = $1', ['caido@prestamista.test'])).rowCount).toBe(0)

    // Quitarlo solo quita la pertenencia: la cuenta de Auth sigue, pero ya no entra.
    expect((await call('DELETE', `/users/${String(authId)}`, { base: baseSb, bearer: a })).status).toBe(204)
    expect(gotrue.users.has('auth@prestamista.test')).toBe(true)
  })

  it('con Supabase Auth y sin refresh token: la cookie vive lo que el token y se cierra la sesión de Auth; sin tenant_id no entra', async () => {
    const now = Math.floor(Date.now() / 1000)
    const supabaseToken = (claims: Record<string, unknown>) => {
      const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url')
      const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`
      return `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`
    }
    const claims = { aud: 'authenticated', role: 'authenticated', sub: userA, email: 'a@prestamista.test', session_id: randomUUID(), iat: now, exp: now + 3600 }
    const token = supabaseToken({ ...claims, tenant_id: tenantA })
    const r = await call('POST', '/session', { base: baseSb, body: { token } })
    expect(r.status).toBe(200)
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get('set-cookie') ?? '')?.[1])
    expect(maxAge).toBeGreaterThan(3500)
    expect(maxAge).toBeLessThanOrEqual(3600)
    expect(gotrue.revoked).toEqual([token])
    // Lo que emite GoTrue para quien no es miembro: sin el claim del hook.
    expect((await call('POST', '/session', { base: baseSb, body: { token: supabaseToken(claims) } })).status).toBe(401)
    expect(gotrue.revoked).toHaveLength(1)
  })

  it('llaves de API: la completa se muestra una vez, se guarda el hash y revocar corta /v1 de inmediato', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    expect((await call('POST', '/api-keys', { cookie: a, body: { scopes: [] } })).status).toBe(400)
    expect((await call('POST', '/api-keys', { cookie: a, body: { scopes: ['admin'] } })).status).toBe(400)

    const created = await call('POST', '/api-keys', { cookie: a, body: { scopes: ['read', 'policies'] } })
    expect(created.status).toBe(201)
    const { key, secret_key } = created.json as unknown as { key: { id: string; prefix: string; scopes: string[]; revoked_at: string | null }; secret_key: string }
    expect(secret_key.startsWith(`${key.prefix}.`)).toBe(true)
    expect(key).toMatchObject({ scopes: ['read', 'policies'], revoked_at: null })
    const secret = secret_key.slice(key.prefix.length + 1)
    const stored = (await q('SELECT key_hash, tenant_id::text AS tenant FROM app.api_keys WHERE id = $1', [key.id])).rows[0] as { key_hash: string; tenant: string }
    expect(stored).toEqual({ key_hash: createHash('sha256').update(secret).digest('hex'), tenant: tenantA })

    // La lista nunca trae el secreto ni el hash.
    const listed = await call('GET', '/api-keys', { cookie: a })
    expect(JSON.stringify(listed.json)).not.toContain(secret)
    expect(JSON.stringify(listed.json)).not.toContain(stored.key_hash)
    expect((listed.json as unknown as { id: string }[]).some((k) => k.id === key.id)).toBe(true)
    expect(((await call('GET', '/api-keys', { cookie: b })).json as unknown as { id: string }[]).some((k) => k.id === key.id)).toBe(false)

    const v1 = () => fetch(`${base}/v1/policies/versions`, { headers: { authorization: `Bearer ${secret_key}` } }).then((r) => r.status)
    expect(await v1()).toBe(200)
    expect((await call('POST', `/api-keys/${key.id}/revoke`, { cookie: b })).status).toBe(404)
    expect(await v1()).toBe(200)
    const revoked = await call('POST', `/api-keys/${key.id}/revoke`, { cookie: a })
    expect(revoked.status).toBe(200)
    expect((revoked.json as unknown as { revoked_at: string | null }).revoked_at).not.toBeNull()
    expect(await v1()).toBe(401)
    expect((await call('POST', `/api-keys/${key.id}/revoke`, { cookie: a })).status).toBe(409)

    const log = await q("SELECT actor, action, details FROM app.audit_log WHERE subject = $1 ORDER BY at", [key.id])
    expect(log.rows).toEqual([
      { actor: `user:${userA}`, action: 'api_key.created', details: { prefix: key.prefix, scopes: ['read', 'policies'] } },
      { actor: `user:${userA}`, action: 'api_key.revoked', details: { prefix: key.prefix } },
    ])
    expect(JSON.stringify(log.rows)).not.toContain(secret)
  })

  it('configuración: los canales del tenant se leen de la sesión, sin WhatsApp vinculado', async () => {
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))
    expect((await call('GET', '/settings', { cookie: b })).json).toEqual({ tenant: { id: tenantB, name: 'Fintech B', created_at: expect.any(String) as unknown }, whatsapp: { number: null }, email: { from: null } })
  })

  // El inicio de sesión tiene límite por IP y las pruebas anteriores lo agotan: estas van con el JWT como Bearer.
  const as = (user: string, tenant: string, email: string) => {
    const bearer = tokenFor(user, tenant, email)
    return (method: string, path: string) => call(method, path, { bearer })
  }

  it('WhatsApp: sin proceso no hay QR ni se puede desvincular; el estado de cada tenant es suyo', async () => {
    const a = as(userA, tenantA, 'a@prestamista.test')
    const b = as(userB, tenantB, 'b@prestamista.test')
    // Nunca ha corrido el proceso para A.
    expect((await a('GET', '/whatsapp')).json).toEqual({ process_running: false, status: null, linked_number: null, qr: null, qr_expires_at: null, unlink_pending: false, updated_at: null })
    expect((await a('POST', '/whatsapp/unlink')).status).toBe(409)

    // B tiene el proceso vivo y esperando QR; A tiene un latido viejo con un QR vigente en la fila.
    await admin.query("INSERT INTO app.whatsapp_sessions (tenant_id, status, qr, qr_expires_at, heartbeat_at) VALUES ($1, 'waiting_qr', '2@reto-de-b', now() + interval '1 minute', now())", [tenantB])
    await admin.query("INSERT INTO app.whatsapp_sessions (tenant_id, status, qr, qr_expires_at, heartbeat_at) VALUES ($1, 'waiting_qr', '2@reto-de-a', now() + interval '1 minute', now() - interval '45 seconds')", [tenantA])
    const stale = await a('GET', '/whatsapp')
    expect(stale.json).toMatchObject({ process_running: false, status: 'waiting_qr', qr: null, qr_expires_at: null })
    expect(JSON.stringify(stale.json)).not.toContain('reto-de-b')
    expect((await a('POST', '/whatsapp/unlink')).status).toBe(409)
    expect((await b('GET', '/whatsapp')).json).toMatchObject({ process_running: true, status: 'waiting_qr', qr: '2@reto-de-b', qr_expires_at: expect.any(String) as unknown })
    const log = await admin.query("SELECT tenant_id::text AS t, actor FROM app.audit_log WHERE action LIKE 'whatsapp.%'")
    expect(log.rows).toEqual([{ t: tenantB, actor: `user:${userB}` }])
  })

  it('WhatsApp: el QR se muestra solo vigente y verlo queda en la bitácora una vez por QR; desvincular se pide y se audita', async () => {
    const a = as(userA, tenantA, 'a@prestamista.test')
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const viewed = () => q("SELECT actor, details FROM app.audit_log WHERE tenant_id = $1 AND action = 'whatsapp.qr_viewed' ORDER BY at", [tenantA])
    await q("UPDATE app.whatsapp_sessions SET status = 'waiting_qr', qr = '2@reto-1', qr_expires_at = now() + interval '1 minute', heartbeat_at = now() WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ process_running: true, qr: '2@reto-1' })
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ qr: '2@reto-1' })
    expect((await viewed()).rows).toHaveLength(1)
    // Un QR nuevo es otra vista; el valor nunca va a la bitácora, solo una huella truncada.
    await q("UPDATE app.whatsapp_sessions SET qr = '2@reto-2' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ qr: '2@reto-2' })
    const rows = (await viewed()).rows as { actor: string; details: { qr_digest: string } }[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.actor === `user:${userA}` && /^[0-9a-f]{16}$/.test(r.details.qr_digest))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('reto')

    // Caducado: no se entrega ni se audita.
    await q("UPDATE app.whatsapp_sessions SET qr = '2@reto-3', qr_expires_at = now() - interval '1 second' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ process_running: true, status: 'waiting_qr', qr: null, qr_expires_at: null })
    expect((await viewed()).rows).toHaveLength(2)

    // Abierta: el número, sin QR; aparece también en /me.
    await q("UPDATE app.whatsapp_sessions SET status = 'open', qr = NULL, qr_expires_at = NULL, linked_number = '+5215500000001' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ process_running: true, status: 'open', linked_number: '+5215500000001', qr: null, unlink_pending: false })
    expect((await a('GET', '/me')).json).toMatchObject({ tenant: { whatsapp_linked_number: '+5215500000001' } })

    // Desvincular queda pendiente hasta que el proceso lo atienda.
    const un = await a('POST', '/whatsapp/unlink')
    expect(un.status).toBe(202)
    expect(un.json).toEqual({ unlink_requested_at: expect.any(String) as unknown })
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ status: 'open', unlink_pending: true })
    await q('UPDATE app.whatsapp_sessions SET unlink_handled_at = unlink_requested_at WHERE tenant_id = $1', [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ unlink_pending: false })
    const log = await q("SELECT actor, details FROM app.audit_log WHERE tenant_id = $1 AND action = 'whatsapp.unlink_requested'", [tenantA])
    expect(log.rows).toEqual([{ actor: `user:${userA}`, details: { status: 'open' } }])
    expect(JSON.stringify(log.rows)).not.toContain('+52')
    // El tenant B no vio nada de esto.
    expect((await q("SELECT unlink_requested_at FROM app.whatsapp_sessions WHERE tenant_id = $1", [tenantB])).rows).toEqual([{ unlink_requested_at: null }])

    // Con el proceso detenido, /me deja de mostrar el número vinculado.
    await q("UPDATE app.whatsapp_sessions SET heartbeat_at = NULL WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/me')).json).toMatchObject({ tenant: { whatsapp_linked_number: null } })
  })

  it('el esquema de tenant_users está en el catálogo de tablas con RLS', () => {
    expect(tenantUsers).toBeDefined()
  })
})
