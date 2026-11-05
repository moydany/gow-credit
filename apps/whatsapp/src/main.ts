/* eslint-disable no-console -- punto de entrada: estado de la conexión y el QR para vincular, sin PII */
/**
 * pnpm whatsapp: una sesión de Baileys para un tenant (WHATSAPP_TENANT_ID). La primera vez imprime
 * el QR para vincular el número dedicado del tenant desde el teléfono.
 */
import { join, resolve } from 'node:path'
import { connect, databaseUrl } from '@gow/db'
import { BaileysTransport } from './baileys.ts'
import { startRelay } from './relay.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const tenantId = process.env.WHATSAPP_TENANT_ID
if (!tenantId) {
  console.error('Falta WHATSAPP_TENANT_ID: el tenant de este número')
  process.exit(2)
}
const db = connect(databaseUrl('whatsapp'), { max: 2 })
const transport = new BaileysTransport({
  authDir: process.env.WHATSAPP_AUTH_DIR ?? join(REPO, 'data/whatsapp', tenantId),
  onQr: (qr) => {
    console.log(`Escanea este código desde WhatsApp > Dispositivos vinculados:\n${qr}`)
  },
  onStatus: (s) => {
    console.log(JSON.stringify({ at: new Date().toISOString(), connection: s }))
  },
})
const relay = await startRelay({ db: db.db, tenantId, transport, onError: (m) => { console.error(m) } })
const shutdown = async () => {
  await relay.stop()
  await db.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
