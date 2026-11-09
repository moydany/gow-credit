import { randomUUID } from 'node:crypto'
import {
  AMOUNT_OFFER,
  describeInvoice,
  INVOICE_REPLIES,
  parseAmount,
  parseLegalName,
  parseMaturity,
} from '@gow/channels'
import { ApplicationRequest, type ApplicationRequest as ApplicationRequestT } from '@gow/contracts'
import { applications, invoiceIntakes } from '@gow/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { InboundContext, InboundResult } from './inbound-context.ts'
import { OFFER_STEP } from './offer.ts'

export type IntakeRow = typeof invoiceIntakes.$inferSelect

const OfferDraft = z.object({ max: z.number().positive() })
const InvoiceDraft = z.object({
  amount: z.number().nullable().optional(),
  buyer: z.string().nullable().optional(),
})

type InvoiceDraftT = z.infer<typeof InvoiceDraft>

export async function handleOfferStep(
  ctx: InboundContext,
  intake: IntakeRow,
): Promise<InboundResult | null> {
  if (intake.step !== OFFER_STEP) return null
  const offer = OfferDraft.safeParse(intake.draft)
  const close = () =>
    ctx.tx
      .update(invoiceIntakes)
      .set({ step: 'done', updatedAt: new Date() })
      .where(eq(invoiceIntakes.applicationId, intake.applicationId))

  if (ctx.msg.attachment !== null || !offer.success) {
    await close()
    return null
  }

  const max = offer.data.max
  const say = (body: string) => ({ body, kind: 'offer' })
  const current = AMOUNT_OFFER.ask(max)
  const read = await ctx.readField('amount', current, parseAmount, { allowSkip: true })

  if ('skip' in read) {
    await close()
    await ctx.finish('offer_skipped', null, say(AMOUNT_OFFER.skipped), {
      application_id: intake.applicationId,
    })
    return ctx.done({ resolution: 'offer_skipped', resume: null })
  }
  if ('invalid' in read) {
    await ctx.finish('offer_invalid', null, say(ctx.reask(read.invalid, current, AMOUNT_OFFER.invalid(max))))
    return ctx.done({ resolution: 'offer_invalid', resume: null })
  }
  if (read.value > max + 0.005) {
    await ctx.finish('offer_invalid', null, say(AMOUNT_OFFER.over(max)))
    return ctx.done({ resolution: 'offer_invalid', resume: null })
  }

  const request = ApplicationRequest.parse({ amount: read.value, maturity: null, buyer: null })
  await ctx.tx
    .update(applications)
    .set({ request, status: 'deciding', updatedAt: new Date() })
    .where(eq(applications.id, intake.applicationId))
  await close()
  await ctx.finish('offer_accepted', null, say(AMOUNT_OFFER.reviewing(read.value)), {
    application_id: intake.applicationId,
  })
  return ctx.done({
    resolution: 'offer_accepted',
    resume: null,
    redecide: {
      tenant_id: ctx.tenantId,
      application_id: intake.applicationId,
      correction_batch: randomUUID(),
    },
  })
}

async function saveIntakeDraft(
  ctx: InboundContext,
  applicationId: string,
  step: string,
  draft: InvoiceDraftT,
): Promise<void> {
  await ctx.tx
    .update(invoiceIntakes)
    .set({ step, draft, updatedAt: new Date() })
    .where(eq(invoiceIntakes.applicationId, applicationId))
}

async function completeIntake(
  ctx: InboundContext,
  intake: IntakeRow,
  draft: InvoiceDraftT,
  request: ApplicationRequestT | null,
): Promise<InboundResult> {
  await ctx.tx
    .update(applications)
    .set({ request, updatedAt: new Date() })
    .where(eq(applications.id, intake.applicationId))
  await saveIntakeDraft(ctx, intake.applicationId, 'done', draft)
  await ctx.finish(
    'intake_completed',
    null,
    { body: INVOICE_REPLIES.analyzing(describeInvoice(request)), kind: 'invoice' },
    { application_id: intake.applicationId },
  )
  return {
    resolution: 'intake_completed',
    resume: null,
    process: {
      job: { tenant_id: ctx.tenantId, application_id: intake.applicationId },
      sha256: intake.documentSha256,
    },
  }
}

async function handleIntakeAmount(
  ctx: InboundContext,
  intake: IntakeRow,
  draft: InvoiceDraftT,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('amount', current, parseAmount, { allowSkip: true })
  if ('skip' in read) return ctx.done(await completeIntake(ctx, intake, draft, null))
  if ('invalid' in read) {
    await ctx.finish(
      'intake_invalid',
      null,
      { body: ctx.reask(read.invalid, current, INVOICE_REPLIES.invalid_amount), kind: 'invoice' },
    )
    return ctx.done({ resolution: 'intake_invalid', resume: null })
  }
  await saveIntakeDraft(ctx, intake.applicationId, 'buyer', { ...draft, amount: read.value })
  await ctx.finish('intake_step', null, { body: INVOICE_REPLIES.ask_buyer, kind: 'invoice' })
  return ctx.done({ resolution: 'intake_step', resume: null })
}

async function handleIntakeBuyer(
  ctx: InboundContext,
  intake: IntakeRow,
  draft: InvoiceDraftT,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('buyer', current, parseLegalName, { free: true, allowSkip: true })
  if ('invalid' in read) {
    await ctx.finish(
      'intake_invalid',
      null,
      { body: ctx.reask(read.invalid, current, INVOICE_REPLIES.invalid_buyer), kind: 'invoice' },
    )
    return ctx.done({ resolution: 'intake_invalid', resume: null })
  }
  await saveIntakeDraft(ctx, intake.applicationId, 'maturity', {
    ...draft,
    buyer: 'value' in read ? read.value : null,
  })
  await ctx.finish('intake_step', null, { body: INVOICE_REPLIES.ask_maturity, kind: 'invoice' })
  return ctx.done({ resolution: 'intake_step', resume: null })
}

async function handleIntakeMaturity(
  ctx: InboundContext,
  intake: IntakeRow,
  draft: InvoiceDraftT,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('maturity', current, (t) => parseMaturity(t, ctx.today()), {
    allowSkip: true,
  })
  if ('invalid' in read) {
    await ctx.finish(
      'intake_invalid',
      null,
      { body: ctx.reask(read.invalid, current, INVOICE_REPLIES.invalid_maturity), kind: 'invoice' },
    )
    return ctx.done({ resolution: 'intake_invalid', resume: null })
  }
  if ('value' in read && 'past' in read.value) {
    await ctx.finish('intake_invalid', null, { body: INVOICE_REPLIES.past_maturity, kind: 'invoice' })
    return ctx.done({ resolution: 'intake_invalid', resume: null })
  }
  const maturity = 'value' in read && 'date' in read.value ? read.value.date : null
  const request = ApplicationRequest.parse({
    amount: draft.amount ?? null,
    maturity,
    buyer: draft.buyer ? { name: draft.buyer, rfc: null, aliases: [] } : null,
  })
  return ctx.done(await completeIntake(ctx, intake, draft, request))
}

export async function handleInvoiceIntakeStep(
  ctx: InboundContext,
  intake: IntakeRow,
): Promise<InboundResult> {
  const draft = InvoiceDraft.parse(intake.draft)
  const current =
    intake.step === 'buyer'
      ? INVOICE_REPLIES.ask_buyer
      : intake.step === 'maturity'
        ? INVOICE_REPLIES.ask_maturity
        : INVOICE_REPLIES.ask_amount

  if (ctx.msg.attachment !== null) {
    await ctx.finish('intake_invalid', null, {
      body: `${INVOICE_REPLIES.pending_first}\n\n${current}`,
      kind: 'invoice',
    })
    return { resolution: 'intake_invalid', resume: null }
  }

  if (intake.step === 'amount') return handleIntakeAmount(ctx, intake, draft, current)
  if (intake.step === 'buyer') return handleIntakeBuyer(ctx, intake, draft, current)
  return handleIntakeMaturity(ctx, intake, draft, current)
}
