/**
 * Session status publishing as the `gow_whatsapp` role against real Postgres and a fake transport:
 * QR with expiry, open session with the number, heartbeat, one unlink per request and clean
 * shutdown. Touches only its own tenant's row.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountJidToNumber, clearAuthState } from './baileys.ts'
import type { IncomingWhatsApp } from './relay.ts'
import { SessionPublisher, type LinkableTransport, type LinkEvent } from './session.ts'

const available = await postgresAvailable()

class FakeLinkable implements LinkableTransport {
  readonly #listeners: ((e: LinkEvent) => void)[] = []
  number: string | null = null
  unlinks = 0
  onLinkEvent(listener: (e: LinkEvent) => void): void {
    this.#listeners.push(listener)
  }
  emit(e: LinkEvent): void {
    for (const l of this.#listeners) l(e)
  }
  linkedNumber(): string | null {
    return this.number
  }
  unlink(): Promise<void> {
    this.unlinks++
    this.number = null
    this.emit({ type: 'connecting' })
    this.emit({ type: 'qr', qr: '2@reto-nuevo' })
    return Promise.resolve()
  }
  start(_onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void> {
    return Promise.resolve()
  }
  send(): Promise<void> {
    return Promise.resolve()
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
}

describe('cuenta y estado local de Baileys', () => {
  it('el número de la cuenta propia ignora el dispositivo', () => {
    expect(accountJidToNumber('5215511110001:12@s.whatsapp.net')).toBe('+5215511110001')
    expect(accountJidToNumber('5215511110001@s.whatsapp.net')).toBe('+5215511110001')
    expect(accountJidToNumber('1234@lid')).toBeNull()
  })

  it('borrar el estado solo quita los .json de la sesión y el qr.png, sin recursión', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gow-auth-'))
    for (const f of ['creds.json', 'pre-key-1.json', 'session-x.json', 'qr.png', 'notas.txt']) writeFileSync(join(dir, f), '{}')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'otro.json'), '{}')
    expect(await clearAuthState(dir)).toBe(4)
    expect(readdirSync(dir).sort()).toEqual(['notas.txt', 'sub'])
    expect(readdirSync(join(dir, 'sub'))).toEqual(['otro.json'])
    expect(await clearAuthState(join(dir, 'no-existe'))).toBe(0)
  })
})

describe.skipIf(!available)('estado de la sesión de WhatsApp (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let wa: Database
  const A = randomUUID()
  const B = randomUUID()
  const errors: string[] = []

  type Row = { status: string; qr: string | null; qr_ttl: number | null; linked_number: string | null; beat_age: number | null; handled: boolean | null }
  const row = async (tenant: string): Promise<Row | undefined> =>
    (
      await admin.query<Row>(
        `SELECT status, qr, extract(epoch from qr_expires_at - now())::int AS qr_ttl, linked_number,
                extract(epoch from now() - heartbeat_at)::int AS beat_age,
                (unlink_handled_at = unlink_requested_at) AS handled
           FROM app.whatsapp_sessions WHERE tenant_id = $1`,
        [tenant],
      )
    ).rows[0]

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    await admin.query("INSERT INTO app.tenants (id, name) VALUES ($1, 'A'), ($2, 'B')", [A, B])
    await admin.query("INSERT INTO app.whatsapp_sessions (tenant_id, status, linked_number, heartbeat_at) VALUES ($1, 'open', '+5215500000002', now())", [B])
    wa = connect(tdb.url('whatsapp'))
  }, 60_000)

  afterAll(async () => {
    await wa.close()
    await admin.end()
    await tdb.drop()
  })

  it('publica QR con caducidad, luego la sesión abierta con el número y sin QR', async () => {
    const t = new FakeLinkable()
    const statuses: string[] = []
    const p = new SessionPublisher({ db: wa.db, tenantId: A, transport: t, onError: (m) => errors.push(m), onStatus: (s) => statuses.push(s) })
    await p.starting()
    expect(await row(A)).toMatchObject({ status: 'starting', qr: null, beat_age: 0 })
    t.emit({ type: 'qr', qr: '2@reto-1' })
    t.emit({ type: 'qr', qr: '2@reto-2' })
    await p.heartbeat()
    const waiting = await row(A)
    expect(waiting).toMatchObject({ status: 'waiting_qr', qr: '2@reto-2' })
    expect(waiting?.qr_ttl).toBeGreaterThan(50)
    expect(waiting?.qr_ttl).toBeLessThanOrEqual(60)
    t.number = '+5215500000001'
    await p.handle({ type: 'open' })
    expect(await row(A)).toMatchObject({ status: 'open', qr: null, qr_ttl: null, linked_number: '+5215500000001' })
    // Logs carry the status, never the QR or the number.
    expect(statuses).toEqual(['starting', 'waiting_qr', 'waiting_qr', 'open'])
    // The other tenant's row was not touched.
    expect(await row(B)).toMatchObject({ status: 'open', linked_number: '+5215500000002' })
    expect(errors).toEqual([])
  })

  it('una reconexión conserva el número; un cierre desde el teléfono lo borra', async () => {
    const t = new FakeLinkable()
    const p = new SessionPublisher({ db: wa.db, tenantId: A, transport: t })
    await p.handle({ type: 'close', loggedOut: false })
    expect(await row(A)).toMatchObject({ status: 'closed', linked_number: '+5215500000001' })
    await p.handle({ type: 'close', loggedOut: true })
    expect(await row(A)).toMatchObject({ status: 'logged_out', linked_number: null, qr: null })
  })

  it('desvincular se atiende una vez por petición, borra el número y deja un QR nuevo', async () => {
    const t = new FakeLinkable()
    const p = new SessionPublisher({ db: wa.db, tenantId: A, transport: t, onError: (m) => errors.push(m) })
    t.number = '+5215500000001'
    await p.handle({ type: 'open' })
    expect(await p.checkUnlink()).toBe(false)
    await admin.query('UPDATE app.whatsapp_sessions SET unlink_requested_at = now() WHERE tenant_id = $1', [A])
    expect(await p.checkUnlink()).toBe(true)
    await p.heartbeat()
    expect(t.unlinks).toBe(1)
    expect(await row(A)).toMatchObject({ status: 'waiting_qr', qr: '2@reto-nuevo', linked_number: null, handled: true })
    // Another process (a restart) doesn't handle the same request again.
    const restarted = new SessionPublisher({ db: wa.db, tenantId: A, transport: new FakeLinkable() })
    expect(await restarted.checkUnlink()).toBe(false)
    expect(await p.checkUnlink()).toBe(false)
    expect(t.unlinks).toBe(1)
    // This process doesn't see the other tenant's request.
    await admin.query('UPDATE app.whatsapp_sessions SET unlink_requested_at = now() WHERE tenant_id = $1', [B])
    expect(await p.checkUnlink()).toBe(false)
    expect(errors).toEqual([])
  })

  it('el apagado limpio quita el latido y el QR', async () => {
    const t = new FakeLinkable()
    const p = new SessionPublisher({ db: wa.db, tenantId: A, transport: t })
    t.emit({ type: 'qr', qr: '2@reto-3' })
    await p.stop()
    t.emit({ type: 'qr', qr: '2@reto-tarde' })
    await p.heartbeat()
    expect(await row(A)).toMatchObject({ status: 'closed', qr: null })
    // No heartbeat after shutdown: the backoffice sees right away that the process is down.
    const r = await admin.query<{ beat: Date | null }>('SELECT heartbeat_at AS beat FROM app.whatsapp_sessions WHERE tenant_id = $1', [A])
    expect(r.rows[0]?.beat).toBeNull()
  })
})
