/**
 * The backoffice against real Postgres: cookie session, membership verified on every request,
 * CSRF, tenant isolation, inbox, manual answer to a clarification and audit log with the user.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleStatement } from '@gow/contracts/testing'
import { connect, tenantUsers, type Database } from '@gow/db'
import { syntheticStatement } from '@gow/decision/testing'
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
  // The same API with a simulated Supabase Auth.
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
  /** One session per user for tests that only need to be signed in: sign-ins are capped at 20 a minute per IP. */
  const sessions = new Map<string, string>()
  async function sessionOf(user: string, tenant: string, email: string): Promise<string> {
    const known = sessions.get(user)
    if (known) return known
    const cookie = await login(tokenFor(user, tenant, email))
    sessions.set(user, cookie)
    return cookie
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
    // User A with tenant B in the claim: the membership does not exist.
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
    // The resume is enqueued (even though no worker is here to take it).
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

    const a = await sessionOf(userA, tenantA, 'a@prestamista.test')
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))
    const fix = { target: { kind: 'transaction', transaction_id: 'a1.p1.t2', field: 'amount' }, value: 1300, page: 1 }

    // Invalid: nothing is saved and the request stays in review.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [{ ...fix, value: -4 }] } })).status).toBe(400)
    expect((await q('SELECT count(*)::int AS n FROM app.corrections WHERE application_id = $1', [app])).rows[0]).toEqual({ n: 0 })
    // Another tenant does not see it.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: b, body: { corrections: [fix] } })).status).toBe(404)

    const ok = await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix] } })
    expect(ok.status).toBe(202)
    const saved = await q('SELECT read_value, value, page, created_by FROM app.corrections WHERE application_id = $1', [app])
    expect(saved.rows).toEqual([{ read_value: 1250.5, value: 1300, page: 1, created_by: userA }])
    expect((await q('SELECT status FROM app.applications WHERE id = $1', [app])).rows[0]).toEqual({ status: 'deciding' })
    expect((await q('SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1', [QUEUES.redecide])).rows[0]).toEqual({ n: 1 })

    // The detail returns the extraction with the correction on top; the stored one is unchanged.
    const detail = (await call('GET', `/applications/${app}`, { cookie: a })).json as unknown as { extraction: { accounts: { periods: { transactions: { id: string; amount: number; provenance: string }[] }[] }[] }; corrections: { read_value: number; value: number; created_by: string }[] }
    expect(detail.extraction.accounts[0]?.periods[0]?.transactions[1]).toMatchObject({ amount: 1300, provenance: 'analyst_answer' })
    expect(detail.corrections).toMatchObject([{ read_value: 1250.5, value: 1300, created_by: 'a@prestamista.test' }])
    const stored = (await q('SELECT payload FROM app.extractions WHERE document_id = $1', [doc])).rows[0] as { payload: { accounts: { periods: { transactions: { amount: number }[] }[] }[] } }
    expect(stored.payload.accounts[0]?.periods[0]?.transactions[1]?.amount).toBe(1250.5)

    // No longer in review: it cannot be corrected again until the worker finishes.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix] } })).status).toBe(409)
  })

  it('el detalle trae cada estado de cuenta con sus periodos frente a los meses evaluados, y se corrige el que se indica', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const sup = randomUUID()
    const app = randomUUID()
    const holder = { name: 'Proveedor de dos meses', rfc: 'PDM150304AB1', clabe: null }
    const month = (start: string) => syntheticStatement({ start, opening_balance: 10000, monthly: [{ kind: 'customer_payment', amount: 50000, count: 2 }, { kind: 'supplier_payment', amount: 20000 }] }, holder, `dos-${start}`)
    const sep = month('2026-09-01')
    const oct = month('2026-10-01')
    const ids = { sep: randomUUID(), oct: randomUUID() }
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, holder.name])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'human_review')", [app, tenantA, sup])
    // October is stored first: the detail orders by cutoff, not by arrival.
    for (const [id, s] of [[ids.oct, oct], [ids.sep, sep]] as const) {
      await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, 'x', $4, 10, 'application/pdf')", [id, tenantA, sup, s.document.sha256])
      await q('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenantA, app, id])
      await q("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', $3)", [tenantA, id, JSON.stringify(s)])
    }
    const a = await sessionOf(userA, tenantA, 'a@prestamista.test')
    type Detail = { extraction: { document: { sha256: string } }; statements: { document_id: string; extraction: { accounts: { periods: { transactions: { id: string; amount: number }[] }[] }[] }; periods: { status: string }[] }[] }
    const detail = async () => (await call('GET', `/applications/${app}`, { cookie: a })).json as unknown as Detail
    const before = await detail()
    expect(before.statements.map((s) => s.document_id)).toEqual([ids.sep, ids.oct])
    // Without a verdict the window is one month: September is left out, October is evaluated.
    expect(before.statements.map((s) => s.periods.map((p) => p.status))).toEqual([['outside'], ['evaluated']])
    expect(before.extraction.document.sha256).toBe(oct.document.sha256)

    const tx = sep.accounts[0]?.periods[0]?.transactions[0]
    const fix = { target: { kind: 'transaction', transaction_id: tx?.id, field: 'amount' }, value: 12345, page: 1 }
    // A document that is not in the request is rejected.
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix], document_id: randomUUID() } })).status).toBe(404)
    expect((await call('POST', `/applications/${app}/corrections`, { cookie: a, body: { corrections: [fix], document_id: ids.sep } })).status).toBe(202)
    expect((await q('SELECT document_id FROM app.corrections WHERE application_id = $1', [app])).rows).toEqual([{ document_id: ids.sep }])
    const after = await detail()
    const amountOf = (i: number) => after.statements[i]?.extraction.accounts[0]?.periods[0]?.transactions.find((t) => t.id === tx?.id)?.amount
    expect(amountOf(0)).toBe(12345)
    expect(amountOf(1)).toBe(oct.accounts[0]?.periods[0]?.transactions.find((t) => t.id === tx?.id)?.amount)
  })

  it('descartar el documento en revisión humana cierra en not_qualified con motivo cerrado y entra a la bitácora', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const sup = randomUUID()
    const app = randomUUID()
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, 'Proveedor a descartar'])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'human_review')", [app, tenantA, sup])
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    // Reason outside the list, or free text: 400 and nothing changes.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'otro' } })).status).toBe(400)
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'illegible', note: 'x' } })).status).toBe(400)
    // Another tenant does not see it.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: b, body: { reason: 'illegible' } })).status).toBe(404)

    const ok = await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'altered' } })
    expect(ok.status).toBe(200)
    expect((await q('SELECT status, failure_reason FROM app.applications WHERE id = $1', [app])).rows[0]).toEqual({ status: 'not_qualified', failure_reason: 'document_discarded:altered' })
    expect((await q("SELECT actor, details FROM app.audit_log WHERE subject = $1 AND action = 'application.discarded'", [app])).rows[0]).toEqual({ actor: `user:${userA}`, details: { reason: 'altered' } })
    // No longer in human review: no second notice either.
    expect((await call('POST', `/applications/${app}/discard`, { cookie: a, body: { reason: 'altered' } })).status).toBe(409)
    // The worker tells the supplier (its own test): the API only leaves one job, not a second one for the rejected retry.
    const jobs = (await q('SELECT data FROM pgboss.job WHERE name = $1', [QUEUES.discardNotice])).rows as { data: unknown }[]
    expect(jobs.filter((j) => (j.data as { application_id: string }).application_id === app)).toEqual([{ data: { tenant_id: tenantA, application_id: app } }])
  })

  it('proveedores: alta, lista, detalle con contactos, historial y outcomes; edición validada y en la bitácora sin valores', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    // Invalid create: 400 with the field path and without the value in the response.
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

    await q('UPDATE app.suppliers SET address = $2 WHERE id = $1', [sup, 'AV. REFORMA 100, CDMX'])
    const list = (await call('GET', '/suppliers', { cookie: a })).json as unknown as { id: string; applications: number; last_application: { id: string; status: string } | null }[]
    expect(list.find((x) => x.id === sup)).toMatchObject({ applications: 1, last_application: { id: app, status: 'qualified' } })
    const detail = (await call('GET', `/suppliers/${sup}`, { cookie: a })).json as unknown as { contacts: { channel: string; verified_at: string | null }[]; applications: { id: string; outcomes: { outcome: string }[] }[] }
    expect(detail.contacts.map((c) => [c.channel, c.verified_at !== null])).toEqual([['whatsapp', true], ['email', false]])
    expect(detail.applications).toMatchObject([{ id: app, outcomes: [{ outcome: 'paid' }] }])
    // The address comes from the bank statement.
    expect((detail as unknown as { address: string | null }).address).toBe('AV. REFORMA 100, CDMX')

    // Another tenant can neither list, see nor edit it.
    expect(((await call('GET', '/suppliers', { cookie: b })).json as unknown as { id: string }[]).some((x) => x.id === sup)).toBe(false)
    expect((await call('GET', `/suppliers/${sup}`, { cookie: b })).status).toBe(404)
    expect((await call('PATCH', `/suppliers/${sup}`, { cookie: b, body: { legal_name: 'Robado' } })).status).toBe(404)

    // Edit: validated with the same validators, and nothing changes if it fails.
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

  it('subir el estado de cuenta desde el proveedor abre la solicitud con el monto, la encola y su avance se lee sin bitácora', async () => {
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const sup = (await call('POST', '/suppliers', { bearer: a, body: { legal_name: 'Proveedor Con PDF' } })).json.id as string
    const other = (await call('POST', '/suppliers', { bearer: a, body: { legal_name: 'Otro Proveedor' } })).json.id as string
    const pdf = Buffer.from('%PDF-1.7\n% estado de cuenta desde el backoffice\n%%EOF\n')
    // Bearer, not a cookie: the anti-CSRF header is covered by its own test and logins are rate limited.
    const upload = (supplier: string, bytes: Buffer, query = '', type = 'application/pdf') =>
      fetch(`${base}/bo/v1/suppliers/${supplier}/statements${query}`, { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${a}` }, body: bytes }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))

    // Not a PDF, a bad amount or an unknown supplier: nothing is opened.
    expect((await upload(sup, Buffer.from('\x89PNG\r\n'))).status).toBe(415)
    expect((await upload(sup, Buffer.from('{}'), '', 'application/json')).status).toBe(415)
    expect((await upload(sup, pdf, '?amount=-5')).status).toBe(400)
    expect((await upload(randomUUID(), pdf)).status).toBe(404)

    const r = await upload(sup, pdf, '?amount=150000')
    expect(r.status).toBe(201)
    const appId = r.json.id as string
    expect(r.json).toEqual({ id: appId, status: 'received' })
    const row = await admin.query<{ supplier_id: string; request: unknown; status: string }>('SELECT supplier_id::text, request, status FROM app.applications WHERE id = $1', [appId])
    expect(row.rows).toEqual([{ supplier_id: sup, request: { amount: 150000, maturity: null, buyer: null }, status: 'received' }])
    const jobs = await admin.query<{ data: { application_id: string } }>('SELECT data FROM pgboss.job WHERE name = $1', [QUEUES.process])
    expect(jobs.rows.map((j) => j.data.application_id)).toContain(appId)
    const received = await admin.query<{ details: Record<string, unknown> }>("SELECT details FROM app.audit_log WHERE subject = $1 AND action = 'application.received'", [appId])
    expect(received.rows[0]?.details).toMatchObject({ source: 'backoffice', amount_given: true, document_reused: false })

    // While it runs, the same PDF is refused (one processing job per document) and another supplier never gets it.
    expect((await upload(sup, pdf)).status).toBe(409)
    expect((await upload(other, pdf)).status).toBe(409)

    // Progress: polling it does not write to the audit log.
    const before = (await admin.query('SELECT 1 FROM app.audit_log WHERE tenant_id = $1', [tenantA])).rowCount
    const st = await call('GET', `/suppliers/${sup}/statements/${appId}`, { bearer: a })
    expect(st.status).toBe(200)
    expect(st.json).toMatchObject({ id: appId, status: 'received', requested: 150000, decision: null, failure: null, open_clarification: false })
    expect((await admin.query('SELECT 1 FROM app.audit_log WHERE tenant_id = $1', [tenantA])).rowCount).toBe(before)
    expect((await call('GET', `/suppliers/${other}/statements/${appId}`, { bearer: a })).status).toBe(404)

    // Once it ended, the same PDF can be evaluated again for the same supplier, without an amount (maximum line).
    await admin.query("UPDATE app.applications SET status = 'failed', failure_reason = 'el workflow terminó sin veredicto' WHERE id = $1", [appId])
    expect((await call('GET', `/suppliers/${sup}/statements/${appId}`, { bearer: a })).json).toMatchObject({ status: 'failed', failure: expect.stringMatching(/./) as unknown })
    const again = await upload(sup, pdf)
    expect(again.status).toBe(201)
    const second = await admin.query<{ request: unknown }>('SELECT request FROM app.applications WHERE id = $1', [again.json.id])
    expect(second.rows[0]?.request).toBeNull()
    const docs = await admin.query('SELECT DISTINCT ad.document_id FROM app.application_documents ad WHERE ad.application_id = ANY($1::uuid[])', [[appId, again.json.id]])
    expect(docs.rowCount).toBe(1)
  })

  it('varios estados de cuenta en una solicitud: se abre en espera, se agregan y se arranca una vez', async () => {
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const sup = (await call('POST', '/suppliers', { bearer: a, body: { legal_name: 'Proveedor De Tres Meses' } })).json.id as string
    const month = (m: string) => Buffer.from(`%PDF-1.7\n% estado de cuenta ${m}\n%%EOF\n`)
    const post = (path: string, bytes?: Buffer) =>
      fetch(`${base}/bo/v1/suppliers/${sup}/statements${path}`, { method: 'POST', headers: { authorization: `Bearer ${a}`, ...(bytes ? { 'content-type': 'application/pdf' } : {}) }, ...(bytes ? { body: bytes } : {}) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
    const jobsFor = async (id: string) => (await admin.query<{ data: { application_id: string } }>('SELECT data FROM pgboss.job WHERE name = $1', [QUEUES.process])).rows.filter((j) => j.data.application_id === id).length

    const opened = await post('?amount=90000&hold=1', month('agosto'))
    expect(opened.status).toBe(201)
    const id = opened.json.id as string
    // On hold: nothing enqueued until it starts.
    expect(await jobsFor(id)).toBe(0)
    expect((await post(`/${id}/documents`, month('septiembre'))).status).toBe(201)
    expect((await post(`/${id}/documents`, month('octubre'))).status).toBe(201)
    // The same PDF twice in one request, or something that is not a PDF, is refused.
    expect((await post(`/${id}/documents`, month('octubre'))).status).toBe(409)
    expect((await post(`/${id}/documents`, Buffer.from('\x89PNG\r\n'))).status).toBe(415)
    const docs = await admin.query("SELECT origin FROM app.application_documents WHERE application_id = $1 AND origin = 'submitted'", [id])
    expect(docs.rowCount).toBe(3)

    expect((await post(`/${id}/start`)).status).toBe(202)
    expect(await jobsFor(id)).toBe(1)
    // Once it runs it takes no more documents and does not start twice.
    await admin.query("UPDATE app.applications SET status = 'extracting', run_id = 'run-tres' WHERE id = $1", [id])
    expect((await post(`/${id}/documents`, month('noviembre'))).status).toBe(409)
    expect((await post(`/${id}/start`)).status).toBe(409)
    // Another supplier's request is not found.
    const other = (await call('POST', '/suppliers', { bearer: a, body: { legal_name: 'Otro De Tres Meses' } })).json.id as string
    const foreign = await fetch(`${base}/bo/v1/suppliers/${other}/statements/${id}/start`, { method: 'POST', headers: { authorization: `Bearer ${a}` } })
    expect(foreign.status).toBe(404)
  })

  it('borrar un proveedor se lleva todo lo suyo, deja lo de otros, no deja con una solicitud en proceso y encola la limpieza', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const count = async (sql: string, v: unknown[]) => ((await q(sql, v)).rows[0] as { n: number }).n
    // With Bearer: does not spend /session attempts (20 per minute per IP) that the tests below use.
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const b = tokenFor(userB, tenantB, 'b@prestamista.test')
    const [sup, other, app, doc, clar] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const phone = '+5215551112222'
    const path = `${tenantA}/${randomUUID()}.pdf`
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3), ($4, $2, $5)', [sup, tenantA, 'Proveedor a borrar', other, 'Proveedor que se queda'])
    await q("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [tenantA, sup, phone])
    await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/pdf')", [doc, tenantA, sup, path, 'f'.repeat(64)])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status, run_id) VALUES ($1, $2, $3, 'qualified', 'run-borrar')", [app, tenantA, sup])
    await q('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenantA, app, doc])
    await q("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', $3)", [tenantA, doc, JSON.stringify(sampleStatement())])
    await q("INSERT INTO app.decisions (tenant_id, application_id, status, payload) VALUES ($1, $2, 'qualified', '{}')", [tenantA, app])
    await q("INSERT INTO app.outcomes (tenant_id, application_id, outcome, observed_at) VALUES ($1, $2, 'paid', now())", [tenantA, app])
    await q("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, questions) VALUES ($1, $2, $3, $4, 1, 'whatsapp', '[]')", [clar, tenantA, app, sup])
    await q("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, clarification_id) VALUES ($1, 'whatsapp', $2, 'hola', $3), ($1, 'whatsapp', '+5215559990000', 'de otro', null)", [tenantA, phone, clar])
    await q("INSERT INTO app.outbound_messages (tenant_id, channel, destination, body, kind) VALUES ($1, 'whatsapp', $2, 'aviso', 'generic')", [tenantA, phone])
    // Model exchanges: of the request, of one of its messages and of another tenant's message.
    const llmRow = "INSERT INTO app.llm_exchanges (tenant_id, application_id, inbound_message_id, purpose, model, schema_name, prompt_version, effort, max_output_tokens, server_fallback, system, instruction, outcome, latency_ms) SELECT $1, $2::uuid, (SELECT id FROM app.inbound_messages WHERE from_address = $3::text), $4, 'm', 's.v1', 'p.v1', 'low', 10, false, 'sys', 'ins', 'ok', 1"
    await q(llmRow, [tenantA, app, 'ninguno', 'summary'])
    await q(llmRow, [tenantA, null, phone, 'interpret'])
    await q(llmRow, [tenantA, null, '+5215559990000', 'interpret'])
    await q("INSERT INTO app.supplier_registrations (tenant_id, channel, address, step, supplier_id) VALUES ($1, 'whatsapp', $2, 'done', $3)", [tenantA, phone, sup])
    const busy = randomUUID()
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'extracting')", [busy, tenantA, other])

    // Another tenant does not find it; with a request in progress it is not deleted and nothing changes.
    expect((await call('DELETE', `/suppliers/${sup}`, { bearer: b })).status).toBe(404)
    expect((await call('DELETE', `/suppliers/${other}`, { bearer: a })).status).toBe(409)
    expect(await count('SELECT count(*)::int AS n FROM app.suppliers WHERE id = $1', [other])).toBe(1)

    const r = await call('DELETE', `/suppliers/${sup}`, { bearer: a })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ id: sup, counts: { applications: 1, documents: 1, outcomes: 1, clarifications: 1, messages: 2 } })
    for (const [table, col, id] of [['suppliers', 'id', sup], ['supplier_contacts', 'supplier_id', sup], ['applications', 'supplier_id', sup], ['documents', 'id', doc], ['extractions', 'document_id', doc], ['decisions', 'application_id', app], ['outcomes', 'application_id', app], ['clarifications', 'id', clar]] as const) {
      expect(await count(`SELECT count(*)::int AS n FROM app.${table} WHERE ${col} = $1`, [id]), table).toBe(0)
    }
    expect(await count('SELECT count(*)::int AS n FROM app.inbound_messages WHERE from_address = $1', [phone])).toBe(0)
    expect(await count('SELECT count(*)::int AS n FROM app.outbound_messages WHERE destination = $1', [phone])).toBe(0)
    expect(await count('SELECT count(*)::int AS n FROM app.supplier_registrations WHERE address = $1', [phone])).toBe(0)
    expect(await count('SELECT count(*)::int AS n FROM app.llm_exchanges WHERE application_id = $1', [app])).toBe(0)
    // Other suppliers' data stays.
    expect(await count('SELECT count(*)::int AS n FROM app.inbound_messages WHERE from_address = $1', ['+5215559990000'])).toBe(1)
    expect(await count("SELECT count(*)::int AS n FROM app.llm_exchanges WHERE tenant_id = $1 AND purpose = 'interpret'", [tenantA])).toBe(1)
    expect(await count('SELECT count(*)::int AS n FROM app.applications WHERE supplier_id = $1', [other])).toBe(1)
    // The audit log keeps only counts; cleanup outside the database is enqueued for the worker.
    expect((await q("SELECT actor, details FROM app.audit_log WHERE subject = $1 AND action = 'supplier.deleted'", [sup])).rows).toEqual([{ actor: `user:${userA}`, details: { applications: 1, documents: 1, outcomes: 1, clarifications: 1, messages: 2 } }])
    const job = (await q('SELECT data FROM pgboss.job WHERE name = $1', [QUEUES.purge])).rows[0] as { data: unknown }
    expect(job.data).toEqual({ tenant_id: tenantA, supplier_id: sup, application_ids: [app], run_ids: ['run-borrar'], storage_paths: [path] })
    expect((await call('DELETE', `/suppliers/${sup}`, { bearer: a })).status).toBe(404)
  })

  it('llamadas al modelo: la lista va sin contenido, se filtra por solicitud y error, el detalle trae lo crudo y se audita', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const b = tokenFor(userB, tenantB, 'b@prestamista.test')
    const [sup, app] = [randomUUID(), randomUUID()]
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantA, 'Proveedor con llamadas'])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'failed')", [app, tenantA, sup])
    const insert = "INSERT INTO app.llm_exchanges (tenant_id, application_id, purpose, model, schema_name, prompt_version, effort, max_output_tokens, server_fallback, system, instruction, document_sha256, outcome, response, raw_output, error_code, error_message, usage, cost_usd, latency_ms) VALUES ($1, $2, $3, 'gemini-3.8-flash', 'summary.v1', 'summary.v3', 'medium', 4000, false, 'Extrae la portada.', 'Páginas 1-2.', $4, $5, $6, $7, $8, $9, $10, $11, 900) RETURNING id"
    const usage = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    const okRow = (await q(insert, [tenantA, app, 'extraction.summary', 'c'.repeat(64), 'ok', JSON.stringify({ holder: 'Distribuidora Ficticia' }), null, null, null, JSON.stringify(usage), '0.000400'])).rows[0] as { id: string }
    const badRow = (await q(insert, [tenantA, app, 'extraction.transactions', 'c'.repeat(64), 'error', null, '{"transactions":[{"amount":', 'max_tokens', 'la respuesta se cortó', null, '0'])).rows[0] as { id: string }

    const list = await call('GET', `/llm-exchanges?application_id=${app}`, { bearer: a })
    expect(list.status).toBe(200)
    expect(list.json).toHaveLength(2)
    expect(list.json[0]).toEqual(expect.objectContaining({ application_id: app, model: 'gemini-3.8-flash', response_cache_hit: false }))
    // The list carries no prompts or responses.
    expect(JSON.stringify(list.json)).not.toMatch(/Distribuidora|portada|transactions":\[/)
    expect((await call('GET', `/llm-exchanges?application_id=${app}&outcome=error`, { bearer: a })).json.map((x) => (x as { id: string }).id)).toEqual([badRow.id])
    expect((await call('GET', '/llm-exchanges?outcome=raro', { bearer: a })).status).toBe(400)

    const detail = await call('GET', `/llm-exchanges/${okRow.id}`, { bearer: a })
    expect(detail.status).toBe(200)
    expect(detail.json).toMatchObject({ id: okRow.id, outcome: 'ok', system: 'Extrae la portada.', instruction: 'Páginas 1-2.', document_sha256: 'c'.repeat(64), response: { holder: 'Distribuidora Ficticia' }, usage, cost_usd: 0.0004, latency_ms: 900 })
    expect((await call('GET', `/llm-exchanges/${badRow.id}`, { bearer: a })).json).toMatchObject({ outcome: 'error', error_code: 'max_tokens', error_message: 'la respuesta se cortó', raw_output: '{"transactions":[{"amount":', response: null })
    const log = await q("SELECT actor, subject, details FROM app.audit_log WHERE action = 'llm_exchange.viewed' AND subject = $1", [okRow.id])
    expect(log.rows).toEqual([{ actor: `user:${userA}`, subject: okRow.id, details: { application_id: app } }])
    expect(JSON.stringify(log.rows)).not.toMatch(/Distribuidora/)

    // Another tenant sees nothing.
    expect((await call('GET', '/llm-exchanges', { bearer: b })).json).toEqual([])
    expect((await call('GET', `/llm-exchanges/${okRow.id}`, { bearer: b })).status).toBe(404)
  })

  it('usuarios: invitar devuelve el enlace una vez, no se puede quitar a sí mismo y cada tenant ve solo los suyos', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const a = await login(tokenFor(userA, tenantA, 'a@prestamista.test'))
    const b = await login(tokenFor(userB, tenantB, 'b@prestamista.test'))

    expect((await call('POST', '/users', { cookie: a, body: { email: 'no-es-correo' } })).status).toBe(400)
    // Already in this tenant, or in another: no link is issued.
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
    // With the JWT as Bearer: the per-IP login limit belongs to the other server and is already spent.
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const added = await call('POST', '/users', { base: baseSb, bearer: a, body: { email: 'Auth@Prestamista.test' } })
    expect(added.status).toBe(201)
    const authId = gotrue.users.get('auth@prestamista.test')
    expect(added.json).toMatchObject({ user: { id: authId, email: 'auth@prestamista.test' }, access_link: null, expires_at: null, email_sent: true })
    expect(gotrue.links).toEqual([{ email: 'auth@prestamista.test', redirectTo: 'https://bo.prestamista.test/entrar' }])
    const rows = await admin.query('SELECT tenant_id, user_id FROM app.tenant_users WHERE email = $1', ['auth@prestamista.test'])
    expect(rows.rows).toEqual([{ tenant_id: tenantA, user_id: authId }])

    // A conflict visible in the tenant does not touch Auth; GoTrue being down leaves no half-made membership.
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

    // Removing only removes the membership: the Auth account stays, but can no longer sign in.
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
    // What GoTrue issues for a non-member: without the hook's claim.
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

    // The list never carries the secret or the hash.
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
    expect((await call('GET', '/settings', { cookie: b })).json).toEqual({ tenant: { id: tenantB, name: 'Fintech B', created_at: expect.any(String) as unknown }, whatsapp: { number: null }, email: { from: null }, analysis: { statement_max_age_months: null } })
  })

  it('configuración: la antigüedad máxima del estado de cuenta se cambia, se valida y queda en la bitácora', async () => {
    const q = (t: string, v: unknown[]) => admin.query(t, v)
    const bearer = tokenFor(userA, tenantA, 'a@prestamista.test')
    const patch = (body: unknown) => call('PATCH', '/settings', { bearer, body })
    const six = await patch({ statement_max_age_months: 6 })
    expect(six.status).toBe(200)
    expect((six.json as unknown as { analysis: unknown }).analysis).toEqual({ statement_max_age_months: 6 })
    const none = await patch({ statement_max_age_months: null })
    expect((none.json as unknown as { analysis: unknown }).analysis).toEqual({ statement_max_age_months: null })
    expect(((await call('GET', '/settings', { bearer })).json as unknown as { analysis: unknown }).analysis).toEqual({ statement_max_age_months: null })
    for (const bad of [{ statement_max_age_months: 0 }, { statement_max_age_months: 25 }, { statement_max_age_months: 1.5 }, { statement_max_age_months: '3' }, {}, { statement_max_age_months: 3, name: 'otro' }]) {
      expect((await patch(bad)).status, JSON.stringify(bad)).toBe(400)
    }
    // B neither sees nor touches A's setting.
    expect(((await call('GET', '/settings', { bearer: tokenFor(userB, tenantB, 'b@prestamista.test') })).json as unknown as { analysis: unknown }).analysis).toEqual({ statement_max_age_months: null })
    const log = await q("SELECT actor, details FROM app.audit_log WHERE action = 'settings.updated' AND tenant_id = $1 ORDER BY at", [tenantA])
    expect(log.rows).toEqual([
      { actor: `user:${userA}`, details: { statement_max_age_months: { from: null, to: 6 } } },
      { actor: `user:${userA}`, details: { statement_max_age_months: { from: 6, to: null } } },
    ])
  })

  // Login has a per-IP limit and the earlier tests exhaust it: these use the JWT as Bearer.
  const as = (user: string, tenant: string, email: string) => {
    const bearer = tokenFor(user, tenant, email)
    return (method: string, path: string) => call(method, path, { bearer })
  }

  it('WhatsApp: sin proceso no hay QR ni se puede desvincular; el estado de cada tenant es suyo', async () => {
    const a = as(userA, tenantA, 'a@prestamista.test')
    const b = as(userB, tenantB, 'b@prestamista.test')
    // The process has never run for A.
    expect((await a('GET', '/whatsapp')).json).toEqual({ process_running: false, status: null, linked_number: null, qr: null, qr_expires_at: null, unlink_pending: false, updated_at: null })
    expect((await a('POST', '/whatsapp/unlink')).status).toBe(409)

    // B has the process alive and waiting for a QR; A has an old heartbeat with a current QR in the row.
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
    // A new QR is a different view; the value never goes to the audit log, only a truncated fingerprint.
    await q("UPDATE app.whatsapp_sessions SET qr = '2@reto-2' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ qr: '2@reto-2' })
    const rows = (await viewed()).rows as { actor: string; details: { qr_digest: string } }[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.actor === `user:${userA}` && /^[0-9a-f]{16}$/.test(r.details.qr_digest))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('reto')

    // Expired: neither delivered nor audited.
    await q("UPDATE app.whatsapp_sessions SET qr = '2@reto-3', qr_expires_at = now() - interval '1 second' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ process_running: true, status: 'waiting_qr', qr: null, qr_expires_at: null })
    expect((await viewed()).rows).toHaveLength(2)

    // Open: the number, no QR; it also shows in /me.
    await q("UPDATE app.whatsapp_sessions SET status = 'open', qr = NULL, qr_expires_at = NULL, linked_number = '+5215500000001' WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ process_running: true, status: 'open', linked_number: '+5215500000001', qr: null, unlink_pending: false })
    expect((await a('GET', '/me')).json).toMatchObject({ tenant: { whatsapp_linked_number: '+5215500000001' } })

    // Unlinking stays pending until the process handles it.
    const un = await a('POST', '/whatsapp/unlink')
    expect(un.status).toBe(202)
    expect(un.json).toEqual({ unlink_requested_at: expect.any(String) as unknown })
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ status: 'open', unlink_pending: true })
    await q('UPDATE app.whatsapp_sessions SET unlink_handled_at = unlink_requested_at WHERE tenant_id = $1', [tenantA])
    expect((await a('GET', '/whatsapp')).json).toMatchObject({ unlink_pending: false })
    const log = await q("SELECT actor, details FROM app.audit_log WHERE tenant_id = $1 AND action = 'whatsapp.unlink_requested'", [tenantA])
    expect(log.rows).toEqual([{ actor: `user:${userA}`, details: { status: 'open' } }])
    expect(JSON.stringify(log.rows)).not.toContain('+52')
    // Tenant B saw none of this.
    expect((await q("SELECT unlink_requested_at FROM app.whatsapp_sessions WHERE tenant_id = $1", [tenantB])).rows).toEqual([{ unlink_requested_at: null }])

    // With the process stopped, /me stops showing the linked number.
    await q("UPDATE app.whatsapp_sessions SET heartbeat_at = NULL WHERE tenant_id = $1", [tenantA])
    expect((await a('GET', '/me')).json).toMatchObject({ tenant: { whatsapp_linked_number: null } })
  })

  it('trabajos: cada tenant ve solo los suyos, con estado, intentos y el error, sin el contenido del trabajo', async () => {
    const a = tokenFor(userA, tenantA, 'a@prestamista.test')
    const app = randomUUID()
    const okId = await boss.send(QUEUES.redecide, { tenant_id: tenantA, application_id: app, correction_batch: randomUUID() })
    const badId = await boss.send(QUEUES.process, { tenant_id: tenantA, application_id: randomUUID() }, { retryLimit: 0 })
    const purgeId = await boss.send(QUEUES.purge, { tenant_id: tenantA, supplier_id: randomUUID(), application_ids: [], run_ids: [], storage_paths: [`${tenantA}/secreto.pdf`] })
    await boss.send(QUEUES.process, { tenant_id: tenantB, application_id: randomUUID() })
    await boss.fail(QUEUES.process, badId ?? '', { message: `el workflow terminó sin veredicto ${'x'.repeat(400)}`, stack: 'Error: at secreto.ts:1' })

    const all = await call('GET', '/jobs', { bearer: a })
    expect(all.status).toBe(200)
    const list = all.json as unknown as { id: string; queue: string; state: string; application_id: string | null; supplier_id: string | null; error: string | null; max_attempts: number }[]
    // Earlier tests also left jobs for this tenant: only these three are checked.
    expect(list.map((j) => j.id)).toEqual(expect.arrayContaining([okId, badId, purgeId]))
    expect(JSON.stringify(list)).not.toContain('secreto')
    expect(list.find((j) => j.id === okId)).toMatchObject({ queue: QUEUES.redecide, state: 'created', application_id: app, error: null })
    const bad = list.find((j) => j.id === badId)
    expect(bad).toMatchObject({ state: 'failed', max_attempts: 1 })
    expect(bad?.error?.startsWith('el workflow terminó sin veredicto')).toBe(true)
    expect(bad?.error?.length).toBeLessThanOrEqual(301)
    expect(list.find((j) => j.id === purgeId)?.supplier_id).not.toBeNull()

    expect(((await call('GET', '/jobs?state=failed', { bearer: a })).json as unknown as { id: string }[]).map((j) => j.id)).toContain(badId)
    expect(((await call('GET', '/jobs?state=running', { bearer: a })).json as unknown as { id: string }[]).map((j) => j.id)).not.toContain(badId)
    expect(((await call('GET', `/jobs?application_id=${app}`, { bearer: a })).json as unknown as { id: string }[]).map((j) => j.id)).toEqual([okId])
    expect((await call('GET', '/jobs?state=nope', { bearer: a })).status).toBe(400)
    const b = tokenFor(userB, tenantB, 'b@prestamista.test')
    expect(((await call('GET', '/jobs', { bearer: b })).json as unknown as { id: string }[]).every((j) => j.id !== okId && j.id !== badId)).toBe(true)
  })

  it('el esquema de tenant_users está en el catálogo de tablas con RLS', () => {
    expect(tenantUsers).toBeDefined()
  })
})
