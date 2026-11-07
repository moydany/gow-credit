/**
 * WhatsApp relay for one tenant: delivers that tenant's outbox and inserts what arrives. It decides
 * nothing and doesn't match a message to a clarification; the worker does that against the verified
 * link. Runs as the `gow_whatsapp` role, which can only read and mark `outbound_messages` and
 * insert `inbound_messages`, to limit the blast radius.
 */
import { inboundMessages, outboundMessages, withTenant, type Db } from '@gow/db'
import { and, asc, eq } from 'drizzle-orm'

export interface IncomingWhatsApp {
  /** Number in +52... format. */
  from: string
  /** WhatsApp message id, for idempotency on redelivery. */
  id: string
  /** Message text or document caption; empty if only the document arrives. */
  text: string
  /**
   * Attached document. `bytes` is empty if it was dropped before download (too large); the worker
   * still replies so the sender knows it wasn't received.
   */
  document?: { bytes: Buffer; fileName: string | null; mediaType: string | null }
  /** Photo, voice note, video or sticker: type only, so the worker can ask for the PDF. Never downloaded. */
  media?: InboundMediaKind
}

/** Incoming non-text, non-document types that get a reply. Matches the CHECK on `inbound_messages.media_kind`. */
export const INBOUND_MEDIA_KINDS = ['image', 'audio', 'video', 'sticker'] as const
export type InboundMediaKind = (typeof INBOUND_MEDIA_KINDS)[number]

export interface WhatsAppTransport {
  start(onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void>
  send(to: string, text: string): Promise<void>
  stop(): Promise<void>
  /** Whether a session is open, if known. Without one we skip delivery, so nothing is marked failed while waiting for the QR. */
  connected?(): boolean
}

export async function storeIncoming(db: Db, tenantId: string, m: IncomingWhatsApp): Promise<void> {
  if (!m.text.trim() && !m.document && !m.media) return
  const doc = m.document
  const attachment = doc ? { attachment: doc.bytes, attachmentName: doc.fileName?.slice(0, 200) ?? null, attachmentMediaType: doc.mediaType?.slice(0, 100) ?? null } : {}
  // A document wins over the media kind: never store both.
  const media = !doc && m.media ? { mediaKind: m.media } : {}
  await withTenant(db, tenantId, (tx) => tx.insert(inboundMessages).values({ tenantId, channel: 'whatsapp', fromAddress: m.from, externalId: m.id, body: m.text.slice(0, 2000), ...attachment, ...media }).onConflictDoNothing())
}

/** Delivers the tenant's pending WhatsApp messages, oldest first. */
export async function deliverPending(db: Db, tenantId: string, transport: WhatsAppTransport, limit = 20): Promise<number> {
  if (transport.connected && !transport.connected()) return 0
  const pending = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: outboundMessages.id, destination: outboundMessages.destination, body: outboundMessages.body, attempts: outboundMessages.attempts })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.channel, 'whatsapp'), eq(outboundMessages.status, 'pending')))
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit),
  )
  for (const m of pending) {
    let ok = true
    try {
      await transport.send(m.destination, m.body)
    } catch {
      ok = false
    }
    const attempts = m.attempts + 1
    await withTenant(db, tenantId, (tx) =>
      tx
        .update(outboundMessages)
        .set(ok ? { status: 'sent', attempts, sentAt: new Date() } : { status: attempts >= 5 ? 'failed' : 'pending', attempts })
        .where(eq(outboundMessages.id, m.id)),
    )
  }
  return pending.length
}

/** What the relay reports to the console: types and sizes, never numbers, text or file names. */
export type RelayEvent = { type: 'incoming'; kind: 'text' | 'document' | InboundMediaKind; bytes: number } | { type: 'delivered'; count: number }

export async function startRelay(opts: { db: Db; tenantId: string; transport: WhatsAppTransport; pollMs?: number; onError?: (message: string) => void; onEvent?: (e: RelayEvent) => void }): Promise<{ stop(): Promise<void> }> {
  await opts.transport.start(async (m) => {
    await storeIncoming(opts.db, opts.tenantId, m)
    opts.onEvent?.({ type: 'incoming', kind: m.document ? 'document' : (m.media ?? 'text'), bytes: m.document?.bytes.length ?? 0 })
  })
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    deliverPending(opts.db, opts.tenantId, opts.transport)
      .then((count) => {
        if (count > 0) opts.onEvent?.({ type: 'delivered', count })
      })
      .catch((err: unknown) => opts.onError?.(`entrega: ${err instanceof Error ? err.name : 'error'}`))
      .finally(() => {
        busy = false
      })
  }, opts.pollMs ?? 2000)
  return {
    stop: async () => {
      clearInterval(timer)
      await opts.transport.stop()
    },
  }
}
