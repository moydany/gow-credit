/**
 * Reevaluación tras la corrección de un analista (ADR 0020), contra Postgres real y sin modelos:
 * la extracción guardada tiene un monto mal leído que rompe el cuadre; el analista lo corrige; el
 * worker decide de nuevo con la corrección y deja el veredicto anterior intacto.
 */
import { randomUUID } from 'node:crypto'
import { StatementExtraction, type Decision } from '@gow/contracts'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { printedOf, reconcilePeriod } from '@gow/extraction'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleRedecide } from './redecide.ts'
import type { WorkerServices } from './worker.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('reevaluar con correcciones (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  const tenant = randomUUID()
  const supplierId = randomUUID()
  const applicationId = randomUUID()
  const documentId = randomUUID()
  let txId = ''
  let rightAmount = 0

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))

    const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
    const good = syntheticStatement({ start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] }, holder, 'redecide-1')
    // El modelo leyó mal el primer movimiento: el periodo ya no cuadra contra el saldo final impreso.
    const bad = structuredClone(good)
    const period = bad.accounts[0]?.periods[0]
    const first = period?.transactions[0]
    if (!period || !first) throw new Error('fixture sin movimientos')
    txId = first.id
    rightAmount = first.amount
    first.amount = Math.round((first.amount + 777) * 100) / 100
    period.reconciliation = reconcilePeriod(period.transactions, printedOf(period)).reconciliation
    expect(period.reconciliation.status).not.toBe('reconciled')

    const policyId = randomUUID()
    const policyVersionId = randomUUID()
    await admin.query("INSERT INTO app.tenants (id, name) VALUES ($1, 'Fintech Demo')", [tenant])
    await admin.query("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policyId, tenant])
    await admin.query("INSERT INTO app.policy_versions (id, tenant_id, policy_id, version, status, document) VALUES ($1, $2, $3, 1, 'active', $4)", [policyVersionId, tenant, policyId, JSON.stringify(basePolicyTemplate())])
    await admin.query('INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, $3, $4)', [supplierId, tenant, holder.name, holder.rfc])
    await admin.query("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, 'x', $4, 10, 'application/pdf')", [documentId, tenant, supplierId, good.document.sha256])
    await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, status, as_of) VALUES ($1, $2, $3, 'human_review', '2026-10-05')", [applicationId, tenant, supplierId])
    await admin.query('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenant, applicationId, documentId])
    await admin.query("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', $3)", [tenant, documentId, JSON.stringify(StatementExtraction.parse(bad))])
  }, 60_000)

  afterAll(async () => {
    await admin.end()
    await worker.close()
    await tdb.drop()
  })

  const services = () => ({ db: worker.db, logger: { info: () => undefined, error: () => undefined } }) as unknown as WorkerServices
  const job = () => ({ tenant_id: tenant, application_id: applicationId, correction_batch: randomUUID() })

  it('si la solicitud no está en `deciding`, el trabajo no hace nada (idempotencia)', async () => {
    expect(await handleRedecide(services(), job())).toBe('human_review')
    const n = await admin.query('SELECT count(*)::int AS n FROM app.decisions WHERE application_id = $1', [applicationId])
    expect((n.rows[0] as { n: number }).n).toBe(0)
  })

  it('decide con la corrección: el cuadre vuelve a cuadrar, queda un veredicto nuevo y la bitácora lo dice', async () => {
    await admin.query("INSERT INTO app.corrections (tenant_id, application_id, document_id, target, read_value, value, page) VALUES ($1, $2, $3, $4, $5, $6, 1)", [tenant, applicationId, documentId, JSON.stringify({ kind: 'transaction', transaction_id: txId, field: 'amount' }), JSON.stringify(rightAmount + 777), JSON.stringify(rightAmount)])
    await admin.query("UPDATE app.applications SET status = 'deciding' WHERE id = $1", [applicationId])

    const status = await handleRedecide(services(), job())
    const row = await admin.query('SELECT status FROM app.applications WHERE id = $1', [applicationId])
    expect((row.rows[0] as { status: string }).status).toBe(status)
    expect(status).not.toBe('deciding')

    const decisions = await admin.query("SELECT payload FROM app.decisions WHERE application_id = $1 AND kind = 'active'", [applicationId])
    expect(decisions.rows).toHaveLength(1)
    const decision = (decisions.rows[0] as { payload: Decision }).payload
    expect(decision.profile.features.integrity_ok).toMatchObject({ value: true })
    const log = await admin.query("SELECT details FROM app.audit_log WHERE tenant_id = $1 AND action = 'application.redecided'", [tenant])
    expect(log.rows).toHaveLength(1)

    // Repetir el trabajo (reintento de pg-boss) no duplica el veredicto.
    expect(await handleRedecide(services(), job())).toBe(status)
    const again = await admin.query("SELECT count(*)::int AS n FROM app.decisions WHERE application_id = $1 AND kind = 'active'", [applicationId])
    expect((again.rows[0] as { n: number }).n).toBe(1)
  })
})
