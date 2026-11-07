/**
 * Relay de WhatsApp de un tenant (docs/05 §2b, "radio de daño"): entrega lo que hay en el buzón de
 * salida de ese tenant e inserta lo que llega. No decide nada ni resuelve a qué aclaración
 * pertenece un mensaje: eso lo hace el worker contra el vínculo verificado. Corre con el rol
 * `gow_whatsapp`, que solo puede leer y marcar `outbound_messages` e insertar `inbound_messages`.
 */
import { inboundMessages, outboundMessages, withTenant, type Db } from '@gow/db'
import { and, asc, eq } from 'drizzle-orm'

export interface IncomingWhatsApp {
  /** Número en formato +52... */
  from: string
  /** Id del mensaje en WhatsApp: idempotencia ante reentregas. */
  id: string
  /** Texto del mensaje o pie del documento; vacío si solo llega el documento. */
  text: string
  /**
   * Documento adjunto (ADR 0037). `bytes` vacío si se descartó antes de descargar (demasiado grande):
   * el worker contesta igual, para que quien lo mandó sepa que no se recibió.
   */
  document?: { bytes: Buffer; fileName: string | null; mediaType: string | null }
  /**
   * Foto, nota de voz, video o sticker (ADR 0051): solo el tipo, para que el worker conteste que hace
   * falta el PDF. Los bytes nunca se descargan.
   */
  media?: InboundMediaKind
}

/** Lo que llega y no es texto ni documento, y se contesta (ADR 0051). Igual que el CHECK de `inbound_messages.media_kind`. */
export const INBOUND_MEDIA_KINDS = ['image', 'audio', 'video', 'sticker'] as const
export type InboundMediaKind = (typeof INBOUND_MEDIA_KINDS)[number]

export interface WhatsAppTransport {
  start(onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void>
  send(to: string, text: string): Promise<void>
  stop(): Promise<void>
  /** Si se sabe, ¿hay sesión abierta? Sin ella no se intenta entregar: esperando el QR, nada se marca fallido. */
  connected?(): boolean
}

export async function storeIncoming(db: Db, tenantId: string, m: IncomingWhatsApp): Promise<void> {
  if (!m.text.trim() && !m.document && !m.media) return
  const doc = m.document
  const attachment = doc ? { attachment: doc.bytes, attachmentName: doc.fileName?.slice(0, 200) ?? null, attachmentMediaType: doc.mediaType?.slice(0, 100) ?? null } : {}
  // Un documento manda sobre el tipo de medio: nunca se guardan los dos.
  const media = !doc && m.media ? { mediaKind: m.media } : {}
  await withTenant(db, tenantId, (tx) => tx.insert(inboundMessages).values({ tenantId, channel: 'whatsapp', fromAddress: m.from, externalId: m.id, body: m.text.slice(0, 2000), ...attachment, ...media }).onConflictDoNothing())
}

/** Entrega los pendientes de WhatsApp del tenant, del más viejo al más nuevo. */
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

/** Lo que el relay reporta para la consola: tipos y tamaños, nunca números, textos ni nombres de archivo. */
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
