/* eslint-disable no-console -- punto de entrada: estado de la conexión y el QR para vincular, sin PII */
/**
 * pnpm whatsapp: una sesión de Baileys para un tenant (WHATSAPP_TENANT_ID). La primera vez dibuja
 * el QR en la terminal (y lo guarda como qr.png junto a la sesión) para vincular el número dedicado
 * del tenant desde el teléfono; después la sesión queda guardada y no se vuelve a pedir.
 */
import { join, resolve } from 'node:path'
import { connect, databaseUrl } from '@gow/db'
import { BaileysTransport } from './baileys.ts'
import { renderQrForTerminal, writeQrPng } from './qr.ts'
import { startRelay } from './relay.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const tenantId = process.env.WHATSAPP_TENANT_ID
if (!tenantId) {
  console.error('Falta WHATSAPP_TENANT_ID: el tenant de este número')
  process.exit(2)
}
const db = connect(databaseUrl('whatsapp'), { max: 2 })
const authDir = process.env.WHATSAPP_AUTH_DIR ?? join(REPO, 'data/whatsapp', tenantId)
const qrPng = join(authDir, 'qr.png')
const transport = new BaileysTransport({
  authDir,
  // El código caduca en segundos y Baileys manda uno nuevo: cada vez se redibuja y se reescribe la imagen.
  onQr: (qr) => {
    void Promise.all([renderQrForTerminal(qr), writeQrPng(qr, qrPng)]).then(([art]) => {
      console.log(`\nEn el teléfono: WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo.\n${art}`)
      console.log(`Si la terminal lo deforma, abre la imagen: ${qrPng}`)
    })
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
