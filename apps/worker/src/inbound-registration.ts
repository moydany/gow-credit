import {
  DOCUMENT_REPLIES,
  parseAmount,
  parseContactName,
  parseLegalName,
  parseRfc,
  parseYesNo,
  personTypeOf,
  REGISTRATION_REPLIES,
} from '@gow/channels'
import { ApplicationRequest } from '@gow/contracts'
import { supplierRegistrations, tenants } from '@gow/db'
import { eq } from 'drizzle-orm'
import type { InboundContext, InboundResult, RejectedDoc } from './inbound-context.ts'
import type { Resolution } from './inbound-types.ts'
import {
  completeRegistration,
  completeRfc,
  pendingStatement,
  registrationSupplier,
  rfcAskReason,
} from './registration.ts'
import { historyMonthsOf } from './send-batch.ts'

type Registration = typeof supplierRegistrations.$inferSelect

function say(body: string): { body: string; kind: string } {
  return { body, kind: 'registration' }
}

function rejectedText(why: 'password' | 'invalid'): string {
  return why === 'password' ? DOCUMENT_REPLIES.password_protected : DOCUMENT_REPLIES.rejected
}

async function askStatement(ctx: InboundContext, text: string): Promise<string> {
  const months = await historyMonthsOf(ctx.tx)
  return months > 1 ? `${text}\n\n${DOCUMENT_REPLIES.three_months}` : text
}

async function keepStatement(
  ctx: InboundContext,
  row: Registration,
  bytes: Buffer,
): Promise<RejectedDoc | { documentId: string }> {
  const supplierFor = () => registrationSupplier(ctx.tx, row, ctx.msg)
  const stored = await ctx.storeDocument(supplierFor, bytes)
  if ('rejected' in stored) return stored
  await ctx.tx
    .update(supplierRegistrations)
    .set({ pendingDocumentId: stored.documentId, updatedAt: new Date() })
    .where(eq(supplierRegistrations.id, row.id))
  return { documentId: stored.documentId }
}

async function saveRegistration(
  ctx: InboundContext,
  id: string,
  set: Partial<typeof supplierRegistrations.$inferInsert>,
): Promise<void> {
  await ctx.tx
    .update(supplierRegistrations)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(supplierRegistrations.id, id))
}

async function replyReg(
  ctx: InboundContext,
  resolution: Resolution,
  body: string,
): Promise<InboundResult> {
  await ctx.finish(resolution, null, say(body))
  return ctx.done({ resolution, resume: null })
}

async function startReading(
  ctx: InboundContext,
  supplierId: string,
  doc: { documentId: string; sha256: string },
  amount: number | null,
  inboundId: string | undefined,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const request = amount === null ? null : ApplicationRequest.parse({ amount, maturity: null, buyer: null })
  const opened = await ctx.openWithDocument(supplierId, doc, request, inboundId)
  if (ctx.reg) {
    await saveRegistration(ctx, ctx.reg.id, {
      step: 'reading',
      supplierId,
      applicationId: opened.applicationId,
      pendingDocumentId: null,
    })
  }
  await ctx.finish('document_received', null, say(REGISTRATION_REPLIES.reading), {
    application_id: opened.applicationId,
  })
  return ctx.done({
    resolution: 'document_received',
    resume: null,
    process: {
      job: { tenant_id: ctx.tenantId, application_id: opened.applicationId },
      sha256: opened.sha256,
      ...sendDelay,
    },
  })
}

async function advanceRegistration(
  ctx: InboundContext,
  reg: Registration,
  data: { legalName: string | null; rfc: string | null; representative?: string },
): Promise<InboundResult> {
  if (!data.legalName) {
    await saveRegistration(ctx, reg.id, { step: 'name', legalName: null, rfc: data.rfc })
    return replyReg(ctx, 'registration_step', REGISTRATION_REPLIES.ask_name)
  }
  if (!data.rfc) {
    await saveRegistration(ctx, reg.id, { step: 'rfc', legalName: data.legalName, rfc: null })
    return replyReg(ctx, 'registration_step', REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg)))
  }
  if (personTypeOf(data.rfc) === 'moral' && !data.representative) {
    await saveRegistration(ctx, reg.id, { step: 'representative', legalName: data.legalName, rfc: data.rfc })
    return replyReg(ctx, 'registration_step', REGISTRATION_REPLIES.ask_representative)
  }
  const c = await completeRegistration(ctx.tx, ctx.tenantId, reg, {
    legalName: data.legalName,
    rfc: data.rfc,
    representative: data.representative ?? null,
  })
  await ctx.finish('registration_completed', c.clarificationId, c.reply, {
    supplier_id: reg.supplierId ?? '',
  })
  return ctx.done({ resolution: 'registration_completed', resume: c.resume })
}

async function handleRegistrationStart(ctx: InboundContext): Promise<InboundResult> {
  const [tenant] = await ctx.tx.select({ name: tenants.name }).from(tenants)
  const fresh = {
    step: 'contact_name',
    contactName: null,
    requestedAmount: null,
    pendingDocumentId: null,
    legalName: null,
    rfc: null,
    holderName: null,
    holderRfc: null,
    corrected: false,
    supplierId: null,
    applicationId: null,
    updatedAt: new Date(),
  }
  const [row] = ctx.reg
    ? await ctx.tx.update(supplierRegistrations).set(fresh).where(eq(supplierRegistrations.id, ctx.reg.id)).returning()
    : await ctx.tx.insert(supplierRegistrations).values({
        tenantId: ctx.tenantId,
        channel: ctx.msg.channel,
        address: ctx.msg.fromAddress,
        ...fresh,
      }).returning()
  if (!row) throw new Error('no se guardó el registro')
  const tenantName = tenant?.name ?? 'GOW Credit'
  if (ctx.msg.attachment === null) {
    return replyReg(ctx, 'registration_started', REGISTRATION_REPLIES.welcome(tenantName))
  }
  const kept = await keepStatement(ctx, row, ctx.msg.attachment)
  if ('rejected' in kept) {
    await ctx.finish(
      'registration_started',
      null,
      say(REGISTRATION_REPLIES.welcome(tenantName, false, rejectedText(kept.rejected))),
      { reason: kept.rejected },
    )
    return ctx.done({ resolution: 'registration_started', resume: null })
  }
  await ctx.finish('registration_started', null, say(REGISTRATION_REPLIES.welcome(tenantName, true)), {
    document_id: kept.documentId,
  })
  return ctx.done({ resolution: 'registration_started', resume: null })
}

async function handleContactNameStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('legal_name', current, parseContactName, { free: true })
  if (!('value' in read)) {
    return replyReg(
      ctx,
      'registration_invalid',
      ctx.reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_contact_name),
    )
  }
  await saveRegistration(ctx, reg.id, { step: 'amount', contactName: read.value })
  return replyReg(ctx, 'registration_step', REGISTRATION_REPLIES.ask_amount(read.value))
}

async function handleAmountStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const read = await ctx.readField('amount', current, parseAmount, { allowSkip: true })
  if ('invalid' in read) {
    return replyReg(ctx, 'registration_invalid', ctx.reask(read.invalid, current, REGISTRATION_REPLIES.invalid_amount))
  }
  const amount = 'value' in read ? read.value : null
  const kept = reg.supplierId ? await pendingStatement(ctx.tx, reg) : undefined
  if (kept && reg.supplierId) {
    await saveRegistration(ctx, reg.id, { requestedAmount: amount })
    return startReading(ctx, reg.supplierId, kept, amount, kept.inboundId, sendDelay)
  }
  await saveRegistration(ctx, reg.id, { step: 'statement', requestedAmount: amount, pendingDocumentId: null })
  return replyReg(ctx, 'registration_step', await askStatement(ctx, REGISTRATION_REPLIES.ask_statement_for(amount)))
}

async function handlePreStatementStep(
  ctx: InboundContext,
  reg: Registration,
  step: 'contact_name' | 'amount',
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const current = step === 'contact_name' ? REGISTRATION_REPLIES.ask_contact_name : REGISTRATION_REPLIES.ask_amount(null)
  if (ctx.msg.attachment !== null) {
    const kept = await keepStatement(ctx, reg, ctx.msg.attachment)
    if ('rejected' in kept) {
      await ctx.finish(
        'document_rejected',
        null,
        { body: `${rejectedText(kept.rejected)}\n\n${current}`, kind: 'document' },
        { reason: kept.rejected },
      )
      return ctx.done({ resolution: 'document_rejected', resume: null })
    }
    await ctx.finish(
      'registration_document_kept',
      null,
      say(`${REGISTRATION_REPLIES.statement_kept}\n\n${current}`),
      { document_id: kept.documentId },
    )
    return ctx.done({ resolution: 'registration_document_kept', resume: null })
  }
  if (step === 'contact_name') return handleContactNameStep(ctx, reg, current)
  return handleAmountStep(ctx, reg, current, sendDelay)
}

async function handleStatementStep(
  ctx: InboundContext,
  reg: Registration,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  if (ctx.msg.attachment === null) {
    return replyReg(ctx, 'registration_waiting', await askStatement(ctx, REGISTRATION_REPLIES.ask_statement))
  }
  const supplierFor = () => registrationSupplier(ctx.tx, reg, ctx.msg)
  const stored = await ctx.storeDocument(supplierFor, ctx.msg.attachment)
  if ('rejected' in stored) {
    await ctx.finish(
      'document_rejected',
      null,
      { body: rejectedText(stored.rejected), kind: 'document' },
      { reason: stored.rejected },
    )
    return { resolution: 'document_rejected', resume: null }
  }
  const supplierId = await supplierFor()
  return startReading(ctx, supplierId, stored, reg.requestedAmount, undefined, sendDelay)
}

function resolvePostReadingCurrentPrompt(step: string, reg: Registration): string {
  if (step === 'confirm') return REGISTRATION_REPLIES.confirm(reg.holderName ?? '', completeRfc(reg.holderRfc))
  if (step === 'rfc') return REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg))
  if (step === 'representative') return REGISTRATION_REPLIES.ask_representative
  return reg.corrected ? REGISTRATION_REPLIES.ask_name_corrected : REGISTRATION_REPLIES.ask_name
}

async function handleConfirmStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('option', current, parseYesNo, {
    options: ['Sí, son correctos', 'No, no son correctos'],
  })
  if (!('value' in read)) {
    return replyReg(
      ctx,
      'registration_invalid',
      ctx.reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_yes_no),
    )
  }
  if (read.value) {
    return advanceRegistration(ctx, reg, { legalName: reg.holderName ?? '', rfc: completeRfc(reg.holderRfc) })
  }
  await saveRegistration(ctx, reg.id, { step: 'name', corrected: true, legalName: null, rfc: null })
  return replyReg(ctx, 'registration_step', REGISTRATION_REPLIES.ask_name_corrected)
}

async function readLegalNameValue(
  ctx: InboundContext,
  current: string,
  invalidMsg: string,
): Promise<{ value: string } | { error: InboundResult }> {
  const read = await ctx.readField('legal_name', current, parseLegalName, { free: true })
  if (!('value' in read)) {
    const error = await replyReg(
      ctx,
      'registration_invalid',
      ctx.reask('invalid' in read ? read.invalid : null, current, invalidMsg),
    )
    return { error }
  }
  return { value: read.value }
}

async function handleNameStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
): Promise<InboundResult> {
  const res = await readLegalNameValue(ctx, current, REGISTRATION_REPLIES.invalid_name)
  if ('error' in res) return res.error
  return advanceRegistration(ctx, reg, {
    legalName: res.value,
    rfc: reg.corrected ? null : completeRfc(reg.holderRfc),
  })
}

async function handleRfcStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
): Promise<InboundResult> {
  const read = await ctx.readField('rfc', current, parseRfc)
  if (!('value' in read)) {
    return replyReg(
      ctx,
      'registration_invalid',
      ctx.reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_rfc),
    )
  }
  const why = rfcAskReason(reg)
  if (why.kind === 'root' && !read.value.startsWith(why.root)) {
    return replyReg(ctx, 'registration_invalid', REGISTRATION_REPLIES.rfc_root_mismatch(why.root))
  }
  return advanceRegistration(ctx, reg, { legalName: reg.legalName, rfc: read.value })
}

async function handleRepresentativeStep(
  ctx: InboundContext,
  reg: Registration,
  current: string,
): Promise<InboundResult> {
  const res = await readLegalNameValue(ctx, current, REGISTRATION_REPLIES.invalid_representative)
  if ('error' in res) return res.error
  return advanceRegistration(ctx, reg, {
    legalName: reg.legalName,
    rfc: reg.rfc,
    representative: res.value,
  })
}

async function handlePostReadingStep(
  ctx: InboundContext,
  reg: Registration,
  step: string,
): Promise<InboundResult> {
  const current = resolvePostReadingCurrentPrompt(step, reg)
  if (ctx.msg.attachment !== null) {
    return replyReg(ctx, 'registration_invalid', `${REGISTRATION_REPLIES.pending_first}\n\n${current}`)
  }
  if (step === 'confirm') return handleConfirmStep(ctx, reg, current)
  if (step === 'name') return handleNameStep(ctx, reg, current)
  if (step === 'rfc') return handleRfcStep(ctx, reg, current)
  return handleRepresentativeStep(ctx, reg, current)
}

export async function handleRegistrationFlow(
  ctx: InboundContext,
  sendDelay: { delaySeconds?: number },
): Promise<InboundResult> {
  const reg = ctx.reg
  if (!reg || reg.step === 'done') return handleRegistrationStart(ctx)
  const step = reg.step === 'legal_name' || (reg.step === 'rfc' && !reg.applicationId) ? 'statement' : reg.step
  if (step === 'contact_name' || step === 'amount') return handlePreStatementStep(ctx, reg, step, sendDelay)
  if (step === 'statement') return handleStatementStep(ctx, reg, sendDelay)
  if (step === 'reading') return replyReg(ctx, 'registration_waiting', REGISTRATION_REPLIES.still_reading)
  return handlePostReadingStep(ctx, reg, step)
}
