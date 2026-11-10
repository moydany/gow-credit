import {
  ANALYST_NOTICE,
  CONFIRMATION_REPLIES,
  CONVERSATION_FALLBACKS,
  conversationalIndexes,
  documentRequestReplies,
  isComplete,
  isConversational,
  isDocumentRequest,
  parseConfirmation,
  parseMultipleReplies,
  parseReply,
  parseYesNo,
  renderQuestionAt,
  renderReask,
  renderSummary,
} from '@gow/channels'
import {
  OwnerAnswer,
  Question,
  type OwnerAnswer as OwnerAnswerT,
  type Question as QuestionT,
} from '@gow/contracts'
import { clarifications } from '@gow/db'
import type { ResumeJob } from '@gow/platform'
import { eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { InboundContext, InboundResult } from './inbound-context.ts'
import type { Resolution } from './inbound-types.ts'

export type ClarificationRow = typeof clarifications.$inferSelect

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)

type AnswerFn = (
  resolution: Resolution,
  body: string,
  kind: string,
  set?: PgUpdateSetSource<typeof clarifications>,
  resume?: ResumeJob | null,
) => Promise<InboundResult>

function withMergedAnswers(existing: readonly OwnerAnswerT[], given: readonly OwnerAnswerT[]): OwnerAnswerT[] {
  return [...existing.filter((a) => !given.some((g) => g.question_id === a.question_id)), ...given]
}

async function readOneAnswer(
  ctx: InboundContext,
  q: QuestionT,
): Promise<{ answer: OwnerAnswerT | null; offTopic: boolean }> {
  const direct = parseReply(ctx.msg.body, q)
  if (direct || q.options.length === 0) return { answer: direct, offTopic: false }
  const read = await ctx.readField('option', q.text, (t) => parseReply(t, q), {
    options: q.options.map((o) => o.label),
  })
  return {
    answer: 'value' in read ? read.value : null,
    offTopic: 'invalid' in read && read.invalid === 'off_topic',
  }
}

function resolveReaskText(q: QuestionT, offTopic: boolean): string {
  return offTopic ? `${CONVERSATION_FALLBACKS.off_topic}\n\n${renderReask(q)}` : renderReask(q)
}

async function handleConfirmingStep(
  ctx: InboundContext,
  open: ClarificationRow,
  questions: QuestionT[],
  answers: OwnerAnswerT[],
  convo: readonly number[],
  answer: AnswerFn,
): Promise<InboundResult> {
  const summary = () => renderSummary(questions, answers)
  let read = parseConfirmation(ctx.msg.body, questions)
  if (!read) {
    const yes = await ctx.readField('option', summary(), parseYesNo, {
      options: ['Sí, es correcto', 'No, quiero cambiar una respuesta'],
    })
    if ('value' in yes) read = yes.value ? { kind: 'confirm' } : { kind: 'reject' }
  }
  if (!read) return answer('awaiting_confirmation', `${CONVERSATION_FALLBACKS.not_understood}\n\n${summary()}`, 'summary')
  if (read.kind === 'reject') return answer('awaiting_confirmation', CONFIRMATION_REPLIES.which, 'summary')
  if (read.kind === 'change' || read.kind === 'correct') {
    const index = convo[read.number - 1]
    if (index === undefined) {
      return answer(
        'awaiting_confirmation',
        `${CONFIRMATION_REPLIES.no_such(read.number, convo.length)}\n\n${summary()}`,
        'summary',
      )
    }
    if (read.kind === 'change') {
      return answer('revising', renderQuestionAt(questions, index), 'question', {
        step: 'revising',
        currentQuestion: index,
      })
    }
    const updated = withMergedAnswers(answers, [read.answer])
    // The summary shows the answers as they are after the correction, not the ones it replaced.
    return answer(
      'corrected',
      `${CONFIRMATION_REPLIES.changed(read.number)}\n\n${renderSummary(questions, updated)}`,
      'summary',
      { answers: updated },
    )
  }
  if (isComplete(questions, answers)) {
    return answer(
      'completed',
      CONFIRMATION_REPLIES.sent,
      'confirmation',
      { step: 'confirmed', status: 'answered', answeredAt: sql`now()` },
      {
        tenant_id: ctx.tenantId,
        application_id: open.applicationId,
        clarification_id: open.id,
      },
    )
  }
  return answer('confirmed', CONFIRMATION_REPLIES.sent_analyst, 'analyst', { step: 'confirmed' })
}

async function handleRevisingStep(
  ctx: InboundContext,
  open: ClarificationRow,
  current: QuestionT,
  questions: QuestionT[],
  answers: OwnerAnswerT[],
  convo: readonly number[],
  answer: AnswerFn,
): Promise<InboundResult> {
  const read = await readOneAnswer(ctx, current)
  if (!read.answer) return answer('unparsed', resolveReaskText(current, read.offTopic), 'reask')
  const updated = withMergedAnswers(answers, [read.answer])
  return answer(
    'corrected',
    `${CONFIRMATION_REPLIES.changed(convo.indexOf(open.currentQuestion) + 1)}\n\n${renderSummary(questions, updated)}`,
    'summary',
    { answers: updated, step: 'confirming' },
  )
}

async function handleAskingStep(
  ctx: InboundContext,
  open: ClarificationRow,
  current: QuestionT,
  questions: QuestionT[],
  answers: OwnerAnswerT[],
  convo: readonly number[],
  answer: AnswerFn,
): Promise<InboundResult> {
  const pending = convo.filter((i) => i >= open.currentQuestion).map((i) => questions[i] as QuestionT)
  const multi = parseMultipleReplies(ctx.msg.body, pending)
  let given: OwnerAnswerT[]
  if (multi?.kind === 'answers') {
    given = multi.answers
  } else if (multi) {
    return answer(
      'unparsed',
      `${multi.kind === 'too_many' ? CONFIRMATION_REPLIES.too_many(multi.given, multi.pending) : CONVERSATION_FALLBACKS.not_understood}\n\n${renderQuestionAt(questions, open.currentQuestion)}`,
      'reask',
    )
  } else {
    const read = await readOneAnswer(ctx, current)
    if (!read.answer) return answer('unparsed', resolveReaskText(current, read.offTopic), 'reask')
    given = [read.answer]
  }
  const updated = withMergedAnswers(answers, given)
  const answered = new Set(updated.map((a) => a.question_id))
  const next = convo.find((i) => !answered.has((questions[i] as QuestionT).id))
  if (next !== undefined) {
    return answer('matched', renderQuestionAt(questions, next), 'question', {
      answers: updated,
      currentQuestion: next,
    })
  }
  return answer('summary', renderSummary(questions, updated), 'summary', {
    answers: updated,
    step: 'confirming',
  })
}

export async function handleOpenClarification(
  ctx: InboundContext,
  open: ClarificationRow,
): Promise<InboundResult> {
  const questions: QuestionT[] = Questions.parse(open.questions)
  const answers: OwnerAnswerT[] = Answers.parse(open.answers)
  const convo = conversationalIndexes(questions)

  const answer: AnswerFn = async (resolution, body, kind, set = {}, resume = null) => {
    if (Object.keys(set).length > 0) {
      await ctx.tx.update(clarifications).set(set).where(eq(clarifications.id, open.id))
    }
    await ctx.finish(resolution, open.id, { body, kind })
    return ctx.done({ resolution, resume })
  }

  if (open.step === 'confirmed') return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst')
  if (open.step === 'confirming') return handleConfirmingStep(ctx, open, questions, answers, convo, answer)

  const current = questions[open.currentQuestion]
  if (current && isDocumentRequest(current)) {
    return answer('awaiting_document', documentRequestReplies(current).sendPdf, 'reask')
  }
  if (!current || !isConversational(current)) {
    return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst', { step: 'confirmed' })
  }
  if (open.step === 'revising') {
    return handleRevisingStep(ctx, open, current, questions, answers, convo, answer)
  }
  return handleAskingStep(ctx, open, current, questions, answers, convo, answer)
}
