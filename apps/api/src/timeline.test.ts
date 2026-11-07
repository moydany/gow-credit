/**
 * Recorrido de una solicitud (ADR 0067) contra Postgres real: qué filas arma `loadTimelineSources`, que no
 * mezcla otra solicitud ni otro tenant, que el JSON de las fuentes no lleva texto ni teléfonos, que la
 * base misma niega `body` y `destination` de los salientes a `gow_api`, y el endpoint.
 *
 * El endpoint corre el constructor real (`buildTimeline`); sus reglas finas se prueban en packages/contracts.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleStatement } from '@gow/contracts/testing'
import { ApplicationTimeline } from '@gow/contracts'
import { connect, withTenant, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { LocalDocumentStorage, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { createApp } from './app.ts'
import { loadTimelineSources } from './bo/timeline.ts'
import { issueToken } from './session.ts'


const available = await postgresAvailable()
const SECRET = 'secreto-de-pruebas-del-recorrido'

// Marcadores que nunca deben salir de la base hacia las fuentes ni hacia la respuesta.
const P_APP1 = '+5215550001111'
const P_OTHER = '+5215550002222'
const BODY_IN = 'SECRETO-CUERPO-ENTRANTE'
const BODY_OUT = 'SECRETO-CUERPO-SALIENTE'
const FORBIDDEN = [P_APP1, P_OTHER, BODY_IN, BODY_OUT, 'SECRETO-SYSTEM', 'SECRETO-INSTRUCTION', 'SECRETO-RESPUESTA', 'SECRETO-VALOR']

describe.skipIf(!available)('Recorrido: fuentes y endpoint (necesita el Postgres de docker compose)', () => {
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
  const ids = {
    app1: randomUUID(),
    app2: randomUUID(),
    appB: randomUUID(),
    clar1: randomUUID(),
    clar2: randomUUID(),
    docA: randomUUID(),
    in1: randomUUID(), // ligado por aclaración
    in2: randomUUID(), // ligado por bitácora inbound.* con application_id
    in3: randomUUID(), // de app2
    in4: randomUUID(), // del mismo proveedor, sin enlace
    out1: randomUUID(), // aclaración
    out2: randomUUID(), // misma transacción que inbound.document_received de in2
    out3: randomUUID(), // misma transacción que verdict.queued de app1
    out4: randomUUID(), // sin enlace
    out5: randomUUID(), // aclaración de app2
    out6: randomUUID(), // misma transacción que inbound.* de in3 (app2)
    x1: randomUUID(), // application_id
    x2: randomUUID(), // inbound_message_id (in1)
    x3: randomUUID(), // app2
    x4: randomUUID(), // tenant B
  }

  const q = (text: string, values: unknown[] = []) => admin.query(text, values)
  const load = (tenant: string, app: string) => withTenant(apiDb.db, tenant, (tx) => loadTimelineSources(tx, app))
  const get = async (path: string, tenant: string, sub: string) => {
    const res = await fetch(`${base}/bo/v1${path}`, { headers: { authorization: `Bearer ${issueToken(SECRET, { sub, email: `${sub}@prestamista.test`, tenant_id: tenant }, 600)}` } })
    const text = await res.text()
    return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
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
    await q('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3), ($4, $5, $6)', [tenantA, userA, `${userA}@prestamista.test`, tenantB, userB, `${userB}@prestamista.test`])

    const supA = randomUUID()
    const supB = randomUUID()
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3), ($4, $5, $6)', [supA, tenantA, 'Proveedor A', supB, tenantB, 'Proveedor B'])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status, created_at) VALUES ($1, $2, $3, 'needs_clarification', '2026-03-01T10:00:00Z'), ($4, $2, $3, 'qualified', '2026-03-02T10:00:00Z'), ($5, $6, $7, 'qualified', '2026-03-03T10:00:00Z')", [ids.app1, tenantA, supA, ids.app2, ids.appB, tenantB, supB])

    // Documento con extracción, ligado a app1.
    const statement = sampleStatement()
    await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, 'x', $4, 10, 'application/pdf')", [ids.docA, tenantA, supA, statement.document.sha256])
    await q("INSERT INTO app.application_documents (tenant_id, application_id, document_id, origin) VALUES ($1, $2, $3, 'submitted')", [tenantA, ids.app1, ids.docA])
    await q("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', $3)", [tenantA, ids.docA, JSON.stringify(statement)])

    // Aclaraciones: app1 con 2 preguntas y 1 respuesta; app2 con otra.
    const two = JSON.stringify([{ id: 'q1' }, { id: 'q2' }])
    await q("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, destination, questions, answers) VALUES ($1, $2, $3, $4, 1, 'whatsapp', $5, $6, $7), ($8, $2, $9, $4, 1, 'whatsapp', $5, '[]', '[]')", [ids.clar1, tenantA, ids.app1, supA, P_APP1, two, JSON.stringify([{ question_id: 'q1', value: 'SECRETO-VALOR' }]), ids.clar2, ids.app2])

    // Entrantes: cada uno con su propio texto y teléfono, que no deben salir.
    await q("INSERT INTO app.inbound_messages (id, tenant_id, channel, from_address, body, clarification_id, resolution, received_at, processed_at) VALUES ($1, $2, 'whatsapp', $3, $4, $5, 'matched', '2026-03-01T10:05:00Z', '2026-03-01T10:05:01Z')", [ids.in1, tenantA, P_APP1, BODY_IN, ids.clar1])
    await q("INSERT INTO app.inbound_messages (id, tenant_id, channel, from_address, body, attachment_name, attachment_media_type, resolution, received_at, processed_at) VALUES ($1, $2, 'whatsapp', $3, $4, 'estado.pdf', 'application/pdf', 'document_received', '2026-03-01T09:59:00Z', '2026-03-01T09:59:01Z')", [ids.in2, tenantA, P_APP1, BODY_IN])
    await q("INSERT INTO app.inbound_messages (id, tenant_id, channel, from_address, body, resolution, received_at) VALUES ($1, $2, 'whatsapp', $3, $4, 'document_received', '2026-03-02T09:59:00Z')", [ids.in3, tenantA, P_OTHER, BODY_IN])
    await q("INSERT INTO app.inbound_messages (id, tenant_id, channel, from_address, body, resolution, media_kind, received_at) VALUES ($1, $2, 'whatsapp', $3, $4, 'media_unsupported', 'audio', '2026-03-05T09:59:00Z')", [ids.in4, tenantA, P_APP1, BODY_IN])

    // Bitácora de los entrantes. Cada par (bitácora, saliente) en una sola transacción: comparten now().
    const audit = (action: string, subject: string, details: object) => q('INSERT INTO app.audit_log (tenant_id, actor, action, subject, details) VALUES ($1, $2, $3, $4, $5)', [tenantA, 'worker', action, subject, JSON.stringify(details)])
    const outbound = (id: string, clar: string | null, kind: string) => q("INSERT INTO app.outbound_messages (id, tenant_id, clarification_id, kind, channel, destination, body) VALUES ($1, $2, $3, $4, 'whatsapp', $5, $6)", [id, tenantA, clar, kind, P_APP1, BODY_OUT])
    await q('BEGIN')
    await audit('inbound.document_received', ids.in2, { clarification_id: null, application_id: ids.app1 })
    await outbound(ids.out2, null, 'invoice')
    await q('COMMIT')
    await q('BEGIN')
    await audit('verdict.queued', ids.app1, { status: 'qualified', channel: 'whatsapp' })
    await outbound(ids.out3, null, 'verdict')
    await q('COMMIT')
    await q('BEGIN')
    await audit('inbound.document_received', ids.in3, { clarification_id: null, application_id: ids.app2 })
    await outbound(ids.out6, null, 'invoice')
    await q('COMMIT')
    await audit('inbound.matched', ids.in1, { clarification_id: ids.clar1 })
    await audit('inbound.unparsed', ids.in4, { clarification_id: null })
    await audit('clarification.opened', ids.clar1, { application_id: ids.app1, round: 1, channel: 'whatsapp', questions: 2 })
    await audit('application.received', ids.app1, { inbound_message_id: ids.in2 })
    await audit('application.redecided', ids.app2, { status: 'qualified' })
    await q('INSERT INTO app.audit_log (tenant_id, actor, action, subject, details) VALUES ($1, $2, $3, $4, $5)', [tenantB, 'worker', 'application.redecided', ids.appB, '{}'])
    // Salientes sueltos, cada uno en su propio instante.
    await outbound(ids.out1, ids.clar1, 'question')
    await outbound(ids.out4, null, 'generic')
    await outbound(ids.out5, ids.clar2, 'question')

    // Intercambios con el modelo, con contenido que no debe salir.
    const exchange = (id: string, tenant: string, app: string | null, inbound: string | null, purpose: string) =>
      q(
        "INSERT INTO app.llm_exchanges (id, tenant_id, application_id, inbound_message_id, purpose, model, schema_name, prompt_version, effort, max_output_tokens, server_fallback, system, instruction, outcome, response, raw_output, error_message, usage, cost_usd, latency_ms) VALUES ($1, $2, $3, $4, $5, 'gemini-3.8-flash', 's.v1', 'p.v1', 'low', 10, false, 'SECRETO-SYSTEM', 'SECRETO-INSTRUCTION', 'ok', $6, 'SECRETO-RESPUESTA', 'SECRETO-RESPUESTA', $7, '0.012500', 1500)",
        [id, tenant, app, inbound, purpose, JSON.stringify({ x: 'SECRETO-RESPUESTA' }), JSON.stringify({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })],
      )
    await exchange(ids.x1, tenantA, ids.app1, null, 'summary')
    await exchange(ids.x2, tenantA, null, ids.in1, 'interpret_reply')
    await exchange(ids.x3, tenantA, ids.app2, null, 'summary')
    await exchange(ids.x4, tenantB, ids.appB, null, 'summary')

    // Decisión con versión de política; corrección y desenlace.
    const policy = randomUUID()
    const version = randomUUID()
    await q("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policy, tenantA])
    await q("INSERT INTO app.policy_versions (id, tenant_id, policy_id, version, status, document) VALUES ($1, $2, $3, 7, 'archived', '{}')", [version, tenantA, policy])
    await q("INSERT INTO app.decisions (tenant_id, application_id, policy_version_id, kind, status, limit_amount, score, payload) VALUES ($1, $2, $3, 'active', 'qualified_with_limit', 123456.78, 71.5, '{}')", [tenantA, ids.app1, version])
    await q("INSERT INTO app.decisions (tenant_id, application_id, kind, status, payload) VALUES ($1, $2, 'shadow', 'qualified', '{}')", [tenantA, ids.app1])
    await q("INSERT INTO app.corrections (tenant_id, application_id, document_id, target, read_value, value, page) VALUES ($1, $2, $3, $4, '1', $5, 2)", [tenantA, ids.app1, ids.docA, JSON.stringify({ kind: 'transaction', transaction_id: 'a1.p1.t2', field: 'amount' }), JSON.stringify('SECRETO-VALOR')])
    await q("INSERT INTO app.outcomes (tenant_id, application_id, outcome, observed_at) VALUES ($1, $2, 'paid', now())", [tenantA, ids.app1])

    server = createServer()
    server.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-tl-')), secret: 'firma-local', publicBaseUrl: base })
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

  it('arma las filas de la solicitud, con las aclaraciones como conteos y la versión de política', async () => {
    const s = await load(tenantA, ids.app1)
    expect(s).not.toBeNull()
    if (!s) return
    expect(s.application).toMatchObject({ id: ids.app1, status: 'needs_clarification', failureReason: null })
    expect(s.application.createdAt).toEqual(new Date('2026-03-01T10:00:00Z'))
    expect(s.documents).toHaveLength(1)
    expect(s.documents[0]).toMatchObject({ documentId: ids.docA, origin: 'submitted' })
    expect(s.documents[0]?.extraction?.payload.document.sha256).toBe(sampleStatement().document.sha256)
    expect(s.clarifications).toEqual([expect.objectContaining({ id: ids.clar1, round: 1, status: 'open', channel: 'whatsapp', step: 'asking', questions: 2, answers: 1, answeredAt: null })])
    expect(s.decisions.map((d) => [d.kind, d.status, d.policyVersion]).sort()).toEqual([
      ['active', 'qualified_with_limit', 7],
      ['shadow', 'qualified', null],
    ])
    expect(s.corrections).toEqual([expect.objectContaining({ documentId: ids.docA, target: 'transaction.amount', page: 2 })])
    expect(s.outcomes).toHaveLength(1)
  })

  it('liga los entrantes por aclaración, por bitácora inbound.* y por application.received; deja fuera los de otra solicitud', async () => {
    const s = await load(tenantA, ids.app1)
    expect(s?.inbound.map((m) => m.id).sort()).toEqual([ids.in1, ids.in2].sort())
    const in1 = s?.inbound.find((m) => m.id === ids.in1)
    const in2 = s?.inbound.find((m) => m.id === ids.in2)
    expect(in1).toMatchObject({ channel: 'whatsapp', resolution: 'matched', clarificationId: ids.clar1, hasDocument: false, mediaKind: null })
    // El adjunto se vacía al procesar: el nombre y la resolución `document_*` dicen que hubo documento.
    expect(in2).toMatchObject({ resolution: 'document_received', hasDocument: true })
    expect(in2?.processedAt).toEqual(new Date('2026-03-01T09:59:01Z'))
    // Mismo proveedor y mismo teléfono, pero ni aclaración ni bitácora de la solicitud: no entra.
    expect(s?.inbound.some((m) => m.id === ids.in4 || m.id === ids.in3)).toBe(false)
  })

  it('la bitácora trae la de la solicitud, la de sus mensajes y la de sus aclaraciones, y nada más', async () => {
    const s = await load(tenantA, ids.app1)
    expect(s?.audit.map((a) => a.action).sort()).toEqual(['application.received', 'clarification.opened', 'inbound.document_received', 'inbound.matched', 'verdict.queued'])
    expect(s?.audit.every((a) => a.actor === 'worker' && a.at instanceof Date)).toBe(true)
    const verdict = s?.audit.find((a) => a.action === 'verdict.queued')
    expect(verdict).toMatchObject({ subject: ids.app1, details: { status: 'qualified', channel: 'whatsapp' } })
  })

  it('liga los salientes por aclaración o por compartir transacción con la bitácora de la solicitud', async () => {
    const s = await load(tenantA, ids.app1)
    expect(s?.outbound.map((o) => o.id).sort()).toEqual([ids.out1, ids.out2, ids.out3].sort())
    expect(s?.outbound.find((o) => o.id === ids.out1)).toMatchObject({ kind: 'question', channel: 'whatsapp', status: 'pending', attempts: 0, clarificationId: ids.clar1, sentAt: null })
    expect(s?.outbound.find((o) => o.id === ids.out2)).toMatchObject({ kind: 'invoice', clarificationId: null })
    expect(s?.outbound.find((o) => o.id === ids.out3)).toMatchObject({ kind: 'verdict', clarificationId: null })
    // Sueltos (out4), de la aclaración de otra solicitud (out5) y de la bitácora de otra solicitud (out6).
    for (const other of [ids.out4, ids.out5, ids.out6]) expect(s?.outbound.some((o) => o.id === other)).toBe(false)
  })

  it('las llamadas al modelo vienen de la solicitud o de sus mensajes, convertidas, sin prompt ni respuesta', async () => {
    const s = await load(tenantA, ids.app1)
    expect(s?.exchanges.map((x) => x.id).sort()).toEqual([ids.x1, ids.x2].sort())
    const x1 = s?.exchanges.find((x) => x.id === ids.x1)
    expect(x1).toEqual({
      id: ids.x1,
      applicationId: ids.app1,
      inboundMessageId: null,
      purpose: 'summary',
      model: 'gemini-3.8-flash',
      promptVersion: 'p.v1',
      effort: 'low',
      documentSha256: null,
      outcome: 'ok',
      errorCode: null,
      responseCacheHit: false,
      usage: { input_tokens: 100, output_tokens: 20 },
      costUsd: 0.0125,
      latencyMs: 1500,
      createdAt: expect.any(Date) as Date,
    })
    expect(s?.exchanges.find((x) => x.id === ids.x2)).toMatchObject({ applicationId: null, inboundMessageId: ids.in1 })
  })

  it('app2 recibe lo suyo y nada de app1; el JSON de las fuentes no lleva texto, teléfonos ni valores', async () => {
    const s2 = await load(tenantA, ids.app2)
    expect(s2?.inbound.map((m) => m.id)).toEqual([ids.in3])
    expect(s2?.outbound.map((o) => o.id).sort()).toEqual([ids.out5, ids.out6].sort())
    expect(s2?.exchanges.map((x) => x.id)).toEqual([ids.x3])
    expect(s2?.documents).toEqual([])
    const s1 = await load(tenantA, ids.app1)
    for (const s of [s1, s2]) {
      const json = JSON.stringify(s)
      for (const secret of FORBIDDEN) expect(json, secret).not.toContain(secret)
      // Solo estos campos por fila: una columna de más es un hallazgo.
      for (const row of s?.outbound ?? []) expect(Object.keys(row).sort()).toEqual(['attempts', 'channel', 'clarificationId', 'createdAt', 'id', 'kind', 'sentAt', 'status'])
      for (const row of s?.inbound ?? []) expect(Object.keys(row).sort()).toEqual(['channel', 'clarificationId', 'hasDocument', 'id', 'mediaKind', 'processedAt', 'receivedAt', 'resolution'])
      for (const row of s?.exchanges ?? []) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['system']))
    }
  })

  it('otro tenant no ve la solicitud ni sus filas, y una solicitud que no existe da null', async () => {
    expect(await load(tenantB, ids.app1)).toBeNull()
    expect(await load(tenantA, ids.appB)).toBeNull()
    expect(await load(tenantA, randomUUID())).toBeNull()
    const b = await load(tenantB, ids.appB)
    expect(b?.exchanges.map((x) => x.id)).toEqual([ids.x4])
    expect(b?.inbound).toEqual([])
    expect(b?.outbound).toEqual([])
    expect(b?.audit).toHaveLength(1)
  })

  it('la base niega a gow_api el cuerpo y el destino de los salientes, y le deja los metadatos', async () => {
    const api = new pg.Client({ connectionString: tdb.url('api') })
    await api.connect()
    try {
      const run = async (columns: string) => {
        await api.query('BEGIN')
        try {
          await api.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
          return await api.query(`SELECT ${columns} FROM app.outbound_messages`)
        } finally {
          await api.query('ROLLBACK')
        }
      }
      await expect(run('body')).rejects.toThrow(/permission denied/)
      await expect(run('destination')).rejects.toThrow(/permission denied/)
      await expect(run('*')).rejects.toThrow(/permission denied/)
      const ok = await run('id, tenant_id, clarification_id, kind, channel, status, attempts, created_at, sent_at')
      expect(ok.rowCount).toBeGreaterThan(0)
      // Solo lectura: no puede escribir.
      await api.query('BEGIN')
      await api.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      await expect(api.query("UPDATE app.outbound_messages SET status = 'sent'")).rejects.toThrow(/permission denied/)
      await api.query('ROLLBACK')
    } finally {
      await api.end()
    }
  })

  it('GET /applications/:id/timeline: 200 con el recorrido, 404 de otro tenant o inexistente, 400 con id inválido, sin bitácora de visto', async () => {
    const before = (await q("SELECT count(*)::int AS n FROM app.audit_log WHERE tenant_id = $1 AND action LIKE '%viewed'", [tenantA])).rows[0] as { n: number }
    const ok = await get(`/applications/${ids.app1}/timeline`, tenantA, userA)
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ application_id: ids.app1, status: 'needs_clarification', totals: { model_calls: 2 } })
    for (const secret of FORBIDDEN) expect(ok.text, secret).not.toContain(secret)
    expect(ApplicationTimeline.safeParse(ok.json).success).toBe(true)

    expect((await get(`/applications/${ids.app1}/timeline`, tenantB, userB)).status).toBe(404)
    expect((await get(`/applications/${randomUUID()}/timeline`, tenantA, userA)).status).toBe(404)
    expect((await get('/applications/no-es-uuid/timeline', tenantA, userA)).status).toBe(400)
    const noSession = await fetch(`${base}/bo/v1/applications/${ids.app1}/timeline`)
    expect(noSession.status).toBe(401)

    const after = (await q("SELECT count(*)::int AS n FROM app.audit_log WHERE tenant_id = $1 AND action LIKE '%viewed'", [tenantA])).rows[0] as { n: number }
    expect(after.n).toBe(before.n)
  })
})
