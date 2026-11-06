/**
 * Transporte con Baileys (WhatsApp Web, sesión por QR; ADR 0017). Es el único archivo que importa
 * Baileys: si la cuenta se suspende o Baileys cambia, se reemplaza por Cloud API sin tocar el
 * relay, la publicación del estado ni el worker (docs/02 §3).
 *
 * Pendiente declarado: la sesión vive en un directorio local (`useMultiFileAuthState`). docs/05 §5
 * pide guardarla cifrada en Storage; es del plan de despliegue. No se probó contra WhatsApp real:
 * hace falta un número dedicado y escanear el QR.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys'
import type { IncomingWhatsApp } from './relay.ts'
import type { LinkableTransport, LinkEvent } from './session.ts'

/** 5215511110001@s.whatsapp.net → +5215511110001 */
export function jidToNumber(jid: string): string | null {
  const m = /^(\d{8,15})@s\.whatsapp\.net$/.exec(jid)
  return m?.[1] ? `+${m[1]}` : null
}

/** La cuenta propia trae el dispositivo: 5215511110001:12@s.whatsapp.net → +5215511110001 */
export function accountJidToNumber(jid: string): string | null {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid)
  return m?.[1] ? `+${m[1]}` : null
}

export function numberToJid(number: string): string {
  return `${number.replace(/[^\d]/g, '')}@s.whatsapp.net`
}

/**
 * Borra el estado de autenticación que escribe `useMultiFileAuthState` (archivos `.json`) y el QR
 * guardado. No es recursivo ni borra otra cosa: un `WHATSAPP_AUTH_DIR` mal puesto no se lleva nada más.
 */
export async function clearAuthState(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const doomed = names.filter((n) => n.endsWith('.json') || n === 'qr.png')
  await Promise.all(doomed.map((n) => rm(join(dir, n), { force: true })))
  return doomed.length
}

const LOGOUT_TIMEOUT_MS = 10_000

export class BaileysTransport implements LinkableTransport {
  readonly #authDir: string
  readonly #listeners: ((e: LinkEvent) => void)[] = []
  #onMessage: ((m: IncomingWhatsApp) => Promise<void>) | null = null
  #sock: WASocket | null = null
  #open = false
  #stopped = false

  constructor(opts: { authDir: string }) {
    this.#authDir = opts.authDir
  }

  onLinkEvent(listener: (e: LinkEvent) => void): void {
    this.#listeners.push(listener)
  }

  #emit(e: LinkEvent): void {
    for (const l of this.#listeners) l(e)
  }

  async start(onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage
    await this.#connect()
  }

  async #connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.#authDir)
    const sock = makeWASocket({ auth: state, markOnlineOnConnect: false })
    this.#sock = sock
    sock.ev.on('creds.update', () => void saveCreds())
    sock.ev.on('connection.update', (u) => {
      // Un socket viejo (reemplazado al reconectar o al desvincular) ya no reporta nada.
      if (sock !== this.#sock || this.#stopped) return
      if (u.connection) this.#open = u.connection === 'open'
      if (u.qr) this.#emit({ type: 'qr', qr: u.qr })
      if (u.connection === 'connecting') this.#emit({ type: 'connecting' })
      if (u.connection === 'open') this.#emit({ type: 'open' })
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        this.#emit({ type: 'close', loggedOut })
        // Reconecta salvo que la sesión se haya cerrado desde el teléfono: ahí hace falta un QR nuevo,
        // que se pide desde el backoffice (desvincular) para no reintentar con credenciales muertas.
        if (!loggedOut) void this.#connect()
      }
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || !this.#onMessage) return
      for (const m of messages) {
        if (m.key.fromMe || !m.key.remoteJid || !m.key.id) continue
        const from = jidToNumber(m.key.remoteJid)
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? ''
        // Solo texto de chats uno a uno; grupos, estados y medios se ignoran.
        if (from && text) void this.#onMessage({ from, id: m.key.id, text })
      }
    })
  }

  connected(): boolean {
    return this.#open
  }

  linkedNumber(): string | null {
    const id = this.#sock?.user?.id
    return id ? accountJidToNumber(id) : null
  }

  /**
   * Desvincular: avisa a WhatsApp (el teléfono deja de listar este dispositivo), borra el estado
   * local y arranca una sesión nueva, que emite un QR nuevo para vincular este u otro número.
   * Si la sesión ya estaba cerrada, el aviso falla o vence y se sigue igual.
   */
  async unlink(): Promise<void> {
    const sock = this.#sock
    this.#sock = null
    this.#open = false
    if (sock) {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([sock.logout(), new Promise((_, reject) => (timer = setTimeout(() => { reject(new Error('logout timeout')) }, LOGOUT_TIMEOUT_MS)))])
      } catch {
        void sock.end(undefined)
      } finally {
        clearTimeout(timer)
      }
    }
    await clearAuthState(this.#authDir)
    if (!this.#stopped) await this.#connect()
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
