/**
 * El relay con el rol `gow_whatsapp` contra Postgres real y un transporte falso: entrega solo el
 * buzón de su tenant, inserta entrantes una vez y no puede leer nada más.
 */
import { randomUUID } from 'node:crypto'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jidToNumber, numberToJid } from './baileys.ts'
import { deliverPending, storeIncoming, type IncomingWhatsApp, type WhatsAppTransport } from './relay.ts'

const available = await postgresAvailable()

class FakeTransport implements WhatsAppTransport {
  readonly sent: { to: string; text: string }[] = []
  failNext = false
  start(_onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void> {
    return Promise.resolve()
  }
  send(to: string, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      return Promise.reject(new Error('sin conexión'))
    }
    this.sent.push({ to, text })
    return Promise.resolve()
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
}

describe('números de WhatsApp', () => {
  it('jid ↔ número', () => {
    expect(jidToNumber('5215511110001@s.whatsapp.net')).toBe('+5215511110001')
    expect(jidToNumber('120363000000@g.us')).toBeNull()
    expect(numberToJid('+52 1 55 1111 0001')).toBe('5215511110001@s.whatsapp.net')
  })
})

describe.skipIf(!available)('relay de WhatsApp (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let wa: Database
  const A = randomUUID()
  const B = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    for (const [t, n] of [
      [A, '1'],
      [B, '2'],
    ] as const) {
      const sup = randomUUID()
      const app = randomUUID()
      const clar = randomUUID()
      await admin.query("INSERT INTO app.tenants (id, name) VALUES ($1, 'T')", [t])
      await admin.query("INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, 'P')", [sup, t])
      await admin.query('INSERT INTO app.applications (id, tenant_id, supplier_id) VALUES ($1, $2, $3)', [app, t, sup])
      await admin.query("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, questions) VALUES ($1, $2, $3, $4, 1, 'whatsapp', '[]')", [clar, t, app, sup])
      await admin.query("INSERT INTO app.outbound_messages (tenant_id, clarification_id, channel, destination, body) VALUES ($1, $2, 'whatsapp', $3, 'pregunta')", [t, clar, `+52155111100${n}`])
    }
    wa = connect(tdb.url('whatsapp'))
  }, 60_000)

  afterAll(async () => {
    await wa.close()
    await admin.end()
    await tdb.drop()
  })

  it('entrega solo el buzón de su tenant; un fallo se reintenta', async () => {
    const t = new FakeTransport()
    t.failNext = true
    expect(await deliverPending(wa.db, A, t)).toBe(1)
    expect(t.sent).toEqual([])
    expect(await deliverPending(wa.db, A, t)).toBe(1)
    expect(t.sent).toEqual([{ to: '+521551111001', text: 'pregunta' }])
    expect(await deliverPending(wa.db, A, t)).toBe(0)
    const b = await admin.query<{ status: string }>('SELECT status FROM app.outbound_messages WHERE tenant_id = $1', [B])
    expect(b.rows).toEqual([{ status: 'pending' }])
  })

  it('un entrante se guarda una vez en su tenant', async () => {
    const m = { from: '+521551111001', id: 'wamid.1', text: '1' }
    await storeIncoming(wa.db, A, m)
    await storeIncoming(wa.db, A, m)
    const rows = await admin.query<{ tenant_id: string }>("SELECT tenant_id::text FROM app.inbound_messages WHERE external_id = 'wamid.1'")
    expect(rows.rows).toEqual([{ tenant_id: A }])
  })
})
