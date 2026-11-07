/**
 * Document checks against real Postgres: a password-protected PDF is rejected on arrival over
 * WhatsApp with its own message, and bank statement age is a tenant setting that warns instead of
 * asking for another document, both on processing and on re-evaluation.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOCUMENT_REPLIES } from '@gow/channels'
import { DOCUMENT_AGE_WARNING, type Decision } from '@gow/contracts'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { encryptedStatementPdf, SYNTHETIC_STATEMENT_LINES } from '@gow/extraction/testing'
import { CachingStructuredLlm, createLimiter, type Classifier } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage } from '@gow/platform'
import { PostgresStore } from '@mastra/pg'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveInbound } from './inbound.ts'
import { handleRedecide } from './redecide.ts'
import { handleProcess, SYNTHETIC_SUFFIX, type SyntheticDocument, type WorkerServices } from './worker.ts'

const available = await postgresAvailable()
const SUPPLIER_PHONE = '+5215511120002'
const NEWCOMER = '+5215577780008'
const noClassifier: Classifier = { classify: () => Promise.reject(new Error('sin clasificador en esta prueba')) }

describe.skipIf(!available)('PDF con contraseña y antigüedad del estado de cuenta (necesita Postgres)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  let whatsapp: pg.Client
  let store: PostgresStore
  let services: WorkerServices
  const tenant = randomUUID()
  const supplierId = randomUUID()
  const policyId = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))
    whatsapp = new pg.Client({ connectionString: tdb.url('whatsapp') })
    await whatsapp.connect()
    store = new PostgresStore({ id: 'gow-test-age', connectionString: tdb.url('mastra'), schemaName: 'mastra' })
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-dc-')), secret: 's', publicBaseUrl: 'http://x' })
    // Without the column in the INSERT: the tenant takes the default (no limit).
    await admin.query("INSERT INTO app.tenants (id, name, whatsapp_number) VALUES ($1, 'Fintech Demo', '+5215500000002')", [tenant])
    await admin.query("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policyId, tenant])
    await admin.query("INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document) VALUES ($1, $2, 1, 'active', $3)", [tenant, policyId, JSON.stringify(basePolicyTemplate())])
    await admin.query("INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, 'Distribuidora Ficticia SA de CV', 'DFI150304AB1')", [supplierId, tenant])
    await admin.query("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [tenant, supplierId, SUPPLIER_PHONE])
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

  async function inbound(from: string, body: string, attachment: Buffer | null = null): Promise<string> {
    await whatsapp.query('BEGIN')
    await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    const r = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, attachment) VALUES ($1, 'whatsapp', $2, $3, $4) RETURNING id", [tenant, from, body, attachment])
    await whatsapp.query('COMMIT')
    return r.rows[0]?.id ?? ''
  }
  const lastReply = async (to: string) => (await admin.query<{ body: string }>('SELECT body FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1', [to])).rows[0]?.body ?? ''
  const applicationsOf = async (supplier: string) => Number((await admin.query<{ n: string }>('SELECT count(*) AS n FROM app.applications WHERE supplier_id = $1', [supplier])).rows[0]?.n)

  describe('PDF con contraseña por WhatsApp', () => {
    const locked = encryptedStatementPdf(SYNTHETIC_STATEMENT_LINES, { userPassword: 'secreto' })
    const restricted = encryptedStatementPdf(SYNTHETIC_STATEMENT_LINES, { userPassword: '' })

    it('se contesta de inmediato con el mensaje de contraseña y no abre solicitud', async () => {
      const id = await inbound(SUPPLIER_PHONE, '', locked)
      expect(await resolveInbound(worker.db, tenant, id, { storage: services.storage })).toEqual({ resolution: 'document_rejected', resume: null })
      expect(await lastReply(SUPPLIER_PHONE)).toBe(DOCUMENT_REPLIES.password_protected)
      expect(await applicationsOf(supplierId)).toBe(0)
      const audit = await admin.query<{ details: Record<string, unknown> }>("SELECT details FROM app.audit_log WHERE subject = $1 AND action = 'inbound.document_rejected'", [id])
      expect(audit.rows[0]?.details).toMatchObject({ reason: 'password' })
      const msg = await admin.query<{ attachment: Buffer | null }>('SELECT attachment FROM app.inbound_messages WHERE id = $1', [id])
      expect(msg.rows[0]?.attachment).toBeNull()
    })

    it('uno que solo restringe permisos se recibe normal', async () => {
      const r = await resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, '', restricted), { storage: services.storage })
      expect(r.resolution).toBe('document_received')
      expect(await applicationsOf(supplierId)).toBe(1)
    })

    it('en el registro por WhatsApp, también; se sigue esperando el estado de cuenta', async () => {
      const opts = { storage: services.storage, selfRegistration: true }
      expect((await resolveInbound(worker.db, tenant, await inbound(NEWCOMER, 'Hola'), opts)).resolution).toBe('registration_started')
      expect((await resolveInbound(worker.db, tenant, await inbound(NEWCOMER, 'Ana'), opts)).resolution).toBe('registration_step')
      expect((await resolveInbound(worker.db, tenant, await inbound(NEWCOMER, 'omitir'), opts)).resolution).toBe('registration_step')
      expect((await resolveInbound(worker.db, tenant, await inbound(NEWCOMER, '', locked), opts)).resolution).toBe('document_rejected')
      expect(await lastReply(NEWCOMER)).toBe(DOCUMENT_REPLIES.password_protected)
      const reg = await admin.query<{ step: string; application_id: string | null }>('SELECT step, application_id FROM app.supplier_registrations WHERE address = $1', [NEWCOMER])
      expect(reg.rows[0]).toEqual({ step: 'statement', application_id: null })
    })
  })

  describe('antigüedad del estado de cuenta, ajuste del tenant', () => {
    /** A request with a synthetic September bank statement, evaluated at `asOf`. */
    async function application(asOf: string, seed: string): Promise<string> {
      const doc: SyntheticDocument = {
        input: { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] },
        holder: { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null },
        seed,
      }
      const path = `${tenant}/${randomUUID()}${SYNTHETIC_SUFFIX}`
      await services.storage.put(path, Buffer.from(JSON.stringify(doc)))
      const sha = syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256
      const appId = randomUUID()
      const docId = randomUUID()
      await admin.query("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/json')", [docId, tenant, supplierId, path, sha])
      await admin.query('INSERT INTO app.applications (id, tenant_id, supplier_id, request, as_of) VALUES ($1, $2, $3, $4, $5)', [appId, tenant, supplierId, JSON.stringify({ amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }), asOf])
      await admin.query('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenant, appId, docId])
      return appId
    }
    const decisionsOf = async (appId: string) => (await admin.query<{ kind: string; payload: Decision }>('SELECT kind, payload FROM app.decisions WHERE application_id = $1 ORDER BY created_at', [appId])).rows
    const warned = (d: Decision | undefined) => d?.reasons.some((r) => r.code === DOCUMENT_AGE_WARNING) ?? false

    it('por defecto no hay límite: un estado de 4 meses se analiza normal y no advierte', async () => {
      const stored = await admin.query<{ months: number | null }>('SELECT statement_max_age_months AS months FROM app.tenants WHERE id = $1', [tenant])
      expect(stored.rows[0]?.months).toBeNull()
      const appId = await application('2027-02-15', 'age-default')
      expect(await handleProcess(services, { tenant_id: tenant, application_id: appId })).toBe('qualified_with_limit')
      expect(warned((await decisionsOf(appId))[0]?.payload)).toBe(false)
    })

    it('con un límite de 3 meses un estado de 4 meses se analiza normal y la decisión advierte', async () => {
      await admin.query('UPDATE app.tenants SET statement_max_age_months = 3 WHERE id = $1', [tenant])
      const appId = await application('2027-02-15', 'age-three')
      const status = await handleProcess(services, { tenant_id: tenant, application_id: appId })
      expect(status).toBe('qualified_with_limit')
      const [active] = await decisionsOf(appId)
      expect(active?.payload.clarification).toBeNull()
      expect(warned(active?.payload)).toBe(true)
      expect(active?.payload.evaluation.gates.map((g) => g.id)).not.toContain('doc_recent')
      expect((await admin.query('SELECT 1 FROM app.clarifications WHERE application_id = $1', [appId])).rowCount).toBe(0)
    })

    it('sin límite no advierte; la reevaluación usa el ajuste vigente, también para la política en sombra', async () => {
      await admin.query('UPDATE app.tenants SET statement_max_age_months = NULL WHERE id = $1', [tenant])
      const appId = await application('2027-02-15', 'age-none')
      expect(await handleProcess(services, { tenant_id: tenant, application_id: appId })).toBe('qualified_with_limit')
      expect(warned((await decisionsOf(appId))[0]?.payload)).toBe(false)

      // The analyst corrects something and it is re-evaluated with 1 month: now it warns (the request is not held back).
      await admin.query('UPDATE app.tenants SET statement_max_age_months = 1 WHERE id = $1', [tenant])
      await admin.query("INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document) VALUES ($1, $2, 2, 'shadow', $3)", [tenant, policyId, JSON.stringify({ ...basePolicyTemplate(), version: 2 })])
      await admin.query("UPDATE app.applications SET status = 'deciding' WHERE id = $1", [appId])
      expect(await handleRedecide(services, { tenant_id: tenant, application_id: appId, correction_batch: randomUUID() })).toBe('qualified_with_limit')
      const rows = await decisionsOf(appId)
      const redecided = rows.filter((r) => r.kind === 'active').at(-1)
      expect(warned(redecided?.payload)).toBe(true)
      const shadow = rows.find((r) => r.kind === 'shadow')
      expect(shadow?.payload.status).toBe('qualified_with_limit')
      expect(warned(shadow?.payload)).toBe(true)
    })

    it('la base rechaza un ajuste fuera de rango', async () => {
      await expect(admin.query('UPDATE app.tenants SET statement_max_age_months = 0 WHERE id = $1', [tenant])).rejects.toThrow(/tenants_statement_max_age_months_range/)
    })
  })
})
