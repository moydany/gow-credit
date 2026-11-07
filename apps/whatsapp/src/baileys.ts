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
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState, type WAMessage, type WASocket } from '@whiskeysockets/baileys'
import type { IncomingWhatsApp, InboundMediaKind } from './relay.ts'
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

/**
 * Número del remitente de un chat uno a uno. Desde Baileys 7, WhatsApp identifica muchos chats con un
 * LID (`…@lid`, un id anónimo) en lugar del número: se prueba el JID, luego el alterno que trae la
 * llave y, si ninguno es un número, el mapa LID→número de la sesión. Grupos y estados devuelven null.
 */
export async function senderNumber(key: { remoteJid?: string | null; remoteJidAlt?: string | null }, lidToPn: (lid: string) => Promise<string | null>): Promise<string | null> {
  const jids = [key.remoteJid, key.remoteJidAlt].filter((j): j is string => typeof j === 'string' && j.length > 0)
  for (const jid of jids) {
    const n = accountJidToNumber(jid)
    if (n) return n
  }
  const lid = jids.find((j) => j.endsWith('@lid'))
  if (!lid) return null
  try {
    const pn = await lidToPn(lid)
    return pn ? accountJidToNumber(pn) : null
  } catch {
    return null
  }
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

/** Por qué no se guardó un mensaje entrante; va a la consola, sin datos del remitente. */
export type IgnoredReason = 'group_or_status' | 'unknown_sender' | 'unsupported_type'

/**
 * Tope de descarga de un documento entrante (ADR 0037): el mismo de `MAX_DOCUMENT_BYTES` en
 * @gow/platform, que este proceso no importa porque no toca el almacenamiento. El worker vuelve a
 * validar tamaño y formato antes de aceptarlo.
 */
export const MAX_INBOUND_DOCUMENT_BYTES = 40 * 1024 * 1024

/** El documento de un mensaje, con o sin pie de foto (Baileys los envuelve distinto). */
export function documentOf(message: WAMessage['message']): { caption: string; fileName: string | null; mediaType: string | null; size: number } | null {
  const doc = message?.documentMessage ?? message?.documentWithCaptionMessage?.message?.documentMessage
  if (!doc) return null
  return { caption: doc.caption ?? '', fileName: doc.fileName ?? null, mediaType: doc.mimetype ?? null, size: Number(doc.fileLength ?? 0) }
}

/**
 * Foto, nota de voz, video o sticker (ADR 0051): se contesta que hace falta el PDF. Lo demás que no es
 * texto ni documento (reacciones, ubicaciones, contactos, avisos del protocolo) se sigue ignorando.
 */
export function mediaKindOf(message: WAMessage['message']): { kind: InboundMediaKind; caption: string } | null {
  const inner = message?.viewOnceMessage?.message ?? message?.viewOnceMessageV2?.message ?? message?.ephemeralMessage?.message ?? message
  if (inner?.imageMessage) return { kind: 'image', caption: inner.imageMessage.caption ?? '' }
  if (inner?.videoMessage) return { kind: 'video', caption: inner.videoMessage.caption ?? '' }
  if (inner?.ptvMessage) return { kind: 'video', caption: '' }
  if (inner?.audioMessage) return { kind: 'audio', caption: '' }
  if (inner?.stickerMessage) return { kind: 'sticker', caption: '' }
  return null
}

type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>
/**
 * Baileys registra por defecto con pino en nivel `info`, y lo que registra trae el número de la
 * cuenta (el `username` del login) y nodos del protocolo. Sin PII en registros: se calla. El
 * estado de la conexión sale por los eventos, que solo llevan códigos.
 */
const silent: BaileysLogger = {
  level: 'silent',
  child: () => silent,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

export class BaileysTransport implements LinkableTransport {
  readonly #authDir: string
  readonly #listeners: ((e: LinkEvent) => void)[] = []
  #onMessage: ((m: IncomingWhatsApp) => Promise<void>) | null = null
  #sock: WASocket | null = null
  #open = false
  #stopped = false

  readonly #onIgnored: (reason: IgnoredReason) => void

  constructor(opts: { authDir: string; onIgnored?: (reason: IgnoredReason) => void }) {
    this.#authDir = opts.authDir
    this.#onIgnored = opts.onIgnored ?? (() => undefined)
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
    const sock = makeWASocket({ auth: state, markOnlineOnConnect: false, logger: silent })
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
      for (const m of messages) void this.#receive(sock, m)
    })
  }

  /**
   * Solo chats uno a uno: texto y documentos (ADR 0037). Fotos, notas de voz, videos y stickers pasan
   * solo con su tipo, sin descargarlos, para que el worker conteste que hace falta el PDF (ADR 0051).
   * Grupos y estados se ignoran. Un documento se descarga aquí porque el enlace del medio caduca; si
   * excede el tope o la descarga falla, se pasa vacío para que el worker le conteste a quien lo mandó.
   */
  async #receive(sock: WASocket, m: WAMessage): Promise<void> {
    const onMessage = this.#onMessage
    if (!onMessage || m.key.fromMe || !m.key.remoteJid || !m.key.id) return
    if (/@(g\.us|broadcast|newsletter)$/.test(m.key.remoteJid)) {
      this.#onIgnored('group_or_status')
      return
    }
    const from = await senderNumber(m.key, (lid) => sock.signalRepository.lidMapping.getPNForLID(lid))
    if (!from) {
      this.#onIgnored('unknown_sender')
      return
    }
    const doc = documentOf(m.message)
    if (!doc) {
      const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? ''
      const media = mediaKindOf(m.message)
      if (media) await onMessage({ from, id: m.key.id, text: media.caption, media: media.kind })
      else if (text) await onMessage({ from, id: m.key.id, text })
      else this.#onIgnored('unsupported_type')
      return
    }
    let bytes: Buffer = Buffer.alloc(0)
    if (doc.size <= MAX_INBOUND_DOCUMENT_BYTES) {
      try {
        const got = await downloadMediaMessage(m, 'buffer', {}, { logger: silent, reuploadRequest: sock.updateMediaMessage })
        if (got.length <= MAX_INBOUND_DOCUMENT_BYTES) bytes = got
      } catch {
        // Sin bytes: el worker contesta que no se pudo recibir.
      }
    }
    await onMessage({ from, id: m.key.id, text: doc.caption, document: { bytes, fileName: doc.fileName, mediaType: doc.mediaType } })
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
