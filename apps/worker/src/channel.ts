/**
 * `ClarificationChannel` del modo full (docs/02 §3, docs/05 §2b): abrir una aclaración es una fila
 * con el destino copiado del vínculo verificado y, si hay preguntas de abono, el primer mensaje en
 * el buzón de salida. Quién lo entrega depende del canal: correo desde aquí (Resend), WhatsApp
 * desde apps/whatsapp, y en los escenarios el transporte simulado. Ningún código ni modelo pasa un
 * destinatario.
 */
import { isConversational, nextConversational, renderQuestion, type Transport } from '@gow/channels'
import type { Question } from '@gow/contracts'
import { auditLog, clarifications, outboundMessages, withTenant, type Db } from '@gow/db'
import type { ClarificationChannel } from '@gow/mastra'
import { and, eq } from 'drizzle-orm'
import { verifiedContacts, type AppContext } from './store.ts'

export class DbClarificationChannel implements ClarificationChannel {
  readonly name = 'database'
  readonly #db: Db
  readonly #ctx: AppContext
  readonly #email: Transport | null

  constructor(db: Db, ctx: AppContext, opts: { email?: Transport | null } = {}) {
    this.#db = db
    this.#ctx = ctx
    this.#email = opts.email ?? null
  }

  async send(applicationId: string, round: number, questions: readonly Question[]): Promise<void> {
    const { tenantId, supplier } = this.#ctx
    const contacts = await verifiedContacts(this.#db, tenantId, supplier.id)
    const contact = contacts.find((c) => c.channel === 'whatsapp') ?? contacts.find((c) => c.channel === 'email') ?? null
    const first = nextConversational(questions, 0)
    const conversational = questions.filter(isConversational).length
    const channel = contact && first >= 0 ? contact.channel : 'manual'
    const queued = await withTenant(this.#db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(clarifications)
        .values({ tenantId, applicationId, supplierId: supplier.id, round, channel, destination: channel === 'manual' ? null : (contact?.address ?? null), contactId: channel === 'manual' ? null : (contact?.id ?? null), questions, currentQuestion: Math.max(first, 0) })
        // Un reintento del trabajo después de enviar no duplica la pregunta (una por ronda).
        .onConflictDoNothing()
        .returning({ id: clarifications.id })
      if (!row) return null
      await tx.insert(auditLog).values({ tenantId, actor: 'worker', action: 'clarification.opened', subject: row.id, details: { application_id: applicationId, round, channel, questions: questions.length } })
      if (channel === 'manual' || !contact || first < 0) return null
      const q = questions[first] as Question
      const [msg] = await tx.insert(outboundMessages).values({ tenantId, clarificationId: row.id, kind: 'question', channel, destination: contact.address, body: renderQuestion(q, 1, conversational) }).returning()
      return msg ?? null
    })
    if (queued && queued.channel === 'email' && this.#email) await deliver(this.#db, tenantId, this.#email, queued.id)
  }
}

/** Entrega un mensaje del buzón por su transporte y lo marca. El destino sale de la fila, no del llamador. */
export async function deliver(db: Db, tenantId: string, transport: Transport, messageId: string): Promise<void> {
  const [msg] = await withTenant(db, tenantId, (tx) => tx.select().from(outboundMessages).where(and(eq(outboundMessages.id, messageId), eq(outboundMessages.status, 'pending'))))
  if (!msg || msg.channel !== transport.channel) return
  try {
    await transport.send({ id: msg.id, channel: transport.channel, destination: msg.destination, body: msg.body })
    await withTenant(db, tenantId, (tx) => tx.update(outboundMessages).set({ status: 'sent', sentAt: new Date(), attempts: msg.attempts + 1 }).where(eq(outboundMessages.id, msg.id)))
  } catch {
    await withTenant(db, tenantId, (tx) => tx.update(outboundMessages).set({ status: msg.attempts + 1 >= 5 ? 'failed' : 'pending', attempts: msg.attempts + 1 }).where(eq(outboundMessages.id, msg.id)))
  }
}
