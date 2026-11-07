/**
 * Registro con el estado de cuenta primero (ADR 0047, solo la demo con `WHATSAPP_SELF_REGISTRATION`).
 *
 * 1. Un número sin vínculo saluda: se le pide el estado de cuenta.
 * 2. Llega el PDF: se crea un proveedor sin identidad (`legal_name` null) con el contacto verificado
 *    por posesión del número, y la solicitud se analiza de inmediato.
 * 3. Termina el análisis: el resultado no sale. Se le muestra al mismo número el titular y el RFC
 *    leídos para que los confirme o corrija (`startConfirmation`), y se pide lo que falte: el RFC
 *    completo si vino sin homoclave, el representante legal si es persona moral.
 * 4. Con esos datos, el proveedor queda con su identidad y sale el resultado
 *    (`completeRegistration`): el veredicto que ya había o, si el motor esperaba la identidad, la
 *    aclaración se contesta con lo confirmado y la reanudación decide.
 */
import { failureNotice, isComplete, isDocumentRequest, nextConversational, notQualifiedReasons, parseLegalName, parseRfc, REGISTRATION_REPLIES, renderDocumentRequest, renderQuestionAt, renderVerdict } from '@gow/channels'
import { ApplicationRequest, Decision, describeFailure, OwnerAnswer, Question, rfcRoot } from '@gow/contracts'
import { applications, auditLog, clarifications, decisions, outboundMessages, supplierRegistrations, suppliers, tenants, type Tx } from '@gow/db'
import type { AppState } from '@gow/mastra'
import type { ResumeJob } from '@gow/platform'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { offerAmount } from './offer.ts'
import type { AppContext } from './store.ts'

export const FINAL_VERDICTS = ['qualified', 'qualified_with_limit', 'not_qualified', 'human_review'] as const

type Registration = typeof supplierRegistrations.$inferSelect

/** El RFC tal como se compara: sin espacios ni guiones y en mayúsculas. */
function cleanRfc(raw: string | null): string | null {
  const s = raw?.replace(/[\s-]/g, '').toUpperCase() ?? ''
  return s.length ? s : null
}

/** El RFC del titular, si viene completo. */
export function completeRfc(holderRfc: string | null): string | null {
  return holderRfc ? parseRfc(holderRfc) : null
}

/** Por qué se pide el RFC al proveedor. */
export function rfcAskReason(reg: Pick<Registration, 'corrected' | 'holderRfc'>) {
  if (reg.corrected) return { kind: 'corrected' as const }
  const root = rfcRoot(reg.holderRfc)
  return root ? { kind: 'root' as const, root } : { kind: 'missing' as const }
}

/**
 * Termina la primera lectura de un proveedor que se está registrando. Si falló (no era estado de
 * cuenta, no se pudo leer), el aviso sale como siempre y el registro vuelve a esperar un PDF. Si no,
 * el resultado se retiene y se pregunta si el titular y el RFC leídos son los suyos.
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
 * Lo que el registro está esperando, con el mismo texto que se le pidió (ADR 0051): se repite después
 * de contestar a una foto o nota de voz. El paso lo fija el bloque de registro de inbound.ts.
 */
export function registrationPrompt(reg: Registration | undefined): string {
  if (!reg || reg.step === 'done' || reg.step === 'statement' || reg.step === 'legal_name' || (reg.step === 'rfc' && !reg.applicationId)) return REGISTRATION_REPLIES.ask_statement
  if (reg.step === 'reading') return REGISTRATION_REPLIES.still_reading
  if (reg.step === 'confirm') return REGISTRATION_REPLIES.confirm(reg.holderName ?? '', completeRfc(reg.holderRfc))
  if (reg.step === 'rfc') return REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg))
  if (reg.step === 'representative') return REGISTRATION_REPLIES.ask_representative
  return reg.corrected ? REGISTRATION_REPLIES.ask_name_corrected : REGISTRATION_REPLIES.ask_name
}

/** Texto del veredicto ya guardado de una solicitud, con la misma plantilla que el aviso del worker. */
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

/**
 * Escribe la identidad confirmada en el proveedor y decide qué contestar: el veredicto retenido, la
 * siguiente pregunta de la aclaración o, si la aclaración solo esperaba la identidad, la reanudación.
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
  if (verdict) {
    await tx.insert(auditLog).values({ tenantId, actor: `inbound:${reg.channel}`, action: 'verdict.queued', subject: app.id, details: { status: app.status, channel: reg.channel, held_until: 'registration' } })
    // Sin monto pedido y con línea, también aquí se pregunta cuánto quiere adelantar (ADR 0053).
    const [d] = await tx.select({ limit: decisions.limitAmount }).from(decisions).where(and(eq(decisions.applicationId, app.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
    const offer = reg.channel === 'whatsapp' ? await offerAmount(tx, { tenantId, applicationId: app.id, status: app.status, limit: d?.limit == null ? null : Number(d.limit), request: app.request, channel: 'whatsapp', address: reg.address }) : null
    return say(offer ? `${verdict}\n\n${offer}` : verdict, 'verdict')
  }
  if (app.status === 'failed') return say(failureNotice(describeFailure(app.failureReason)), 'verdict')
  if (app.status !== 'needs_clarification') return say(REGISTRATION_REPLIES.finishing)

  const [open] = await tx
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.applicationId, app.id), eq(clarifications.status, 'open')))
    .orderBy(desc(clarifications.round))
    .limit(1)
  if (!open) return say(REGISTRATION_REPLIES.analyst)
  // La pregunta de identidad se contesta con lo que el proveedor acaba de confirmar o corregir.
  const questions = z.array(Question).parse(open.questions)
  const prior = z.array(OwnerAnswer).parse(open.answers)
  const identityAnswers: OwnerAnswer[] = questions.filter((q) => q.kind === 'identity' && !prior.some((a) => a.question_id === q.id)).map((q) => ({ question_id: q.id, kind: 'identity', legal_name: identity.legalName, rfc: identity.rfc, clabe: null }))
  const answers = [...prior, ...identityAnswers]
  if (isComplete(questions, answers)) {
    await tx.update(clarifications).set({ answers, status: 'answered', answeredAt: sql`now()` }).where(eq(clarifications.id, open.id))
    return say(REGISTRATION_REPLIES.finishing, 'registration', open.id, { tenant_id: tenantId, application_id: app.id, clarification_id: open.id })
  }
  await tx.update(clarifications).set({ answers }).where(eq(clarifications.id, open.id))
  // Quedan abonos por preguntar por este chat: la pregunta retenida sale ahora.
  const answered = new Set(answers.map((a) => a.question_id))
  const next = nextConversational(questions, open.currentQuestion)
  const q = next >= 0 ? questions[next] : undefined
  // El resumen para confirmar sale al contestar la última (ADR 0051); sin preguntas por el chat no hay resumen.
  if (open.channel === 'whatsapp' && q && !answered.has(q.id)) {
    await tx.update(clarifications).set({ currentQuestion: next, step: 'asking' }).where(eq(clarifications.id, open.id))
    return say(renderQuestionAt(questions, next), 'question', open.id)
  }
  // Sin preguntas por el chat, la de páginas faltantes se contesta mandando el PDF por este chat: sale el
  // pedido, igual que cuando no hay registro de por medio (channel.ts), y no el aviso del analista.
  const doc = questions.findIndex((x) => isDocumentRequest(x) && !answered.has(x.id))
  const request = doc >= 0 ? questions[doc] : undefined
  if (open.channel === 'whatsapp' && request) {
    await tx.update(clarifications).set({ currentQuestion: doc, step: 'asking' }).where(eq(clarifications.id, open.id))
    return say(renderDocumentRequest(request), 'question', open.id)
  }
  return say(REGISTRATION_REPLIES.analyst)
}
