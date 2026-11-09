import { createHash } from 'node:crypto'
import {
  DOCUMENT_REPLIES,
  documentRequestReplies,
  INVOICE_REPLIES,
  isComplete,
} from '@gow/channels'
import { describeFailure, OwnerAnswer, Question } from '@gow/contracts'
import {
  applicationDocuments,
  applications,
  clarifications,
  documents,
  invoiceIntakes,
} from '@gow/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { activeLineOf, lineSummaryFor } from './active-line.ts'
import type { InboundContext, InboundResult } from './inbound-context.ts'
import { documentRequestOf, duplicateReply } from './inbound-replies.ts'
import { joinSend, openSendOf, SEND_WINDOW_SECONDS } from './send-batch.ts'

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)

function docReply(key: keyof typeof DOCUMENT_REPLIES): { body: string; kind: string } {
  return { body: DOCUMENT_REPLIES[key], kind: 'document' }
}

export async function handleBatchJoinIfApplicable(
  ctx: InboundContext,
  months: number,
): Promise<InboundResult | null> {
  if (ctx.msg.attachment === null || months <= 1) return null
  const owners = [
    ...new Set([
      ...ctx.links.map((l) => l.supplierId),
      ...(ctx.reg?.supplierId ? [ctx.reg.supplierId] : []),
    ]),
  ]
  const [owner] = owners
  const target =
    owners.length === 1 && owner
      ? await openSendOf(ctx.tx, owner, { channel: ctx.msg.channel, address: ctx.msg.fromAddress })
      : null
  if (!target || !owner) return null

  const stored = await ctx.storeDocument(owner, ctx.msg.attachment)
  if ('rejected' in stored) {
    await ctx.finish(
      'document_rejected',
      null,
      {
        body: stored.rejected === 'password' ? DOCUMENT_REPLIES.password_protected : DOCUMENT_REPLIES.rejected,
        kind: 'document',
      },
      { reason: stored.rejected },
    )
    return ctx.done({ resolution: 'document_rejected', resume: null })
  }

  const joined = await joinSend(ctx.tx, ctx.tenantId, target, stored)
  const resolution = joined === 'joined' ? 'document_batched' : 'document_duplicate'
  await ctx.finish(
    resolution,
    target.kind === 'answer' ? target.clarificationId : null,
    {
      body: joined === 'joined' ? DOCUMENT_REPLIES.batch_joined : DOCUMENT_REPLIES.duplicate,
      kind: 'document',
    },
    { application_id: target.applicationId },
  )
  return ctx.done({ resolution, resume: null })
}

async function handleClarificationDocumentAnswer(
  ctx: InboundContext,
  supplierId: string,
  bytes: Buffer,
  requesting: typeof clarifications.$inferSelect,
  request: NonNullable<ReturnType<typeof documentRequestOf>>,
): Promise<InboundResult> {
  const stored = await ctx.storeDocument(supplierId, bytes)
  if ('rejected' in stored) {
    await ctx.finish(
      'document_rejected',
      requesting.id,
      docReply(stored.rejected === 'password' ? 'password_protected' : 'rejected'),
      { reason: stored.rejected },
    )
    return { resolution: 'document_rejected', resume: null }
  }

  const [linked] = await ctx.tx
    .select({ documentId: applicationDocuments.documentId })
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.applicationId, requesting.applicationId),
        eq(applicationDocuments.documentId, stored.documentId),
      ),
    )
  if (linked) {
    await ctx.finish(
      'document_duplicate',
      requesting.id,
      { body: documentRequestReplies(request).sameFile, kind: 'document' },
      { application_id: requesting.applicationId },
    )
    return { resolution: 'document_duplicate', resume: null }
  }

  await ctx.tx.insert(applicationDocuments).values({
    tenantId: ctx.tenantId,
    applicationId: requesting.applicationId,
    documentId: stored.documentId,
    origin: 'owner_answer',
  })

  const answers = [
    ...Answers.parse(requesting.answers),
    { question_id: request.id, kind: 'documents' as const, paths: [stored.storagePath] },
  ]
  const complete = isComplete(Questions.parse(requesting.questions), answers)
  await ctx.tx
    .update(clarifications)
    .set(
      complete
        ? { answers, step: 'confirmed', status: 'answered', answeredAt: sql`now()` }
        : { answers, step: 'confirmed' },
    )
    .where(eq(clarifications.id, requesting.id))

  const texts = documentRequestReplies(request)
  await ctx.finish(
    'document_answer',
    requesting.id,
    { body: complete ? texts.received : texts.forReview, kind: 'document' },
    { application_id: requesting.applicationId },
  )

  const wait = complete && request.topic === 'additional_months' ? { resumeDelaySeconds: SEND_WINDOW_SECONDS } : {}
  return {
    resolution: 'document_answer',
    resume: complete
      ? {
          tenant_id: ctx.tenantId,
          application_id: requesting.applicationId,
          clarification_id: requesting.id,
        }
      : null,
    ...wait,
  }
}

async function handleExistingDocumentCheck(
  ctx: InboundContext,
  sha256: string,
): Promise<InboundResult | null> {
  const [existing] = await ctx.tx.select({ id: documents.id }).from(documents).where(eq(documents.sha256, sha256))
  if (!existing) return null

  const [prev] = await ctx.tx
    .select({
      id: applications.id,
      status: applications.status,
      failureReason: applications.failureReason,
      request: applications.request,
    })
    .from(applicationDocuments)
    .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
    .where(eq(applicationDocuments.documentId, existing.id))
    .orderBy(desc(applications.createdAt))
    .limit(1)

  const failure = prev?.status === 'failed' ? describeFailure(prev.failureReason) : null
  if (prev && failure?.kind !== 'internal') {
    const body = await duplicateReply(
      ctx.tx,
      prev,
      failure,
      ctx.msg.channel === 'whatsapp' ? { tenantId: ctx.tenantId, address: ctx.msg.fromAddress } : null,
    )
    await ctx.finish(
      'document_duplicate',
      null,
      { body, kind: 'document' },
      { application_id: prev.id, previous_status: prev.status },
    )
    return { resolution: 'document_duplicate', resume: null }
  }
  return null
}

async function handleNewDocumentApplication(
  ctx: InboundContext,
  supplierId: string,
  bytes: Buffer,
  sha256: string,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const stored = await ctx.storeDocument(supplierId, bytes)
  if ('rejected' in stored) {
    await ctx.finish(
      'document_rejected',
      null,
      docReply(stored.rejected === 'password' ? 'password_protected' : 'rejected'),
      { reason: stored.rejected },
    )
    return { resolution: 'document_rejected', resume: null }
  }

  const opened = await ctx.openWithDocument(supplierId, stored)
  const created = { id: opened.applicationId }

  if (ctx.opts.askInvoice) {
    await ctx.tx.insert(invoiceIntakes).values({
      applicationId: created.id,
      tenantId: ctx.tenantId,
      channel: ctx.msg.channel,
      address: ctx.msg.fromAddress,
      step: 'amount',
      documentSha256: sha256,
    })
    await ctx.finish(
      'document_received',
      null,
      { body: INVOICE_REPLIES.ask_amount, kind: 'invoice' },
      { application_id: created.id },
    )
    return { resolution: 'document_received', resume: null }
  }

  await ctx.finish('document_received', null, docReply('received'), { application_id: created.id })
  return {
    resolution: 'document_received',
    resume: null,
    process: {
      job: { tenant_id: ctx.tenantId, application_id: created.id },
      sha256,
      ...sendDelay,
    },
  }
}

export async function handleInboundAttachment(
  ctx: InboundContext,
  bytes: Buffer,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const suppliers = [...new Set(ctx.links.map((l) => l.supplierId))]
  if (suppliers.length === 0) {
    await ctx.finish('no_link', null, docReply('no_link'))
    return { resolution: 'no_link', resume: null }
  }
  const [supplierId] = suppliers
  if (suppliers.length > 1 || !supplierId) {
    await ctx.finish('document_ambiguous', null, docReply('ambiguous'))
    return { resolution: 'document_ambiguous', resume: null }
  }

  const requesting = await ctx.openClarification()
  const request = requesting ? documentRequestOf(requesting) : undefined
  if (requesting && request) {
    return handleClarificationDocumentAnswer(ctx, supplierId, bytes, requesting, request)
  }

  const line = await activeLineOf(ctx.tx, [supplierId])
  if (line) {
    await ctx.finish('line_active', null, {
      body: await lineSummaryFor(ctx.tx, supplierId, line, {
        contactName: ctx.reg?.contactName ?? null,
        sentDocument: true,
      }),
      kind: 'line_summary',
    })
    return { resolution: 'line_active', resume: null }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const existingResult = await handleExistingDocumentCheck(ctx, sha256)
  if (existingResult) return existingResult

  return handleNewDocumentApplication(ctx, supplierId, bytes, sha256, sendDelay)
}
