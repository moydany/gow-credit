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
  text: string
}

export interface WhatsAppTransport {
  start(onMessage: (m: IncomingWhatsApp) => Promise<void>): Promise<void>
  send(to: string, text: string): Promise<void>
  stop(): Promise<void>
}

export async function storeIncoming(db: Db, tenantId: string, m: IncomingWhatsApp): Promise<void> {
  if (!m.text.trim()) return
  await withTenant(db, tenantId, (tx) => tx.insert(inboundMessages).values({ tenantId, channel: 'whatsapp', fromAddress: m.from, externalId: m.id, body: m.text.slice(0, 2000) }).onConflictDoNothing())
}

/** Entrega los pendientes de WhatsApp del tenant, del más viejo al más nuevo. */
export async function deliverPending(db: Db, tenantId: string, transport: WhatsAppTransport, limit = 20): Promise<number> {
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

export async function startRelay(opts: { db: Db; tenantId: string; transport: WhatsAppTransport; pollMs?: number; onError?: (message: string) => void }): Promise<{ stop(): Promise<void> }> {
  await opts.transport.start((m) => storeIncoming(opts.db, opts.tenantId, m))
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    deliverPending(opts.db, opts.tenantId, opts.transport)
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
