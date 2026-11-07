/**
 * Notice to the supplier when an analyst discards the document, against real Postgres: the worker
 * writes the outbox, only with a verified WhatsApp, once, and never for a request that was not discarded.
 */
import { randomUUID } from 'node:crypto'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleDiscardNotice } from './discard-notice.ts'
import type { WorkerServices } from './worker.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('aviso de documento descartado (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  const tenant = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))
    await admin.query("INSERT INTO app.tenants (id, name) VALUES ($1, 'Fintech Demo')", [tenant])
  }, 60_000)

  afterAll(async () => {
    await admin.end()
    await worker.close()
    await tdb.drop()
  })

  const services = () => ({ db: worker.db, logger: { info: () => undefined, error: () => undefined } }) as unknown as WorkerServices

  async function application(opts: { status: string; failure: string | null; whatsapp: 'verified' | 'unverified' | 'none' }): Promise<{ app: string; phone: string }> {
    const sup = randomUUID()
    const app = randomUUID()
    const phone = `+52155${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    await admin.query('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenant, 'Proveedor Ficticio'])
    await admin.query('INSERT INTO app.applications (id, tenant_id, supplier_id, status, failure_reason, request) VALUES ($1, $2, $3, $4, $5, $6)', [app, tenant, sup, opts.status, opts.failure, JSON.stringify({ amount: 50000 })])
    if (opts.whatsapp !== 'none') await admin.query(`INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, ${opts.whatsapp === 'verified' ? "now(), 'kyc'" : 'null, null'})`, [tenant, sup, phone])
    return { app, phone }
  }
  const job = (app: string) => ({ tenant_id: tenant, application_id: app })
  const outbox = async (phone: string) => (await admin.query('SELECT kind, channel, body FROM app.outbound_messages WHERE destination = $1', [phone])).rows as { kind: string; channel: string; body: string }[]

  it('con WhatsApp verificado deja un aviso de rechazo con el motivo y lo registra una sola vez', async () => {
    const { app, phone } = await application({ status: 'not_qualified', failure: 'document_discarded:incomplete', whatsapp: 'verified' })
    expect(await handleDiscardNotice(services(), job(app))).toBe('queued')
    const rows = await outbox(phone)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'verdict', channel: 'whatsapp' })
    expect(rows[0]?.body).toMatch(/no califica .*Fintech Demo porque al documento que mandaste le faltan páginas o periodos/)
    // Redelivered job: nothing new.
    expect(await handleDiscardNotice(services(), job(app))).toBe('already_sent')
    expect(await outbox(phone)).toHaveLength(1)
  })

  it('sin WhatsApp verificado no manda nada y deja constancia en la bitácora', async () => {
    for (const whatsapp of ['unverified', 'none'] as const) {
      const { app, phone } = await application({ status: 'not_qualified', failure: 'document_discarded:illegible', whatsapp })
      expect(await handleDiscardNotice(services(), job(app))).toBe('no_verified_whatsapp')
      expect(await outbox(phone)).toHaveLength(0)
      const log = await admin.query("SELECT details FROM app.audit_log WHERE subject = $1 AND action = 'discard_notice.skipped'", [app])
      expect(log.rows).toEqual([{ details: { reason: 'no_verified_whatsapp' } }])
    }
  })

  it('una solicitud que no fue descartada por el analista no recibe este aviso', async () => {
    const decided = await application({ status: 'not_qualified', failure: null, whatsapp: 'verified' })
    expect(await handleDiscardNotice(services(), job(decided.app))).toBe('not_discarded')
    const inReview = await application({ status: 'human_review', failure: null, whatsapp: 'verified' })
    expect(await handleDiscardNotice(services(), job(inReview.app))).toBe('not_discarded')
    expect(await outbox(decided.phone)).toHaveLength(0)
    expect(await outbox(inReview.phone)).toHaveLength(0)
  })
})
