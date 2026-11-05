/**
 * El worker contra Postgres real (docker compose), sin modelos: estado de cuenta sintético,
 * redacción con plantillas y Mastra con estado en el esquema `mastra`. Recorre el ciclo de
 * docs/02 §3: procesar → pausar con una aclaración por WhatsApp → respuesta → reanudar en otra
 * instancia de Mastra → veredicto. Y docs/05 §2b: un número ajeno no abre nada.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { CachingStructuredLlm, createLimiter, type Classifier } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage } from '@gow/platform'
import { PostgresStore } from '@mastra/pg'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveInbound } from './inbound.ts'
import { handleProcess, handleResume, SYNTHETIC_SUFFIX, type SyntheticDocument, type WorkerServices } from './worker.ts'

const available = await postgresAvailable()

const SUPPLIER_PHONE = '+5215511110001'
const STRANGER_PHONE = '+5215599990009'

const noClassifier: Classifier = { classify: () => Promise.reject(new Error('sin clasificador en esta prueba')) }

describe.skipIf(!available)('worker del modo full (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  let whatsapp: pg.Client
  let store: PostgresStore
  let services: WorkerServices
  const tenant = randomUUID()
  const supplierId = randomUUID()
  const applicationId = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))
    whatsapp = new pg.Client({ connectionString: tdb.url('whatsapp') })
    await whatsapp.connect()
    store = new PostgresStore({ id: 'gow-test', connectionString: tdb.url('mastra'), schemaName: 'mastra' })
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-wk-')), secret: 's', publicBaseUrl: 'http://x' })

    // Alta como administrador: tenant, política activa, proveedor con WhatsApp verificado, documento y solicitud.
    const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
    const doc: SyntheticDocument = {
      input: { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
      holder,
      seed: 'wk1',
    }
    const path = `${tenant}/${randomUUID()}${SYNTHETIC_SUFFIX}`
    await storage.put(path, Buffer.from(JSON.stringify(doc)))
    const sha = syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256
    const policyId = randomUUID()
    const docId = randomUUID()
    await admin.query("INSERT INTO app.tenants (id, name, whatsapp_number) VALUES ($1, 'Fintech Demo', '+5215500000001')", [tenant])
    await admin.query("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policyId, tenant])
    await admin.query("INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document) VALUES ($1, $2, 1, 'active', $3)", [tenant, policyId, JSON.stringify(basePolicyTemplate())])
    await admin.query('INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, $3, $4)', [supplierId, tenant, holder.name, holder.rfc])
    await admin.query("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [tenant, supplierId, SUPPLIER_PHONE])
    await admin.query("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/json')", [docId, tenant, supplierId, path, sha])
    await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, request, as_of) VALUES ($1, $2, $3, $4, '2026-10-05')", [applicationId, tenant, supplierId, JSON.stringify({ amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } })])
    await admin.query('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenant, applicationId, docId])

    services = {
      db: worker.db,
      mastraStore: store,
      storage,
      llm: new CachingStructuredLlm(null, mkdtempSync(join(tmpdir(), 'gow-cache-')), 'read'),
      documentClassifier: noClassifier,
      transactionClassifier: null,
      writer: new Writer(null),
      limit: createLimiter(2),
      googleAvailable: false,
      transports: {},
      synthetic: (d) => syntheticStatement(d.input, d.holder, d.seed),
      logger: { info: () => undefined, error: () => undefined },
    }
  }, 60_000)

  afterAll(async () => {
    await whatsapp.end()
    await admin.end()
    await worker.close()
    await store.close()
    await tdb.drop()
  })

  async function inbound(from: string, body: string): Promise<string> {
    await whatsapp.query('BEGIN')
    await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    const r = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body) VALUES ($1, 'whatsapp', $2, $3) RETURNING id", [tenant, from, body])
    await whatsapp.query('COMMIT')
    return r.rows[0]?.id ?? ''
  }

  it('procesa, pausa y deja la pregunta en el buzón de WhatsApp del proveedor', async () => {
    expect(await handleProcess(services, { tenant_id: tenant, application_id: applicationId })).toBe('needs_clarification')
    const clar = await admin.query<{ status: string; channel: string; destination: string }>('SELECT status, channel, destination FROM app.clarifications WHERE application_id = $1', [applicationId])
    expect(clar.rows).toEqual([{ status: 'open', channel: 'whatsapp', destination: SUPPLIER_PHONE }])
    const out = await admin.query<{ destination: string; status: string; body: string }>("SELECT destination, status, body FROM app.outbound_messages WHERE tenant_id = $1 AND kind = 'question'", [tenant])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.destination).toBe(SUPPLIER_PHONE)
    expect(out.rows[0]?.body).toMatch(/Responde con el número:\n1\)/)
    const app = await admin.query<{ status: string; run_id: string | null }>('SELECT status, run_id FROM app.applications WHERE id = $1', [applicationId])
    expect(app.rows[0]).toMatchObject({ status: 'needs_clarification' })
    expect(app.rows[0]?.run_id).not.toBeNull()
    // Reintento del mismo trabajo: no repite nada.
    expect(await handleProcess(services, { tenant_id: tenant, application_id: applicationId })).toBe('needs_clarification')
    expect((await admin.query('SELECT 1 FROM app.clarifications WHERE application_id = $1', [applicationId])).rowCount).toBe(1)
  })

  it('un número sin vínculo que cita la solicitud recibe la respuesta fija y no abre nada', async () => {
    const id = await inbound(STRANGER_PHONE, `Respondo a la solicitud ${applicationId}: es pago de cliente`)
    expect(await resolveInbound(worker.db, tenant, id)).toEqual({ resolution: 'no_link', resume: null })
    const reply = await admin.query<{ kind: string; destination: string }>('SELECT kind, destination FROM app.outbound_messages WHERE destination = $1', [STRANGER_PHONE])
    expect(reply.rows).toEqual([{ kind: 'generic', destination: STRANGER_PHONE }])
    expect((await admin.query("SELECT status FROM app.clarifications WHERE application_id = $1 AND status = 'open'", [applicationId])).rowCount).toBe(1)
  })

  it('una respuesta ambigua se repregunta; la buena completa la aclaración y la reanudación decide', async () => {
    const vague = await inbound(SUPPLIER_PHONE, 'hola, buenas tardes')
    expect((await resolveInbound(worker.db, tenant, vague)).resolution).toBe('unparsed')
    const good = await inbound(SUPPLIER_PHONE, '1')
    const r = await resolveInbound(worker.db, tenant, good)
    expect(r.resolution).toBe('completed')
    expect(r.resume?.application_id).toBe(applicationId)
    // Otra instancia de Mastra sobre el mismo store: es lo que hace el worker al tomar el trabajo.
    expect(await handleResume(services, r.resume ?? { tenant_id: tenant, application_id: applicationId, clarification_id: randomUUID() })).toBe('qualified_with_limit')
    const decisions = await admin.query<{ status: string }>('SELECT status FROM app.decisions WHERE application_id = $1 ORDER BY created_at', [applicationId])
    expect(decisions.rows.map((d) => d.status)).toEqual(['needs_clarification', 'qualified_with_limit'])
    expect((await admin.query('SELECT 1 FROM app.extractions WHERE tenant_id = $1', [tenant])).rowCount).toBe(1)
  })

  it('una reanudación con una aclaración de otra solicitud no hace nada', async () => {
    const otherClar = randomUUID()
    expect(await handleResume(services, { tenant_id: tenant, application_id: applicationId, clarification_id: otherClar })).toBe('qualified_with_limit')
  })
})
