/* eslint-disable no-console -- entry point: connection status and the linking QR, no PII */
/**
 * `pnpm whatsapp`: one Baileys session for one tenant. With no config the tenant is the only one
 * that exists (it waits for first-run setup to create it); `WHATSAPP_TENANT_ID` pins it when there
 * are several, or in production. The number is linked by scanning the QR from the backoffice
 * settings: this process publishes session status to `app.whatsapp_sessions` and handles "Unlink".
 * On an interactive terminal the QR is also drawn here (and saved as qr.png next to the session);
 * without a TTY (Cloud Run) it is never printed, so it can't reach the logs. Once linked, the
 * session is stored and not asked for again.
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

// Without WHATSAPP_TENANT_ID the process finds its tenant (the only one) and waits for the
// backoffice setup wizard to create it if none exists yet.
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
  // The code expires in seconds and Baileys sends a new one: redraw and rewrite the image each time.
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
