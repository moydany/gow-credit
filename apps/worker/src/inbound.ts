/**
 * Resolution of each inbound message:
 *
 * 1. A message arrives from N on tenant T's channel (the WhatsApp process or the email webhook
 *    already fixed T).
 * 2. Verified links (T, channel, N). No link: fixed reply and a log entry; nothing is enqueued.
 * 3. With a link: only the open clarifications of those suppliers with that destination. The
 *    message text never authorizes anything: quoting someone else's folio does not open that request.
 * 4. The reply is read against the expected question; ambiguous -> re-ask with numbers. One
 *    message may carry several answers ("1, 3, 1"): they go to the current question and the next ones.
 * 5. Once the chat questions are answered, a summary is sent; on "yes", the clarification becomes
 *    `answered` and the resume is enqueued; with a number or a correction, that answer is changed
 *    and it returns to the summary. If analyst questions remain, the analyst is notified.
 *
 * A photo, voice note, video or sticker is not read: the reply says the PDF is needed and repeats
 * what is pending.
 *
 * A message with a document does not answer clarifications, with one exception: if the full PDF
 * was requested because of missing pages (`isDocumentRequest`), the new PDF answers that question,
 * is added to the same request and its resume is enqueued. Otherwise, with a single supplier on
 * the verified link and a valid PDF, it opens a request, like the API with an ingest key, and
 * its processing is enqueued. The bytes move from the inbound row to the tenant's storage and the
 * column is emptied. The sender only gets a fixed text reply.
 *
 * With a policy that evaluates three months (ADR 0072), the PDFs picked together arrive one by one:
 * the first one's analysis (or resume, when it answers the missing months) waits a short window and
 * the others from the same supplier join it (send-batch.ts).
 *
 * With `selfRegistration` (demo only), an unlinked WhatsApp number does not get the fixed reply:
 * it is asked its name and the amount it wants, then its bank statement, which is analyzed
 * immediately with that amount; once read, it confirms or
 * corrects the holder and RFC, fills in what is missing and, for a persona moral, gives its legal
 * representative. Then it becomes a supplier with its identity and the result goes out
 * (registration.ts).
 */
import { GENERIC_NO_PENDING, MEDIA_UNSUPPORTED, REGISTRATION_REPLIES } from '@gow/channels'
import { inboundMessages, invoiceIntakes, suppliers, withTenant, type Db } from '@gow/db'
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { activeLineOf, lineSummaryFor } from './active-line.ts'
import { handleOpenClarification } from './inbound-clarification.ts'
import { createInboundContext, type InboundContext } from './inbound-context.ts'
import { handleBatchJoinIfApplicable, handleInboundAttachment } from './inbound-document.ts'
import { handleInvoiceIntakeStep, handleOfferStep } from './inbound-intake.ts'
import { handleRegistrationFlow } from './inbound-registration.ts'
import { pendingChatPrompt } from './inbound-replies.ts'
import type { InboundOptions, InboundResult, Resolution } from './inbound-types.ts'
import { OFFER_STEP } from './offer.ts'
import { registrationPrompt } from './registration.ts'
import { historyMonthsOf, SEND_WINDOW_SECONDS } from './send-batch.ts'

export type { InboundOptions, InboundResult, Resolution }

async function handleUnsupportedMedia(ctx: InboundContext): Promise<InboundResult | null> {
  if (ctx.msg.mediaKind === null) return null
  let pendingText: string | null = null
  let clarificationId: string | null = null
  const isRegPending =
    ctx.opts.selfRegistration &&
    ctx.msg.channel === 'whatsapp' &&
    (ctx.links.length === 0 || (ctx.reg && ctx.reg.step !== 'done'))
  if (isRegPending) {
    pendingText = registrationPrompt(ctx.reg)
  } else if (ctx.links.length > 0) {
    const res = await pendingChatPrompt(ctx.tx, ctx.msg, () => ctx.openClarification())
    pendingText = res.text
    clarificationId = res.clarificationId
  }
  await ctx.finish(
    'media_unsupported',
    clarificationId,
    {
      body: pendingText ? `${MEDIA_UNSUPPORTED}\n\n${pendingText}` : MEDIA_UNSUPPORTED,
      kind: 'media',
    },
    { media_kind: ctx.msg.mediaKind },
  )
  return { resolution: 'media_unsupported', resume: null }
}

async function handlePendingIntake(ctx: InboundContext): Promise<InboundResult | null> {
  if (ctx.links.length === 0) return null
  const [intake] = await ctx.tx
    .select()
    .from(invoiceIntakes)
    .where(
      and(
        eq(invoiceIntakes.channel, ctx.msg.channel),
        eq(invoiceIntakes.address, ctx.msg.fromAddress),
        ne(invoiceIntakes.step, 'done'),
      ),
    )
    .orderBy(desc(invoiceIntakes.createdAt))
    .limit(1)
  if (!intake) return null
  if (intake.step === OFFER_STEP) {
    const res = await handleOfferStep(ctx, intake)
    if (res !== null) return res
  }
  if (intake.step !== OFFER_STEP) {
    return handleInvoiceIntakeStep(ctx, intake)
  }
  return null
}

async function handleNoClarificationFound(ctx: InboundContext): Promise<InboundResult> {
  const owners = [...new Set(ctx.links.map((l) => l.supplierId))]
  const [owner] = owners
  const line = owners.length === 1 && owner ? await activeLineOf(ctx.tx, owners) : null
  if (line && owner) {
    await ctx.finish('line_active', null, {
      body: await lineSummaryFor(ctx.tx, owner, line, {
        contactName: ctx.reg?.contactName ?? null,
        sentDocument: false,
      }),
      kind: 'line_summary',
    })
    return ctx.done({ resolution: 'line_active', resume: null })
  }
  if (ctx.opts.selfRegistration && ctx.msg.channel === 'whatsapp') {
    const [s] = await ctx.tx
      .select({ legalName: suppliers.legalName })
      .from(suppliers)
      .where(inArray(suppliers.id, ctx.links.map((l) => l.supplierId)))
      .limit(1)
    await ctx.finish('registered_idle', null, {
      body: REGISTRATION_REPLIES.idle(s?.legalName ?? 'tu empresa', ctx.reg?.contactName ?? null),
      kind: 'registration',
    })
    return { resolution: 'registered_idle', resume: null }
  }
  await ctx.finish('no_open_clarification', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
  return { resolution: 'no_open_clarification', resume: null }
}

export async function resolveInbound(
  db: Db,
  tenantId: string,
  messageId: string,
  opts: InboundOptions = {},
): Promise<InboundResult> {
  return withTenant(db, tenantId, async (tx) => {
    const [msg] = await tx
      .select()
      .from(inboundMessages)
      .where(and(eq(inboundMessages.id, messageId), isNull(inboundMessages.processedAt)))
    if (!msg) return { resolution: 'already_processed', resume: null }

    const ctx = await createInboundContext(tx, tenantId, msg, opts)
    const mediaRes = await handleUnsupportedMedia(ctx)
    if (mediaRes) return mediaRes

    const months = msg.attachment !== null ? await historyMonthsOf(tx) : 1
    const sendDelay = months > 1 ? { delaySeconds: SEND_WINDOW_SECONDS } : {}
    const batched = await handleBatchJoinIfApplicable(ctx, months)
    if (batched) return batched

    const isRegPending =
      opts.selfRegistration &&
      msg.channel === 'whatsapp' &&
      (ctx.links.length === 0 || (ctx.reg && ctx.reg.step !== 'done'))
    if (isRegPending) return handleRegistrationFlow(ctx, sendDelay)

    const intakeRes = await handlePendingIntake(ctx)
    if (intakeRes) return intakeRes

    if (msg.attachment !== null) return handleInboundAttachment(ctx, msg.attachment, sendDelay)

    if (ctx.links.length === 0) {
      await ctx.finish('no_link', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_link', resume: null }
    }

    const open = await ctx.openClarification()
    if (!open) return handleNoClarificationFound(ctx)

    return handleOpenClarification(ctx, open)
  })
}

/** Unprocessed inbound messages from all tenants (reviewed function, ids only). */
export async function pendingInbound(db: Db, limit = 50): Promise<{ id: string; tenant_id: string }[]> {
  const res = await db.execute<{ id: string; tenant_id: string }>(
    sql`select id, tenant_id from app.pending_inbound(${limit})`,
  )
  return res.rows
}
