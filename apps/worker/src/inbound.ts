/**
 * Resolución de cada mensaje entrante (docs/05 §2b):
 *
 * 1. Llega un mensaje de N por el canal del tenant T (el proceso de WhatsApp o el webhook de
 *    correo ya fijaron T).
 * 2. Vínculos verificados (T, canal, N). Sin vínculo: respuesta fija y registro; nada se encola.
 * 3. Con vínculo: solo las aclaraciones abiertas de esos proveedores con ese destino. El texto del
 *    mensaje nunca autoriza nada: citar un folio ajeno no abre esa solicitud.
 * 4. Se lee la respuesta contra la pregunta que se espera; ambigua → se repregunta con números.
 * 5. Respondidas todas las preguntas, la aclaración queda `answered` y se encola la reanudación.
 */
import { GENERIC_NO_PENDING, isComplete, nextConversational, parseReply, renderQuestion, renderReask } from '@gow/channels'
import { OwnerAnswer, Question, type Question as QuestionT } from '@gow/contracts'
import { auditLog, clarifications, inboundMessages, outboundMessages, supplierContacts, withTenant, type Db } from '@gow/db'
import type { ResumeJob } from '@gow/platform'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

export type Resolution = 'matched' | 'completed' | 'no_link' | 'no_open_clarification' | 'unparsed' | 'already_processed'

export interface InboundResult {
  resolution: Resolution
  resume: ResumeJob | null
}

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)

export async function resolveInbound(db: Db, tenantId: string, messageId: string): Promise<InboundResult> {
  return withTenant(db, tenantId, async (tx) => {
    const [msg] = await tx.select().from(inboundMessages).where(and(eq(inboundMessages.id, messageId), isNull(inboundMessages.processedAt)))
    if (!msg) return { resolution: 'already_processed', resume: null }
    const finish = async (resolution: Resolution, clarificationId: string | null, reply: { body: string; kind: string } | null) => {
      await tx.update(inboundMessages).set({ processedAt: new Date(), resolution, clarificationId }).where(eq(inboundMessages.id, msg.id))
      if (reply && msg.channel !== 'manual') await tx.insert(outboundMessages).values({ tenantId, clarificationId, kind: reply.kind, channel: msg.channel, destination: msg.fromAddress, body: reply.body })
      // El número va solo en la fila del mensaje; la bitácora lleva ids y la resolución.
      await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: `inbound.${resolution}`, subject: msg.id, details: { clarification_id: clarificationId } })
    }

    const links = await tx
      .select({ supplierId: supplierContacts.supplierId })
      .from(supplierContacts)
      .where(and(eq(supplierContacts.channel, msg.channel), eq(supplierContacts.address, msg.fromAddress), isNotNull(supplierContacts.verifiedAt)))
    if (links.length === 0) {
      await finish('no_link', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_link', resume: null }
    }
    const [open] = await tx
      .select()
      .from(clarifications)
      .where(and(eq(clarifications.status, 'open'), eq(clarifications.channel, msg.channel), eq(clarifications.destination, msg.fromAddress), inArray(clarifications.supplierId, links.map((l) => l.supplierId))))
      .orderBy(asc(clarifications.createdAt))
      .limit(1)
    if (!open) {
      await finish('no_open_clarification', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_open_clarification', resume: null }
    }

    const questions: QuestionT[] = Questions.parse(open.questions)
    const answers = Answers.parse(open.answers)
    const current = questions[open.currentQuestion]
    const answer = current ? parseReply(msg.body, current) : null
    if (!current || !answer) {
      await finish('unparsed', open.id, current ? { body: renderReask(current), kind: 'reask' } : null)
      return { resolution: 'unparsed', resume: null }
    }
    const nextAnswers = [...answers.filter((a) => a.question_id !== answer.question_id), answer]
    const next = nextConversational(questions, open.currentQuestion + 1)
    const done = isComplete(questions, nextAnswers)
    await tx
      .update(clarifications)
      .set({ answers: nextAnswers, currentQuestion: next >= 0 ? next : open.currentQuestion, ...(done ? { status: 'answered' as const, answeredAt: sql`now()` } : {}) })
      .where(eq(clarifications.id, open.id))
    const conversational = questions.filter((q) => q.kind === 'deposit').length
    const position = questions.slice(0, next + 1).filter((q) => q.kind === 'deposit').length
    const reply = next >= 0 ? { body: renderQuestion(questions[next] as QuestionT, position, conversational), kind: 'question' } : null
    await finish(done ? 'completed' : 'matched', open.id, reply)
    return { resolution: done ? 'completed' : 'matched', resume: done ? { tenant_id: tenantId, application_id: open.applicationId, clarification_id: open.id } : null }
  })
}

/** Mensajes entrantes sin procesar de todos los tenants (función revisada, solo ids). */
export async function pendingInbound(db: Db, limit = 50): Promise<{ id: string; tenant_id: string }[]> {
  const res = await db.execute<{ id: string; tenant_id: string }>(sql`select id, tenant_id from app.pending_inbound(${limit})`)
  return res.rows
}
