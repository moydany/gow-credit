/**
 * Baileys transport (WhatsApp Web, linked by QR). The only file that imports Baileys, so it can be
 * swapped for the Cloud API without touching the relay, the status publisher or the worker.
 *
 * Known gap: the session lives in a local directory (`useMultiFileAuthState`); it should be stored
 * encrypted in Storage. Not tested against real WhatsApp: that needs a dedicated number and a QR scan.
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

/** The linked account's own JID includes the device: 5215511110001:12@s.whatsapp.net → +5215511110001 */
export function accountJidToNumber(jid: string): string | null {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid)
  return m?.[1] ? `+${m[1]}` : null
}

/**
 * Sender number of a one-to-one chat. Since Baileys 7 many chats use an anonymous LID (`...@lid`)
 * instead of the number, so try the JID, then the alternate JID on the key, then the session's
 * LID-to-number map. Groups and statuses return null.
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
 * Deletes the `.json` files written by `useMultiFileAuthState` plus the saved QR. Not recursive and
 * touches nothing else, so a wrong `WHATSAPP_AUTH_DIR` can't wipe unrelated files.
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

/** Why an incoming message was not stored. Goes to the console, with no sender data. */
export type IgnoredReason = 'group_or_status' | 'unknown_sender' | 'unsupported_type'

/**
 * Download cap for an incoming document. Same value as `MAX_DOCUMENT_BYTES` in @gow/platform, which
 * this process doesn't import because it never touches storage. The worker re-checks size and format.
 */
export const MAX_INBOUND_DOCUMENT_BYTES = 40 * 1024 * 1024

/** The document in a message, with or without a caption (Baileys wraps them differently). */
export function documentOf(message: WAMessage['message']): { caption: string; fileName: string | null; mediaType: string | null; size: number } | null {
  const doc = message?.documentMessage ?? message?.documentWithCaptionMessage?.message?.documentMessage
  if (!doc) return null
  return { caption: doc.caption ?? '', fileName: doc.fileName ?? null, mediaType: doc.mimetype ?? null, size: Number(doc.fileLength ?? 0) }
}

/**
 * Photo, voice note, video or sticker: the sender is told a PDF is needed. Anything else that isn't
 * text or a document (reactions, locations, contacts, protocol notices) is still ignored.
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
 * Baileys logs through pino at `info` by default, and those logs include the account number and
 * protocol nodes. No PII in logs, so it stays silent; connection state comes from events instead.
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
      // A stale socket (replaced on reconnect or unlink) reports nothing.
      if (sock !== this.#sock || this.#stopped) return
      if (u.connection) this.#open = u.connection === 'open'
      if (u.qr) this.#emit({ type: 'qr', qr: u.qr })
      if (u.connection === 'connecting') this.#emit({ type: 'connecting' })
      if (u.connection === 'open') this.#emit({ type: 'open' })
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        this.#emit({ type: 'close', loggedOut })
        // Reconnect unless the session was closed from the phone: that needs a fresh QR (unlink
        // in the backoffice) rather than retrying with dead credentials.
        if (!loggedOut) void this.#connect()
      }
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || !this.#onMessage) return
      for (const m of messages) void this.#receive(sock, m)
    })
  }

  /**
   * One-to-one chats only: text and documents. Photos, voice notes, videos and stickers are passed
   * on by type without downloading, so the worker can ask for the PDF. Groups and statuses are
   * ignored. Documents are downloaded here because the media link expires; if one is over the cap
   * or the download fails, empty bytes go through so the worker can reply to the sender.
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
        // No bytes: the worker replies that it couldn't be received.
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
   * Unlink: tells WhatsApp (the phone stops listing this device), wipes local state and starts a
   * fresh session that emits a new QR for this or another number. If the session was already
   * closed, the logout fails or times out and we carry on.
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
