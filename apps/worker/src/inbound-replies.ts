/** Replies that inbound.ts builds from stored state: what is pending over chat and the reply to a duplicate PDF. */
import { AMOUNT_OFFER, ANALYST_NOTICE, DOCUMENT_REPLIES, failureNotice, INVOICE_REPLIES, isConversational, isDocumentRequest, renderDocumentRequest, renderQuestionAt, renderSummary } from '@gow/channels'
import { OwnerAnswer, Question, type FailureInfo, type Question as QuestionT } from '@gow/contracts'
import { decisions, invoiceIntakes, type clarifications, type inboundMessages, type Tx } from '@gow/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { OFFER_STEP, offerAmount } from './offer.ts'
import { verdictText } from './registration.ts'

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)
const OfferDraft = z.object({ max: z.number().positive() })

/**
 * What a linked number has pending over chat, to repeat after a photo or voice note: the amount
 * after the offer, the invoice question or the open clarification's prompt. Changes no state.
 */
export async function pendingChatPrompt(tx: Tx, msg: Pick<typeof inboundMessages.$inferSelect, 'channel' | 'fromAddress'>, openClarification: () => Promise<typeof clarifications.$inferSelect | undefined>): Promise<{ text: string | null; clarificationId: string | null }> {
  const [intake] = await tx
    .select({ step: invoiceIntakes.step, draft: invoiceIntakes.draft })
    .from(invoiceIntakes)
    .where(and(eq(invoiceIntakes.channel, msg.channel), eq(invoiceIntakes.address, msg.fromAddress), ne(invoiceIntakes.step, 'done')))
    .orderBy(desc(invoiceIntakes.createdAt))
    .limit(1)
  const offerMax = intake?.step === OFFER_STEP ? OfferDraft.safeParse(intake.draft) : null
  if (offerMax?.success) return { text: AMOUNT_OFFER.ask(offerMax.data.max), clarificationId: null }
  if (intake) return { text: intake.step === 'buyer' ? INVOICE_REPLIES.ask_buyer : intake.step === 'maturity' ? INVOICE_REPLIES.ask_maturity : INVOICE_REPLIES.ask_amount, clarificationId: null }
  const open = await openClarification()
  return open ? { text: clarificationPrompt(open), clarificationId: open.id } : { text: null, clarificationId: null }
}

/** What the clarification is waiting for: the current question, the summary or, once confirmed, the analyst notice. */
export function clarificationPrompt(open: typeof clarifications.$inferSelect): string {
  const questions = Questions.parse(open.questions)
  if (open.step === 'confirming') return renderSummary(questions, Answers.parse(open.answers))
  const q = questions[open.currentQuestion]
  if (open.step !== 'confirmed' && q && isDocumentRequest(q)) return renderDocumentRequest(q)
  return open.step !== 'confirmed' && q && isConversational(q) ? renderQuestionAt(questions, open.currentQuestion) : ANALYST_NOTICE
}

/**
 * The missing-pages question that the clarification is waiting on (`isDocumentRequest`) and that
 * the supplier's PDF answers: the one that was asked (`currentQuestion`) and is still unanswered.
 */
export function documentRequestOf(open: typeof clarifications.$inferSelect): QuestionT | undefined {
  if (open.step === 'confirmed') return undefined
  const q = Questions.parse(open.questions)[open.currentQuestion]
  return q && isDocumentRequest(q) && !Answers.parse(open.answers).some((a) => a.question_id === q.id) ? q : undefined
}

/**
 * What to reply to a PDF that was already sent: if still being analyzed, that there is no need to
 * send it again; if it failed, the same reason; if it has a verdict, the same notice. Never
 * "under review" for something that already finished.
 */
export async function duplicateReply(tx: Tx, prev: { id: string; status: string; request: unknown }, failure: FailureInfo | null, whatsapp: { tenantId: string; address: string } | null): Promise<string> {
  if (failure) return failureNotice(failure)
  const verdict = await verdictText(tx, prev)
  if (!verdict) return DOCUMENT_REPLIES.duplicate
  // If they have not yet said how much they want to advance, ask again.
  const [d] = whatsapp ? await tx.select({ limit: decisions.limitAmount }).from(decisions).where(and(eq(decisions.applicationId, prev.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1) : []
  const offer = whatsapp ? await offerAmount(tx, { tenantId: whatsapp.tenantId, applicationId: prev.id, status: prev.status, limit: d?.limit == null ? null : Number(d.limit), request: prev.request, channel: 'whatsapp', address: whatsapp.address }) : null
  return `Ya habíamos revisado este estado de cuenta. ${verdict}${offer ? `\n\n${offer}` : ''}`
}
