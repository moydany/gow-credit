/**
 * The API against real Postgres (docker compose): per-tenant keys, isolation, signed upload,
 * deduplication, policies, answers through the API and the signed email webhook.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signSvix } from '@gow/channels'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { basePolicyTemplate } from '@gow/decision'
import { LocalDocumentStorage, QUEUES, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { createApp } from './app.ts'

const available = await postgresAvailable()
const WEBHOOK_SECRET = `whsec_${Buffer.from('secreto-del-webhook-de-pruebas-0001').toString('base64')}`
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

describe.skipIf(!available)('API del modo full (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let adminDb: Database
  let apiDb: Database
  let admin: pg.Client
  let boss: PgBoss
  let server: Server
  let base = ''
  let keyA = ''
  let keyB = ''
  let tenantA = ''

  const call = async (method: string, path: string, key: string | null, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }

  async function upload(key: string, bytes: Buffer): Promise<string> {
    const up = await call('POST', '/v1/uploads', key)
    const res = await fetch(String(up.json.url), { method: 'PUT', body: new Uint8Array(bytes) })
    expect(res.status).toBe(204)
    return String(up.json.path)
  }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    adminDb = connect(tdb.url('admin'))
    apiDb = connect(tdb.url('api'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
    const a = await createTenant(adminDb.db, { name: 'Fintech A', whatsappNumber: '+5215500000001', emailFrom: 'aclaraciones@a.test' })
    const b = await createTenant(adminDb.db, { name: 'Fintech B', whatsappNumber: '+5215500000002' })
    keyA = a.apiKey
    keyB = b.apiKey
    tenantA = a.tenantId
    // Server first (to learn the port), then the app: the signed URL points at the API.
    server = createServer()
    server.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-api-')), secret: 'firma-local', publicBaseUrl: base })
    server.on('request', createApp({ db: apiDb.db, boss, storage, resendWebhookSecret: WEBHOOK_SECRET }))
  }, 60_000)

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await boss.stop({ graceful: false })
    await admin.end()
    await apiDb.close()
    await adminDb.close()
    await tdb.drop()
  })

  it('sin llave o con una llave falsa no entra', async () => {
    expect((await call('POST', '/v1/uploads', null)).status).toBe(401)
    expect((await call('POST', '/v1/uploads', `${keyA.slice(0, -4)}AAAA`)).status).toBe(401)
    expect((await call('GET', '/healthz', null)).status).toBe(200)
  })

  let supplierId = ''
  let applicationId = ''
  let documentPath = ''

  it('alta de proveedor con su WhatsApp verificado por KYC', async () => {
    const r = await call('POST', '/v1/suppliers', keyA, { legal_name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', contacts: [{ channel: 'whatsapp', address: '+5215511110001', verified_by_kyc: true }] })
    expect(r.status).toBe(201)
    supplierId = String(r.json.id)
    const bad = await call('POST', '/v1/suppliers', keyA, { legal_name: '', rfc: 'X' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.json)).not.toContain('"X"')
  })

  it('sube por URL firmada, crea la solicitud y encola; el mismo PDF no crea otra', async () => {
    documentPath = await upload(keyA, PDF)
    const r = await call('POST', '/v1/applications', keyA, { supplier_id: supplierId, document_path: documentPath, request: { amount: 100000, maturity: null, buyer: null } })
    expect(r.status).toBe(201)
    applicationId = String(r.json.id)
    const again = await call('POST', '/v1/applications', keyA, { supplier_id: supplierId, document_path: await upload(keyA, PDF) })
    expect([again.status, again.json.id, again.json.duplicate]).toEqual([200, applicationId, true])
    const jobs = await boss.findJobs<{ application_id: string }>(QUEUES.process, { data: { application_id: applicationId } })
    expect(jobs).toHaveLength(1)
    expect((await call('GET', `/v1/applications/${applicationId}`, keyA)).json.status).toBe('received')
  })

  it('rechaza lo que no es PDF', async () => {
    const path = await upload(keyA, Buffer.from('<html>no soy un pdf</html>'))
    expect((await call('POST', '/v1/applications', keyA, { supplier_id: supplierId, document_path: path })).status).toBe(415)
  })

  it('otro tenant no ve la solicitud ni puede usar el documento ni el proveedor', async () => {
    expect((await call('GET', `/v1/applications/${applicationId}`, keyB)).status).toBe(404)
    expect((await call('POST', '/v1/applications', keyB, { supplier_id: supplierId, document_path: documentPath })).status).toBe(403)
    const own = await upload(keyB, PDF)
    expect((await call('POST', '/v1/applications', keyB, { supplier_id: supplierId, document_path: own })).status).toBe(404)
  })

  it('respuestas por la API: completa la aclaración y encola la reanudación con prioridad', async () => {
    const clar = randomUUID()
    const questions = [{ id: 'q1', topic: 'identity_fields', kind: 'identity', transaction: null, facts: [], options: [], text: 'Confirma tu RFC', text_source: 'template' }]
    await admin.query("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, questions) VALUES ($1, $2, $3, $4, 1, 'manual', $5)", [clar, tenantA, applicationId, supplierId, JSON.stringify(questions)])
    expect((await call('POST', `/v1/clarifications/${clar}/answers`, keyA, { answers: [{ question_id: 'q9', kind: 'decline' }] })).status).toBe(400)
    expect((await call('POST', `/v1/clarifications/${clar}/answers`, keyB, { answers: [{ question_id: 'q1', kind: 'decline' }] })).status).toBe(404)
    const r = await call('POST', `/v1/clarifications/${clar}/answers`, keyA, { answers: [{ question_id: 'q1', kind: 'identity', legal_name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1' }] })
    expect(r.json).toEqual({ id: clar, complete: true })
    const [job] = await boss.findJobs<object>(QUEUES.resume, { data: { clarification_id: clar } })
    expect(job?.priority).toBe(10)
    expect((await call('POST', `/v1/clarifications/${clar}/answers`, keyA, { answers: [{ question_id: 'q1', kind: 'decline' }] })).status).toBe(409)
  })

  it('política: borrador inválido se rechaza; uno válido se simula, pasa a sombra y se activa', async () => {
    const invalid = await call('POST', '/v1/policies/versions', keyA, { document: { ...basePolicyTemplate(), gates: [{ id: 'x', when: { feature: 'identity_match', op: '>=', value: 3 }, onFail: { status: 'not_qualified' } }] } })
    expect(invalid.status).toBe(400)
    const draft = await call('POST', '/v1/policies/versions', keyA, { document: { ...basePolicyTemplate(), version: 2 } })
    expect(draft.json).toMatchObject({ version: 2, status: 'draft' })
    const id = String(draft.json.id)
    const sim = await call('POST', `/v1/policies/versions/${id}/simulate`, keyA)
    expect(sim.status).toBe(200)
    expect(sim.json.baseline).not.toBeNull()
    expect((await call('POST', `/v1/policies/versions/${id}/shadow`, keyA)).json.status).toBe('shadow')
    expect((await call('POST', `/v1/policies/versions/${id}/activate`, keyA)).json.status).toBe('active')
    const versions = (await call('GET', '/v1/policies/versions', keyA)).json as unknown as { version: number; status: string }[]
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'active'],
      [1, 'archived'],
    ])
    expect(((await call('GET', '/v1/policies/versions', keyB)).json as unknown as unknown[]).length).toBe(1)
  })

  it('outcomes solo sobre solicitudes propias', async () => {
    expect((await call('POST', '/v1/outcomes', keyA, { application_id: applicationId, outcome: 'paid', observed_at: '2026-11-01T00:00:00Z' })).status).toBe(201)
    expect((await call('POST', '/v1/outcomes', keyB, { application_id: applicationId, outcome: 'paid', observed_at: '2026-11-01T00:00:00Z' })).status).toBe(404)
  })

  it('webhook de correo: firma inválida no entra; la válida queda en el tenant del destinatario, una sola vez', async () => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', from: 'Dueño <dueno@proveedor.test>', to: ['aclaraciones@a.test'], text: '1\n> cita' } })
    const now = Math.floor(Date.now() / 1000)
    const post = (sig: string) => fetch(`${base}/v1/webhooks/resend`, { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': 'msg_1', 'svix-timestamp': String(now), 'svix-signature': sig }, body })
    expect((await post('v1,firmafalsa')).status).toBe(401)
    const good = `v1,${signSvix(WEBHOOK_SECRET, 'msg_1', now, body)}`
    expect((await post(good)).status).toBe(200)
    expect((await post(good)).status).toBe(200)
    const rows = await admin.query<{ tenant_id: string; from_address: string; body: string }>("SELECT tenant_id::text, from_address, body FROM app.inbound_messages WHERE channel = 'email'")
    expect(rows.rows).toEqual([{ tenant_id: tenantA, from_address: 'dueno@proveedor.test', body: '1' }])
  })
})
