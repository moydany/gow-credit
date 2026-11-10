/**
 * PDFs sent together over WhatsApp. WhatsApp has no message with several files: the
 * PDFs a supplier picks together arrive as separate messages, seconds apart. When the tenant's
 * active policy evaluates more than one month (`history.months`), what the first PDF starts waits
 * `SEND_WINDOW_SECONDS` (the analysis of the request it opens, or the resume when it answers the
 * missing-months question), and a PDF from the same supplier inside that window joins it instead
 * of opening another request.
 */
import { OwnerAnswer, Question } from '@gow/contracts'
import { applicationDocuments, applications, clarifications, policyVersions, type Tx } from '@gow/db'
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/** How long the first PDF of a send waits for the others. */
export const SEND_WINDOW_SECONDS = 60

const PolicyHistory = z.object({ history: z.object({ months: z.number().int().min(1) }).optional() })

/** `history.months` of the tenant's active policy; 1 without a policy or without the field. */
export async function historyMonthsOf(tx: Tx): Promise<number> {
  const [row] = await tx.select({ document: policyVersions.document }).from(policyVersions).where(eq(policyVersions.status, 'active')).limit(1)
  const parsed = PolicyHistory.safeParse(row?.document)
  return parsed.success ? (parsed.data.history?.months ?? 1) : 1
}

const withinWindow = (column: AnyPgColumn): SQL => sql`${column} >= now() - make_interval(secs => ${SEND_WINDOW_SECONDS})`

/** Where a PDF of an ongoing send goes: the request the first one opened, or its missing-months answer. */
export type SendTarget = { kind: 'application'; applicationId: string } | { kind: 'answer'; applicationId: string; clarificationId: string; questionId: string }

/** The send this supplier has open on this contact, if any. */
export async function openSendOf(tx: Tx, supplierId: string, contact: { channel: (typeof clarifications.$inferSelect)['channel']; address: string }): Promise<SendTarget | null> {
  const [opened] = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.supplierId, supplierId), eq(applications.status, 'received'), isNull(applications.runId), withinWindow(applications.createdAt)))
    .orderBy(desc(applications.createdAt))
    .limit(1)
  if (opened) return { kind: 'application', applicationId: opened.id }
  // The missing months were answered in this send and the resume has not run yet.
  const [answered] = await tx
    .select({ id: clarifications.id, applicationId: clarifications.applicationId, questions: clarifications.questions, answers: clarifications.answers })
    .from(clarifications)
    .innerJoin(applications, eq(applications.id, clarifications.applicationId))
    .where(
      and(
        eq(clarifications.supplierId, supplierId),
        eq(clarifications.status, 'answered'),
        eq(clarifications.channel, contact.channel),
        eq(clarifications.destination, contact.address),
        eq(applications.status, 'needs_clarification'),
        withinWindow(clarifications.answeredAt),
      ),
    )
    .orderBy(desc(clarifications.answeredAt))
    .limit(1)
  if (!answered) return null
  const months = z.array(Question).parse(answered.questions).find((q) => q.topic === 'additional_months')
  const answer = z.array(OwnerAnswer).parse(answered.answers).find((a) => a.question_id === months?.id && a.kind === 'documents')
  if (!months || !answer) return null
  return { kind: 'answer', applicationId: answered.applicationId, clarificationId: answered.id, questionId: months.id }
}

/** Adds the stored PDF to the send. `duplicate` if it was already in that request. */
export async function joinSend(tx: Tx, tenantId: string, target: SendTarget, doc: { documentId: string; storagePath: string }): Promise<'joined' | 'duplicate'> {
  const [linked] = await tx
    .select({ documentId: applicationDocuments.documentId })
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, target.applicationId), eq(applicationDocuments.documentId, doc.documentId)))
  if (linked) return 'duplicate'
  await tx.insert(applicationDocuments).values({ tenantId, applicationId: target.applicationId, documentId: doc.documentId, origin: target.kind === 'answer' ? 'owner_answer' : 'submitted' })
  if (target.kind === 'answer') {
    const [row] = await tx.select({ answers: clarifications.answers }).from(clarifications).where(eq(clarifications.id, target.clarificationId))
    const answers = z
      .array(OwnerAnswer)
      .parse(row?.answers ?? [])
      .map((a) => (a.question_id === target.questionId && a.kind === 'documents' ? { ...a, paths: [...a.paths, doc.storagePath] } : a))
    await tx.update(clarifications).set({ answers }).where(eq(clarifications.id, target.clarificationId))
  }
  return 'joined'
}
