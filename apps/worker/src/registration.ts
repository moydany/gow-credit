/**
 * Registration with the bank statement first (demo only, with `WHATSAPP_SELF_REGISTRATION`).
 *
 * 1. An unlinked number greets: it is asked how they are called (`contact_name`) and how much they
 *    want to advance (`amount`, may be skipped), then for the bank statement. A PDF sent before
 *    that is kept (`pending_document_id`) and read once both are given.
 * 2. The PDF arrives: a supplier with no identity (`legal_name` null) is created with the contact
 *    verified by possession of the number, and the request is opened with the amount (no buyer or
 *    due date) and analyzed immediately. Without an amount it decides with the maximum line.
 * 3. Analysis ends: the result is not sent. The same number is shown the holder and RFC read so it
 *    can confirm or correct them (`startConfirmation`), and asked for what is missing: the full
 *    RFC if it came without homoclave, the legal representative for a persona moral.
 * 4. With that data, the supplier gets its identity and the result goes out
 *    (`completeRegistration`): the verdict that already existed or, if the engine was waiting for
 *    the identity, the clarification is answered with what was confirmed and the resume decides.
 */
import { failureNotice, isComplete, isDocumentRequest, nextConversational, notQualifiedReasons, parseLegalName, parseRfc, REGISTRATION_REPLIES, renderDocumentRequest, renderQuestionAt, renderVerdict } from '@gow/channels'
import { ApplicationRequest, Decision, describeFailure, OwnerAnswer, Question, rfcRoot } from '@gow/contracts'
import { applications, auditLog, clarifications, decisions, documents, type inboundMessages, outboundMessages, supplierContacts, supplierRegistrations, suppliers, tenants, type Tx } from '@gow/db'
import type { AppState } from '@gow/mastra'
import type { ResumeJob } from '@gow/platform'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { offerAmount } from './offer.ts'
import type { AppContext } from './store.ts'

export const FINAL_VERDICTS = ['qualified', 'qualified_with_limit', 'not_qualified', 'human_review'] as const

type Registration = typeof supplierRegistrations.$inferSelect

/** The RFC as compared: no spaces or hyphens, uppercase. */
function cleanRfc(raw: string | null): string | null {
  const s = raw?.replace(/[\s-]/g, '').toUpperCase() ?? ''
  return s.length ? s : null
}

/** The holder's RFC, if it came complete. */
export function completeRfc(holderRfc: string | null): string | null {
  return holderRfc ? parseRfc(holderRfc) : null
}

/** Why the RFC is asked of the supplier. */
export function rfcAskReason(reg: Pick<Registration, 'corrected' | 'holderRfc'>) {
  if (reg.corrected) return { kind: 'corrected' as const }
  const root = rfcRoot(reg.holderRfc)
  return root ? { kind: 'root' as const, root } : { kind: 'missing' as const }
}

/**
 * Finishes the first read of a registering supplier. If it failed (not a bank statement,
 * unreadable), the notice goes out as usual and registration goes back to waiting for a PDF.
 * Otherwise the result is held and the supplier is asked whether the holder and RFC read are theirs.
 */
export async function startConfirmation(tx: Tx, ctx: AppContext, state: AppState | null, status: string): Promise<void> {
  const [reg] = await tx
    .select()
    .from(supplierRegistrations)
    .where(and(eq(supplierRegistrations.applicationId, ctx.application.id), eq(supplierRegistrations.step, 'reading')))
  if (!reg) return
  if (status === 'failed') {
    await tx.update(supplierRegistrations).set({ step: 'statement', applicationId: null, updatedAt: new Date() }).where(eq(supplierRegistrations.id, reg.id))
    return
  }
  const holder = state?.statements[0]?.holder ?? null
  const holderName = holder?.name.value ? parseLegalName(holder.name.value) : null
  const holderRfc = cleanRfc(holder?.rfc.value ?? null)
  const step = holderName ? 'confirm' : 'name'
  await tx.update(supplierRegistrations).set({ step, holderName, holderRfc, legalName: null, rfc: null, corrected: false, updatedAt: new Date() }).where(eq(supplierRegistrations.id, reg.id))
  const body = holderName ? REGISTRATION_REPLIES.confirm(holderName, completeRfc(holderRfc)) : REGISTRATION_REPLIES.ask_name_unread
  await tx.insert(outboundMessages).values({ tenantId: ctx.tenantId, kind: 'registration', channel: reg.channel, destination: reg.address, body })
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: 'registration.confirmation_asked', subject: ctx.application.id, details: { status, holder_name: holderName ? 'read' : 'missing', holder_rfc: completeRfc(holderRfc) ? 'complete' : rfcRoot(holderRfc) ? 'root' : 'missing' } })
}

/**
 * What registration is waiting for, with the same text it was asked with: repeated after replying
 * to a photo or voice note. The step is set by the registration block in inbound.ts.
 */
export function registrationPrompt(reg: Registration | undefined): string {
  if (!reg || waitsForStatement(reg)) return REGISTRATION_REPLIES.ask_statement
  const fixed: Record<string, string> = { contact_name: REGISTRATION_REPLIES.ask_contact_name, amount: REGISTRATION_REPLIES.ask_amount(null), reading: REGISTRATION_REPLIES.still_reading, representative: REGISTRATION_REPLIES.ask_representative }
  const text = fixed[reg.step]
  if (text) return text
  if (reg.step === 'confirm') return REGISTRATION_REPLIES.confirm(reg.holderName ?? '', completeRfc(reg.holderRfc))
  if (reg.step === 'rfc') return REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg))
  return reg.corrected ? REGISTRATION_REPLIES.ask_name_corrected : REGISTRATION_REPLIES.ask_name
}

/** Waiting for the PDF: the step itself, a finished registration, or one left by the previous flow. */
function waitsForStatement(reg: Registration): boolean {
  return reg.step === 'done' || reg.step === 'statement' || reg.step === 'legal_name' || (reg.step === 'rfc' && !reg.applicationId)
}

/**
 * The registering number's supplier, with no identity until they confirm their data; created with
 * the first valid PDF. Verified by possession: the message came from that number. Not equivalent to KYC.
 */
export async function registrationSupplier(tx: Tx, row: Registration, msg: Pick<typeof inboundMessages.$inferSelect, 'id' | 'tenantId' | 'channel' | 'fromAddress'>): Promise<string> {
  if (row.supplierId) return row.supplierId
  const tenantId = msg.tenantId
  const [created] = await tx.insert(suppliers).values({ tenantId, legalName: null, rfc: null }).returning({ id: suppliers.id })
  if (!created) throw new Error('no se creó el proveedor del registro')
  await tx.insert(supplierContacts).values({ tenantId, supplierId: created.id, channel: msg.channel, address: msg.fromAddress, verifiedAt: new Date(), verificationMethod: 'whatsapp_self_registration' })
  await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: 'supplier.created', subject: created.id, details: { source: 'whatsapp_statement_first', inbound_message_id: msg.id } })
  await tx.update(supplierRegistrations).set({ supplierId: created.id }).where(eq(supplierRegistrations.id, row.id))
  row.supplierId = created.id
  return created.id
}

/**
 * The PDF kept before the name and amount (`pending_document_id`) and the message that brought it,
 * so the request is tied to that message in the timeline. Undefined if there is none.
 */
export async function pendingStatement(tx: Tx, reg: Registration): Promise<{ documentId: string; sha256: string; inboundId: string | undefined } | undefined> {
  if (!reg.pendingDocumentId) return undefined
  const [doc] = await tx.select({ documentId: documents.id, sha256: documents.sha256 }).from(documents).where(eq(documents.id, reg.pendingDocumentId))
  if (!doc) return undefined
  const [keptBy] = await tx
    .select({ subject: auditLog.subject })
    .from(auditLog)
    .where(and(inArray(auditLog.action, ['inbound.registration_started', 'inbound.registration_document_kept']), sql`${auditLog.details} ->> 'document_id' = ${reg.pendingDocumentId}`))
    .orderBy(desc(auditLog.at))
    .limit(1)
  return { ...doc, inboundId: keptBy?.subject ?? undefined }
}

/** Text of a request's stored verdict, with the same template as the worker's notice. */
export async function verdictText(tx: Tx, app: { id: string; status: string; request: unknown }): Promise<string | null> {
  const status = FINAL_VERDICTS.find((s) => s === app.status)
  if (!status) return null
  const [d] = await tx.select({ limit: decisions.limitAmount, payload: decisions.payload }).from(decisions).where(and(eq(decisions.applicationId, app.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
  const request = ApplicationRequest.nullable().safeParse(app.request)
  const decision = d ? Decision.safeParse(d.payload) : null
  return renderVerdict({ status, limit: d?.limit == null ? null : Number(d.limit), request: request.success ? request.data : null, tenantName: tenant?.name ?? 'la institución crediticia', reasons: status === 'not_qualified' && decision?.success ? notQualifiedReasons(decision.data) : [] })
}

export interface Completion {
  reply: { body: string; kind: string }
  clarificationId: string | null
  resume: ResumeJob | null
}

async function buildHeldVerdictCompletion(
  tx: Tx,
  tenantId: string,
  app: typeof applications.$inferSelect,
  reg: Registration,
  verdict: string,
  say: (rest: string, kind?: string, clarificationId?: string | null, resume?: ResumeJob | null) => Completion,
): Promise<Completion> {
  await tx.insert(auditLog).values({ tenantId, actor: `inbound:${reg.channel}`, action: 'verdict.queued', subject: app.id, details: { status: app.status, channel: reg.channel, held_until: 'registration' } })
  const [d] = await tx.select({ limit: decisions.limitAmount }).from(decisions).where(and(eq(decisions.applicationId, app.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
  const offer = reg.channel === 'whatsapp' ? await offerAmount(tx, { tenantId, applicationId: app.id, status: app.status, limit: d?.limit == null ? null : Number(d.limit), request: app.request, channel: 'whatsapp', address: reg.address }) : null
  return say(offer ? `${verdict}\n\n${offer}` : verdict, 'verdict')
}

async function handleRegistrationClarification(
  tx: Tx,
  tenantId: string,
  app: typeof applications.$inferSelect,
  identity: { legalName: string; rfc: string },
  say: (rest: string, kind?: string, clarificationId?: string | null, resume?: ResumeJob | null) => Completion,
): Promise<Completion> {
  const [open] = await tx
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.applicationId, app.id), eq(clarifications.status, 'open')))
    .orderBy(desc(clarifications.round))
    .limit(1)
  if (!open) return say(REGISTRATION_REPLIES.analyst)
  const questions = z.array(Question).parse(open.questions)
  const prior = z.array(OwnerAnswer).parse(open.answers)
  const identityAnswers: OwnerAnswer[] = questions.filter((q) => q.kind === 'identity' && !prior.some((a) => a.question_id === q.id)).map((q) => ({ question_id: q.id, kind: 'identity', legal_name: identity.legalName, rfc: identity.rfc, clabe: null }))
  const answers = [...prior, ...identityAnswers]
  if (isComplete(questions, answers)) {
    await tx.update(clarifications).set({ answers, status: 'answered', answeredAt: sql`now()` }).where(eq(clarifications.id, open.id))
    return say(REGISTRATION_REPLIES.finishing, 'registration', open.id, { tenant_id: tenantId, application_id: app.id, clarification_id: open.id })
  }
  await tx.update(clarifications).set({ answers }).where(eq(clarifications.id, open.id))
  const answered = new Set(answers.map((a) => a.question_id))
  const next = nextConversational(questions, open.currentQuestion)
  const q = next >= 0 ? questions[next] : undefined
  if (open.channel === 'whatsapp' && q && !answered.has(q.id)) {
    await tx.update(clarifications).set({ currentQuestion: next, step: 'asking' }).where(eq(clarifications.id, open.id))
    return say(renderQuestionAt(questions, next), 'question', open.id)
  }
  const doc = questions.findIndex((x) => isDocumentRequest(x) && !answered.has(x.id))
  const request = doc >= 0 ? questions[doc] : undefined
  if (open.channel === 'whatsapp' && request) {
    await tx.update(clarifications).set({ currentQuestion: doc, step: 'asking' }).where(eq(clarifications.id, open.id))
    return say(renderDocumentRequest(request), 'question', open.id)
  }
  return say(REGISTRATION_REPLIES.analyst)
}

/**
 * Writes the confirmed identity to the supplier and decides what to reply: the held verdict, the
 * clarification's next question or, if the clarification only waited for the identity, the resume.
 */
export async function completeRegistration(tx: Tx, tenantId: string, reg: Registration, identity: { legalName: string; rfc: string; representative: string | null }): Promise<Completion> {
  if (!reg.supplierId) throw new Error('registro sin proveedor')
  await tx.update(suppliers).set({ legalName: identity.legalName, rfc: identity.rfc, representativeName: identity.representative }).where(eq(suppliers.id, reg.supplierId))
  await tx.update(supplierRegistrations).set({ step: 'done', legalName: identity.legalName, rfc: identity.rfc, updatedAt: new Date() }).where(eq(supplierRegistrations.id, reg.id))
  const matchesRead = !reg.corrected && identity.legalName === reg.holderName
  await tx.insert(auditLog).values({ tenantId, actor: `inbound:${reg.channel}`, action: 'supplier.confirmed', subject: reg.supplierId, details: { source: 'whatsapp_statement_first', confirmed_as_read: String(matchesRead), representative: identity.representative ? 'given' : 'none' } })
  const thanks = REGISTRATION_REPLIES.thanks(identity.legalName)
  const say = (rest: string, kind = 'registration', clarificationId: string | null = null, resume: ResumeJob | null = null): Completion => ({ reply: { body: `${thanks}\n\n${rest}`, kind }, clarificationId, resume })

  const [app] = reg.applicationId ? await tx.select().from(applications).where(eq(applications.id, reg.applicationId)) : []
  if (!app) return say(REGISTRATION_REPLIES.ask_statement)
  const verdict = await verdictText(tx, app)
  if (verdict) return buildHeldVerdictCompletion(tx, tenantId, app, reg, verdict, say)
  if (app.status === 'failed') return say(failureNotice(describeFailure(app.failureReason)), 'verdict')
  if (app.status !== 'needs_clarification') return say(REGISTRATION_REPLIES.finishing)

  return handleRegistrationClarification(tx, tenantId, app, identity, say)
}
