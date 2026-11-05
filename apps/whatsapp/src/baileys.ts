/**
 * Transporte con Baileys (WhatsApp Web, sesión por QR; ADR 0017). Es el único archivo que importa
 * Baileys: si la cuenta se suspende o Baileys cambia, se reemplaza por Cloud API sin tocar el
 * relay ni el worker (docs/02 §3).
 *
 * Pendiente declarado: la sesión vive en un directorio local (`useMultiFileAuthState`). docs/05 §5
 * pide guardarla cifrada en Storage; es del plan de despliegue. No se probó contra WhatsApp real:
 * hace falta un número dedicado y escanear el QR.
 */
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys'
import type { IncomingWhatsApp, WhatsAppTransport } from './relay.ts'

/** 5215511110001@s.whatsapp.net → +5215511110001 */
export function jidToNumber(jid: string): string | null {
  const m = /^(\d{8,15})@s\.whatsapp\.net$/.exec(jid)
  return m?.[1] ? `+${m[1]}` : null
}

export function numberToJid(number: string): string {
  return `${number.replace(/[^\d]/g, '')}@s.whatsapp.net`
}

export class BaileysTransport implements WhatsAppTransport {
  readonly #authDir: string
  readonly #onQr: (qr: string) => void
  readonly #onStatus: (status: string) => void
  #sock: WASocket | null = null
  #stopped = false

  constructor(opts: { authDir: string; onQr: (qr: string) => void; onStatus: (status: string) => void }) {
    this.#authDir = opts.authDir
    this.#onQr = opts.onQr
    this.#onStatus = opts.onStatus
  }

  async start(onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.#authDir)
    const sock = makeWASocket({ auth: state, markOnlineOnConnect: false })
    this.#sock = sock
    sock.ev.on('creds.update', () => void saveCreds())
    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.#onQr(u.qr)
      if (u.connection) this.#onStatus(u.connection)
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      // Reconecta salvo que la sesión se haya cerrado desde el teléfono.
      if (u.connection === 'close' && !this.#stopped && code !== DisconnectReason.loggedOut) void this.start(onMessage)
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        if (m.key.fromMe || !m.key.remoteJid || !m.key.id) continue
        const from = jidToNumber(m.key.remoteJid)
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? ''
        // Solo texto de chats uno a uno; grupos, estados y medios se ignoran.
        if (from && text) void onMessage({ from, id: m.key.id, text })
      }
    })
  }

  async send(to: string, text: string): Promise<void> {
    if (!this.#sock) throw new Error('WhatsApp no conectado')
    await this.#sock.sendMessage(numberToJid(to), { text })
  }

  stop(): Promise<void> {
    this.#stopped = true
    void this.#sock?.end(undefined)
    return Promise.resolve()
  }
}
