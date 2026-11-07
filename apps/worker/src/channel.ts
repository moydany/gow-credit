/**
 * `ClarificationChannel` del modo full (docs/02 §3, docs/05 §2b): abrir una aclaración es una fila
 * con el destino copiado del vínculo verificado y, si hay preguntas por el chat, el primer mensaje en
 * el buzón de salida; si solo hay preguntas para el analista, el aviso de que un analista lo revisará
 * (ADR 0051). Quién lo entrega depende del canal: correo desde aquí (Resend), WhatsApp
 * desde apps/whatsapp, y en los escenarios el transporte simulado. Ningún código ni modelo pasa un
 * destinatario.
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
    // Páginas faltantes (robustez documental, sección W): sin preguntas de chat, el proveedor con WhatsApp
    // verificado recibe el pedido del PDF completo y el PDF nuevo lo contesta. Solo por WhatsApp: el
    // correo no recibe adjuntos (ADR 0037).
    const whatsappContact = contacts.find((c) => c.channel === 'whatsapp') ?? null
    const documentRequest = first < 0 && whatsappContact ? questions.findIndex(isDocumentRequest) : -1
    const chat = first >= 0 ? contact : documentRequest >= 0 ? whatsappContact : null
    const asked = first >= 0 ? first : documentRequest
    const channel = chat ? chat.channel : 'manual'
    const queued = await withTenant(this.#db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(clarifications)
        .values({ tenantId, applicationId, supplierId: supplier.id, round, channel, destination: chat?.address ?? null, contactId: chat?.id ?? null, questions, currentQuestion: Math.max(asked, 0) })
        // Un reintento del trabajo después de enviar no duplica la pregunta (una por ronda).
        .onConflictDoNothing()
        .returning({ id: clarifications.id })
      if (!row) return null
      await tx.insert(auditLog).values({ tenantId, actor: 'worker', action: 'clarification.opened', subject: row.id, details: { application_id: applicationId, round, channel, questions: questions.length } })
      // Registro en curso (ADR 0047): la pregunta sale cuando el proveedor confirma sus datos.
      if (identityPending(this.#ctx)) return null
      if (!chat) {
        // Solo preguntas para el analista (ADR 0051): el proveedor con WhatsApp verificado sabe que su
        // caso sigue. Sale una vez por ronda: un reintento no llega aquí (la fila ya existía).
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
