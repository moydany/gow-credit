/* eslint-disable no-console -- punto de entrada: estado de la conexión y el QR para vincular, sin PII */
/**
 * pnpm whatsapp: una sesión de Baileys para un tenant. Sin configurar nada, el tenant es el único que
 * exista (se espera a que se cree en el primer inicio); `WHATSAPP_TENANT_ID` lo fija cuando hay varios,
 * o en producción. El número se vincula
 * escaneando el QR desde el backoffice (Configuración, ADR 0033): este proceso publica el estado de
 * la sesión en `app.whatsapp_sessions` y atiende "Desvincular". En una terminal interactiva el QR
 * también se dibuja aquí (y se guarda como qr.png junto a la sesión); sin terminal (Cloud Run) no
 * se imprime, para que nunca llegue a los registros. Después la sesión queda guardada y no se
 * vuelve a pedir.
 */
import { join, resolve } from 'node:path'
import { connect, databaseUrl } from '@gow/db'
import { startHealthListener } from '@gow/platform/health'
import { BaileysTransport } from './baileys.ts'
import { renderQrForTerminal, writeQrPng } from './qr.ts'
import { startRelay } from './relay.ts'
import { startSessionPublisher } from './session.ts'
import { resolveTenantId } from './tenant.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const db = connect(databaseUrl('whatsapp'), { max: 3 })
const interactive = process.stdout.isTTY
const line = (fields: Record<string, string>) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }))
}

startHealthListener((m) => { line({ health: m }) })

// Sin WHATSAPP_TENANT_ID, el proceso descubre su tenant (el único que exista) y espera a que el wizard
// del backoffice lo cree si todavía no hay ninguno (ADR 0060).
const tenantId = await resolveTenantId({
  db: db.db,
  configured: process.env.WHATSAPP_TENANT_ID,
  onWaiting: () => {
    line({ tenant: 'esperando', hint: 'crea la institución crediticia en el backoffice (primer inicio); con varias instituciones crediticias define WHATSAPP_TENANT_ID' })
  },
})
line({ tenant: process.env.WHATSAPP_TENANT_ID?.trim() ? 'configurado' : 'descubierto' })
const authDir = process.env.WHATSAPP_AUTH_DIR ?? join(REPO, 'data/whatsapp', tenantId)
const qrPng = join(authDir, 'qr.png')

const transport = new BaileysTransport({
  authDir,
  onIgnored: (reason) => {
    line({ ignored: reason })
  },
})
transport.onLinkEvent((e) => {
  if (e.type !== 'qr') {
    line({ connection: e.type === 'close' ? (e.loggedOut ? 'logged_out' : 'close') : e.type })
    return
  }
  // El código caduca en segundos y Baileys manda uno nuevo: cada vez se redibuja y se reescribe la imagen.
  if (!interactive) {
    line({ connection: 'qr', hint: 'escanéalo desde el backoffice: Configuración > Canales > WhatsApp' })
    return
  }
  void Promise.all([renderQrForTerminal(e.qr), writeQrPng(e.qr, qrPng)]).then(([art]) => {
    console.log(`\nEn el teléfono: WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo.\n${art}`)
    console.log(`Si la terminal lo deforma, abre la imagen: ${qrPng}. También aparece en el backoffice, en Configuración.`)
  })
})
const onError = (m: string) => {
  console.error(m)
}
const session = await startSessionPublisher({
  db: db.db,
  tenantId,
  transport,
  onError,
  onStatus: (s) => {
    line({ session: s })
  },
})
const relay = await startRelay({
  db: db.db,
  tenantId,
  transport,
  onError,
  onEvent: (e) => {
    if (e.type === 'incoming') line(e.kind === 'document' ? { incoming: 'document', bytes: String(e.bytes), hint: e.bytes > 0 ? 'guardado; el worker lo revisa' : 'sin bytes (muy grande o falló la descarga)' } : { incoming: e.kind })
    else line({ delivered: String(e.count) })
  },
})
const shutdown = async () => {
  await session.stop()
  await relay.stop()
  await db.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
