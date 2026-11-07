/**
 * El relay con el rol `gow_whatsapp` contra Postgres real y un transporte falso: entrega solo el
 * buzón de su tenant, inserta entrantes una vez y no puede leer nada más.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { documentOf, jidToNumber, mediaKindOf, numberToJid, senderNumber } from './baileys.ts'
import { renderQrForTerminal, writeQrPng } from './qr.ts'
import { deliverPending, storeIncoming, type IncomingWhatsApp, type WhatsAppTransport } from './relay.ts'

const available = await postgresAvailable()

class FakeTransport implements WhatsAppTransport {
  readonly sent: { to: string; text: string }[] = []
  failNext = false
  open = true
  connected(): boolean {
    return this.open
  }
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

  it('el remitente sale del JID, del alterno o del mapa LID→número (Baileys 7)', async () => {
    const noMap = () => Promise.resolve(null)
    expect(await senderNumber({ remoteJid: '5215511110001@s.whatsapp.net' }, noMap)).toBe('+5215511110001')
    expect(await senderNumber({ remoteJid: '123456789012345@lid', remoteJidAlt: '5215511110001@s.whatsapp.net' }, noMap)).toBe('+5215511110001')
    expect(await senderNumber({ remoteJid: '123456789012345@lid' }, (lid) => Promise.resolve(lid === '123456789012345@lid' ? '5215511110001:0@s.whatsapp.net' : null))).toBe('+5215511110001')
    expect(await senderNumber({ remoteJid: '123456789012345@lid' }, noMap)).toBeNull()
    expect(await senderNumber({ remoteJid: '123456789012345@lid' }, () => Promise.reject(new Error('sin mapa')))).toBeNull()
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

  it('entrega solo el buzón de su tenant; sin sesión abierta no intenta; un fallo se reintenta', async () => {
    const t = new FakeTransport()
    t.open = false
    t.failNext = true
    // Esperando el QR: no se intenta ni se gasta un intento.
    expect(await deliverPending(wa.db, A, t)).toBe(0)
    expect((await admin.query<{ attempts: number }>('SELECT attempts FROM app.outbound_messages WHERE tenant_id = $1', [A])).rows).toEqual([{ attempts: 0 }])
    t.open = true
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

  it('un documento se guarda con sus bytes aunque no traiga texto (ADR 0037)', async () => {
    const bytes = Buffer.from('%PDF-1.7\n%%EOF\n')
    await storeIncoming(wa.db, A, { from: '+521551111001', id: 'wamid.doc', text: '', document: { bytes, fileName: 'estado.pdf', mediaType: 'application/pdf' } })
    const rows = await admin.query<{ attachment: Buffer; attachment_name: string; attachment_media_type: string }>("SELECT attachment, attachment_name, attachment_media_type FROM app.inbound_messages WHERE external_id = 'wamid.doc'")
    expect(rows.rows).toEqual([{ attachment: bytes, attachment_name: 'estado.pdf', attachment_media_type: 'application/pdf' }])
    // Sin texto ni documento no se guarda nada.
    await storeIncoming(wa.db, A, { from: '+521551111001', id: 'wamid.vacio', text: '  ' })
    expect((await admin.query("SELECT 1 FROM app.inbound_messages WHERE external_id = 'wamid.vacio'")).rowCount).toBe(0)
  })

  it('una foto o nota de voz se guarda solo con su tipo, sin bytes ni texto obligatorio (ADR 0051)', async () => {
    await storeIncoming(wa.db, A, { from: '+521551111001', id: 'wamid.foto', text: '', media: 'image' })
    await storeIncoming(wa.db, A, { from: '+521551111001', id: 'wamid.voz', text: '', media: 'audio' })
    const rows = await admin.query<{ external_id: string; media_kind: string; body: string; attachment: Buffer | null }>("SELECT external_id, media_kind, body, attachment FROM app.inbound_messages WHERE external_id IN ('wamid.foto', 'wamid.voz') ORDER BY external_id")
    expect(rows.rows).toEqual([
      { external_id: 'wamid.foto', media_kind: 'image', body: '', attachment: null },
      { external_id: 'wamid.voz', media_kind: 'audio', body: '', attachment: null },
    ])
    // La columna solo acepta los tipos conocidos.
    await expect(admin.query("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, media_kind) VALUES ($1, 'whatsapp', '+521', '', 'pdf')", [A])).rejects.toThrow(/media_kind/)
  })
})

describe('documentos entrantes de Baileys', () => {
  it('lee el documento con o sin pie de foto e ignora lo demás', () => {
    const doc = { fileName: 'edc.pdf', mimetype: 'application/pdf', fileLength: 1234, caption: 'enero' }
    expect(documentOf({ documentMessage: doc })).toEqual({ caption: 'enero', fileName: 'edc.pdf', mediaType: 'application/pdf', size: 1234 })
    expect(documentOf({ documentWithCaptionMessage: { message: { documentMessage: { ...doc, caption: null } } } })).toEqual({ caption: '', fileName: 'edc.pdf', mediaType: 'application/pdf', size: 1234 })
    expect(documentOf({ conversation: 'hola' })).toBeNull()
    expect(documentOf({ imageMessage: { mimetype: 'image/jpeg' } })).toBeNull()
    expect(documentOf(undefined)).toBeNull()
  })

  it('fotos, notas de voz, videos y stickers pasan solo con su tipo; lo demás se ignora (ADR 0051)', () => {
    expect(mediaKindOf({ imageMessage: { mimetype: 'image/jpeg', caption: 'mi estado' } })).toEqual({ kind: 'image', caption: 'mi estado' })
    expect(mediaKindOf({ audioMessage: { ptt: true } })).toEqual({ kind: 'audio', caption: '' })
    expect(mediaKindOf({ videoMessage: {} })).toEqual({ kind: 'video', caption: '' })
    expect(mediaKindOf({ stickerMessage: {} })).toEqual({ kind: 'sticker', caption: '' })
    expect(mediaKindOf({ viewOnceMessage: { message: { imageMessage: {} } } })).toEqual({ kind: 'image', caption: '' })
    expect(mediaKindOf({ conversation: 'hola' })).toBeNull()
    expect(mediaKindOf({ reactionMessage: { text: '👍' } })).toBeNull()
    expect(mediaKindOf({ documentMessage: { fileName: 'edc.pdf' } })).toBeNull()
    expect(mediaKindOf(undefined)).toBeNull()
  })
})

describe('QR para vincular', () => {
  it('se dibuja en la terminal y se guarda como PNG legible', async () => {
    const sample = '2@reto-de-vinculacion-de-prueba,llave-publica,llave-de-identidad,secreto'
    const art = await renderQrForTerminal(sample)
    expect(art.split('\n').length).toBeGreaterThan(10)
    expect(art).toMatch(/[▀▄█]/)
    const path = join(mkdtempSync(join(tmpdir(), 'gow-qr-')), 'sub', 'qr.png')
    await writeQrPng(sample, path)
    expect(readFileSync(path).subarray(1, 4).toString('latin1')).toBe('PNG')
  })
})
