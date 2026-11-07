/**
 * Business operations shared by the integration API (`/v1`, API key) and the backoffice API
 * (`/bo/v1`, user session). Each runs inside `withTenant` and logs who did it (`api:<prefix>` or
 * `user:<id>`), so an action has the same effect and trail whichever way it arrived.
 */
import { isComplete } from '@gow/channels'
import { CorrectionsBody, DiscardBody, DISCARDED_PREFIX, OwnerAnswer, parsePolicy, Profile, Question, StatementExtraction, type SimulationCase } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, clarifications, corrections, decisions, documents, extractions, outcomes, policies, policyVersions, tenants, withTenant, type Db, type Tx } from '@gow/db'
import { simulatePolicy } from '@gow/decision'
import { applyCorrections, CorrectionError, readValue } from '@gow/extraction/corrections'
import { enqueueDiscardNotice, enqueueRedecide, enqueueResume, type PgBoss } from '@gow/platform'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  // Path and message only: the failing value may contain personal data.
  if (!r.success) throw new HttpError(400, 'cuerpo inválido', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

export async function audit(tx: Tx, tenantId: string, actor: string, action: string, subject: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await tx.insert(auditLog).values({ tenantId, actor, action, subject, details })
}

export const AnswersBody = z.strictObject({ answers: z.array(OwnerAnswer).min(1) })
export const PolicyBody = z.strictObject({ document: z.unknown() })
export const OutcomeBody = z.strictObject({ application_id: z.uuid(), outcome: z.enum(['paid', 'late', 'default', 'fraud']), observed_at: z.iso.datetime({ offset: true }) })

/** Answers to an open clarification; once complete, enqueues the workflow resume. */
export async function answerClarification(deps: { db: Db; boss: PgBoss }, tenantId: string, who: string, id: string, answersInput: unknown): Promise<{ id: string; complete: boolean }> {
  const body = parse(AnswersBody, answersInput)
  const r = await withTenant(deps.db, tenantId, async (tx) => {
    const [c] = await tx.select().from(clarifications).where(eq(clarifications.id, id))
    if (!c) throw new HttpError(404, 'aclaración no encontrada')
    if (c.status !== 'open') throw new HttpError(409, `la aclaración está ${c.status}`)
    const questions = z.array(Question).parse(c.questions)
    const unknown = body.answers.filter((a) => !questions.some((q) => q.id === a.question_id))
    if (unknown.length > 0) throw new HttpError(400, 'respuesta a una pregunta que no existe', unknown.map((a) => ({ path: 'answers', message: `pregunta ${a.question_id} desconocida` })))
    const prior = z.array(OwnerAnswer).parse(c.answers).filter((a) => !body.answers.some((b) => b.question_id === a.question_id))
    const answers = [...prior, ...body.answers]
    const done = isComplete(questions, answers)
    await tx.update(clarifications).set({ answers, ...(done ? { status: 'answered' as const, answeredAt: new Date() } : {}) }).where(eq(clarifications.id, id))
    await audit(tx, tenantId, who, 'clarification.answered', id, { answers: body.answers.length, complete: done, channel: c.channel })
    return { done, applicationId: c.applicationId }
  })
  if (r.done) await enqueueResume(deps.boss, { tenant_id: tenantId, application_id: r.applicationId, clarification_id: id })
  return { id, complete: r.done }
}

export async function createPolicyDraft(db: Db, tenantId: string, who: string, documentInput: unknown): Promise<{ id: string | undefined; version: number | undefined; status: string | undefined }> {
  const body = parse(PolicyBody, { document: documentInput })
  const parsed = parsePolicy(body.document)
  if (!parsed.ok) throw new HttpError(400, 'política inválida', parsed.errors)
  const row = await withTenant(db, tenantId, async (tx) => {
    let [p] = await tx.select().from(policies).limit(1)
    p ??= (await tx.insert(policies).values({ tenantId, name: 'principal' }).returning())[0]
    if (!p) throw new HttpError(500, 'sin política')
    const [max] = await tx.select({ v: sql<number>`coalesce(max(${policyVersions.version}), 0)::int` }).from(policyVersions).where(eq(policyVersions.policyId, p.id))
    const [v] = await tx.insert(policyVersions).values({ tenantId, policyId: p.id, version: (max?.v ?? 0) + 1, status: 'draft', document: parsed.policy }).returning()
    await audit(tx, tenantId, who, 'policy.draft_created', v?.id ?? null, { version: v?.version })
    return v
  })
  return { id: row?.id, version: row?.version, status: row?.status }
}

export async function simulateVersion(db: Db, tenantId: string, who: string, id: string) {
  return withTenant(db, tenantId, async (tx) => {
    const versions = await tx.select().from(policyVersions)
    const draft = versions.find((v) => v.id === id)
    if (!draft) throw new HttpError(404, 'versión no encontrada')
    const active = versions.find((v) => v.status === 'active')
    // Each decision stores its full profile so a simulation can re-evaluate it under the other policy.
    const rows = await tx.selectDistinctOn([decisions.applicationId], { applicationId: decisions.applicationId, payload: decisions.payload }).from(decisions).where(eq(decisions.kind, 'active')).orderBy(decisions.applicationId, desc(decisions.createdAt))
    const outs = rows.length ? await tx.select().from(outcomes).where(inArray(outcomes.applicationId, rows.map((r) => r.applicationId))) : []
    const cases: SimulationCase[] = rows.map((r) => ({ id: r.applicationId, profile: Profile.parse((r.payload as { profile: unknown }).profile), outcome: outs.find((o) => o.applicationId === r.applicationId)?.outcome ?? null }))
    const policy = parsePolicy(draft.document)
    const baseline = active ? parsePolicy(active.document) : null
    if (!policy.ok) throw new HttpError(500, 'la versión guardada no es válida')
    // Uses the tenant's statement-age setting, as the worker does.
    const [tenant] = await tx.select({ months: tenants.statementMaxAgeMonths }).from(tenants).where(eq(tenants.id, tenantId))
    const statementAge = tenant ? { statementAge: { max_months: tenant.months } } : {}
    const report = simulatePolicy({ id: draft.id, policy: policy.policy }, cases, active && baseline?.ok ? { id: active.id, policy: baseline.policy } : null, statementAge)
    await tx.update(policyVersions).set({ simulation: report }).where(eq(policyVersions.id, id))
    await audit(tx, tenantId, who, 'policy.simulated', id, { cases: cases.length })
    return report
  })
}

export async function transitionVersion(db: Db, tenantId: string, who: string, id: string, to: 'shadow' | 'active'): Promise<{ id: string; status: 'shadow' | 'active' }> {
  await withTenant(db, tenantId, async (tx) => {
    const [v] = await tx.select().from(policyVersions).where(eq(policyVersions.id, id))
    if (!v) throw new HttpError(404, 'versión no encontrada')
    if (v.status === 'archived' || v.status === to) throw new HttpError(409, `la versión está ${v.status}`)
    // The previous one in that status is archived (active) or goes back to draft (shadow).
    await tx.update(policyVersions).set({ status: to === 'active' ? 'archived' : 'draft' }).where(eq(policyVersions.status, to))
    await tx.update(policyVersions).set({ status: to, ...(to === 'active' ? { activatedAt: new Date() } : {}) }).where(eq(policyVersions.id, id))
    await audit(tx, tenantId, who, `policy.${to === 'active' ? 'activated' : 'shadowed'}`, id, { version: v.version })
  })
  return { id, status: to }
}

export async function recordOutcome(db: Db, tenantId: string, who: string, input: unknown): Promise<void> {
  const body = parse(OutcomeBody, input)
  await withTenant(db, tenantId, async (tx) => {
    const [a] = await tx.select({ id: applications.id }).from(applications).where(eq(applications.id, body.application_id))
    if (!a) throw new HttpError(404, 'solicitud no encontrada')
    await tx.insert(outcomes).values({ tenantId, applicationId: a.id, outcome: body.outcome, observedAt: new Date(body.observed_at) })
    await audit(tx, tenantId, who, 'outcome.recorded', a.id, { outcome: body.outcome })
  })
}

/** The oldest document the request was opened with. */
async function firstSubmitted<T extends { documentId: string; origin: string }>(tx: Tx, links: readonly T[]): Promise<T | undefined> {
  const submitted = links.filter((l) => l.origin === 'submitted')
  if (submitted.length <= 1) return submitted[0] ?? links[0]
  const rows = await tx.select({ id: documents.id }).from(documents).where(inArray(documents.id, submitted.map((l) => l.documentId))).orderBy(documents.createdAt, documents.id).limit(1)
  return submitted.find((l) => l.documentId === rows[0]?.id)
}

/**
 * An analyst corrects extracted values on a request in human review. Every correction is
 * validated by applying it to the extraction (nothing saved if any fails), the (read value,
 * correct value) pairs are stored, and the request is re-enqueued to decide again.
 */
export async function recordCorrections(deps: { db: Db; boss: PgBoss }, tenantId: string, userId: string, applicationId: string, input: unknown): Promise<{ batch: string; corrections: number }> {
  const body = parse(CorrectionsBody, input)
  const batch = randomUUID()
  await withTenant(deps.db, tenantId, async (tx) => {
    const [a] = await tx.select().from(applications).where(eq(applications.id, applicationId))
    if (!a) throw new HttpError(404, 'solicitud no encontrada')
    if (a.status !== 'human_review') throw new HttpError(409, `la solicitud está ${a.status}; solo se corrige en revisión humana`)
    // The document being corrected (ADR 0072): the one given, which must be in the request, or the first one submitted.
    const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, applicationId))
    const link = body.document_id ? links.find((l) => l.documentId === body.document_id) : await firstSubmitted(tx, links)
    if (body.document_id && !link) throw new HttpError(404, 'el documento no es de esta solicitud')
    const [ex] = link ? await tx.select().from(extractions).where(eq(extractions.documentId, link.documentId)).orderBy(extractions.createdAt).limit(1) : []
    if (!link || !ex) throw new HttpError(409, 'la solicitud no tiene una extracción que corregir')
    // Start from what is already corrected on this document: a second correction on the same value reads the corrected one.
    const prior = await tx.select().from(corrections).where(and(eq(corrections.applicationId, applicationId), eq(corrections.documentId, link.documentId))).orderBy(corrections.createdAt)
    let current = applyCorrections(StatementExtraction.parse(ex.payload), prior.map((c) => ({ target: c.target as never, value: c.value as string | number })))
    for (const c of body.corrections) {
      try {
        const read = readValue(current, c.target)
        current = applyCorrections(current, [c])
        await tx.insert(corrections).values({ tenantId, applicationId, documentId: link.documentId, target: c.target, readValue: read, value: c.value, page: c.page, createdBy: userId })
      } catch (e) {
        if (e instanceof CorrectionError) throw new HttpError(400, 'corrección inválida', [{ path: 'corrections', message: e.message }])
        throw e
      }
    }
    await tx.update(applications).set({ status: 'deciding', updatedAt: new Date() }).where(eq(applications.id, applicationId))
    await audit(tx, tenantId, `user:${userId}`, 'correction.recorded', applicationId, { corrections: body.corrections.length, targets: body.corrections.map((c) => `${c.target.kind}.${c.target.field}`) })
  })
  await enqueueRedecide(deps.boss, { tenant_id: tenantId, application_id: applicationId, correction_batch: batch })
  return { batch, corrections: body.corrections.length }
}

/**
 * Discard the document in human review: the request closes as `not_qualified` without going through the engine.
 * The worker then tells the supplier on WhatsApp (queued after the commit, so a failed discard never notifies).
 */
export async function discardDocument(deps: { db: Db; boss: PgBoss }, tenantId: string, userId: string, applicationId: string, input: unknown): Promise<{ id: string; status: 'not_qualified' }> {
  const body = parse(DiscardBody, input)
  await withTenant(deps.db, tenantId, async (tx) => {
    const [a] = await tx.select().from(applications).where(eq(applications.id, applicationId))
    if (!a) throw new HttpError(404, 'solicitud no encontrada')
    if (a.status !== 'human_review') throw new HttpError(409, `la solicitud está ${a.status}; solo se descarta en revisión humana`)
    await tx.update(applications).set({ status: 'not_qualified', failureReason: `${DISCARDED_PREFIX}${body.reason}`, updatedAt: new Date() }).where(eq(applications.id, applicationId))
    await audit(tx, tenantId, `user:${userId}`, 'application.discarded', applicationId, { reason: body.reason })
  })
  await enqueueDiscardNotice(deps.boss, { tenant_id: tenantId, application_id: applicationId })
  return { id: applicationId, status: 'not_qualified' }
}

