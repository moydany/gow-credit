/**
 * Full-mode `ClarificationChannel`: opening a clarification is a row with the destination copied
 * from the verified link and, if there are chat questions, the first message in the outbox; if
 * there are only analyst questions, a notice that an analyst will review it. Delivery depends on
 * the channel: email from here (Resend), WhatsApp from apps/whatsapp, and simulated transport in
 * scenarios. No code or model ever passes a recipient.
 */
import { ANALYST_NOTICE, isConversational, isDocumentRequest, nextConversational, renderDocumentRequest, renderQuestion, type Transport } from '@gow/channels'
import type { Question } from '@gow/contracts'
import { auditLog, clarifications, outboundMessages, withTenant, type Db } from '@gow/db'
import type { ClarificationChannel } from '@gow/mastra'
import { and, eq } from 'drizzle-orm'
import { identityPending, verifiedContacts, type AppContext } from './store.ts'

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
    // Missing pages (document robustness): with no chat questions, a supplier with verified WhatsApp
    // is asked for the complete PDF and the new PDF answers it. WhatsApp only: email takes no
    // attachments.
    const whatsappContact = contacts.find((c) => c.channel === 'whatsapp') ?? null
    const documentRequest = first < 0 && whatsappContact ? questions.findIndex(isDocumentRequest) : -1
    const chat = first >= 0 ? contact : documentRequest >= 0 ? whatsappContact : null
    const asked = first >= 0 ? first : documentRequest
    const channel = chat ? chat.channel : 'manual'
    const queued = await withTenant(this.#db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(clarifications)
        .values({ tenantId, applicationId, supplierId: supplier.id, round, channel, destination: chat?.address ?? null, contactId: chat?.id ?? null, questions, currentQuestion: Math.max(asked, 0) })
        // A job retry after sending does not duplicate the question (one per round).
        .onConflictDoNothing()
        .returning({ id: clarifications.id })
      if (!row) return null
      await tx.insert(auditLog).values({ tenantId, actor: 'worker', action: 'clarification.opened', subject: row.id, details: { application_id: applicationId, round, channel, questions: questions.length } })
      // Registration in progress: the question goes out when the supplier confirms their data.
      if (identityPending(this.#ctx)) return null
      if (!chat) {
        // Analyst-only questions: a supplier with verified WhatsApp learns their case is still open.
        // Sent once per round: a retry does not get here (the row already existed).
        if (first < 0 && whatsappContact) await tx.insert(outboundMessages).values({ tenantId, clarificationId: row.id, kind: 'analyst', channel: 'whatsapp', destination: whatsappContact.address, body: ANALYST_NOTICE })
        return null
      }
      const q = questions[asked] as Question
      const body = first >= 0 ? renderQuestion(q, 1, conversational) : renderDocumentRequest(q)
      const [msg] = await tx.insert(outboundMessages).values({ tenantId, clarificationId: row.id, kind: 'question', channel, destination: chat.address, body }).returning()
      return msg ?? null
    })
    if (queued && queued.channel === 'email' && this.#email) await deliver(this.#db, tenantId, this.#email, queued.id)
  }
}

/** Delivers an outbox message through its transport and marks it. The destination comes from the row, not the caller. */
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
