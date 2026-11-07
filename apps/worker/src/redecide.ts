/**
 * Re-evaluation after an analyst correction. It goes through neither the workflow nor any model:
 * it takes the stored extraction, applies the corrections (which recompute the reconciliation),
 * re-applies the supplier answers that already existed and decides again with the active policy
 * and the tenant's current statement-age setting, using the same pure code as the workflow
 * (`decideState`). The result is stored as a new verdict; the previous one is kept.
 */
import { calendarToday, CorrectionTarget, Decision, emptyExternalSnapshot, NO_DECLARATIONS, OwnerAnswer, Question, StatementExtraction, type OwnerDeclarations, type SupplierIdentity } from '@gow/contracts'
import { auditLog, applications, clarifications, corrections, decisions, extractions, withTenant, type Tx } from '@gow/db'
import { applyOwnerAnswers } from '@gow/decision'
import { applyCorrections } from '@gow/extraction/corrections'
import { decideState, questionKey, type AppState } from '@gow/mastra'
import type { RedecideJob } from '@gow/platform'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { insertDecisions, loadContext, queueVerdict, requestOf, supplierIdentity } from './store.ts'
import type { WorkerServices } from './worker.ts'

/** The other months sent together (ADR 0072): their first extraction as stored; corrections go to the first document. */
async function storedExtractions(tx: Tx, documentIds: readonly string[]): Promise<unknown[]> {
  const out: unknown[] = []
  for (const id of documentIds) {
    const [o] = await tx.select({ payload: extractions.payload }).from(extractions).where(eq(extractions.documentId, id)).orderBy(asc(extractions.createdAt)).limit(1)
    if (o) out.push(o.payload)
  }
  return out
}

export async function handleRedecide(s: WorkerServices, job: RedecideJob): Promise<string> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  // The API puts the request in `deciding` when saving corrections; if it no longer is, this job already ran.
  if (ctx.application.status !== 'deciding') return ctx.application.status
  if (!ctx.active) throw new Error('el tenant no tiene una política activa')
  const [doc, ...extra] = ctx.submitted.length > 0 ? ctx.submitted : ctx.documents
  if (!doc) throw new Error('la solicitud no tiene documento')

  const loaded = await withTenant(s.db, job.tenant_id, async (tx) => {
    const [ex] = await tx.select().from(extractions).where(eq(extractions.documentId, doc.id)).orderBy(asc(extractions.createdAt)).limit(1)
    const fixes = await tx.select().from(corrections).where(eq(corrections.applicationId, ctx.application.id)).orderBy(asc(corrections.createdAt))
    const rounds = await tx.select().from(clarifications).where(and(eq(clarifications.applicationId, ctx.application.id), eq(clarifications.status, 'answered'))).orderBy(asc(clarifications.round))
    const [last] = await tx.select({ payload: decisions.payload }).from(decisions).where(and(eq(decisions.applicationId, ctx.application.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
    return { ex, fixes, rounds, last, others: await storedExtractions(tx, extra.map((d) => d.id)) }
  })
  if (!loaded.ex) throw new Error('la solicitud no tiene extracción')

  let statement = applyCorrections(
    StatementExtraction.parse(loaded.ex.payload),
    loaded.fixes.map((c) => ({ target: CorrectionTarget.parse(c.target), value: z.union([z.string(), z.number()]).parse(c.value) })),
  )
  const others = loaded.others.map((o) => StatementExtraction.parse(o)).filter((x) => x.extraction.status !== 'failed')
  // What the supplier already answered still holds: re-applied in round order.
  let supplier: SupplierIdentity | null = supplierIdentity(ctx.supplier)
  let declarations: OwnerDeclarations = NO_DECLARATIONS
  const contradictions: AppState['contradictions'] = []
  for (const r of loaded.rounds) {
    const applied = applyOwnerAnswers({ statements: [statement], supplier, request: requestOf(ctx), questions: z.array(Question).parse(r.questions), answers: z.array(OwnerAnswer).parse(r.answers), declarations })
    statement = applied.statements[0] ?? statement
    supplier = applied.supplier
    declarations = applied.declarations
    contradictions.push(...applied.contradictions)
  }

  // Same "today" as the previous decision: correcting a value does not age the document.
  const previous = loaded.last ? Decision.safeParse(loaded.last.payload) : null
  const asOf = ctx.application.asOf ?? (previous?.success ? previous.data.profile.computed_at.slice(0, 10) : (s.today ? s.today() : calendarToday()))
  const state: AppState = {
    input: { application_id: ctx.application.id, pdf_path: doc.storagePath, extra_pdf_paths: extra.map((d) => d.storagePath), as_of: asOf, request: requestOf(ctx), supplier: supplierIdentity(ctx.supplier), policy: ctx.active.policy, policy_id: ctx.active.id, statement_age: ctx.statementAge },
    statements: [statement, ...others],
    documents: [statement, ...others].map((x) => ({ file_name: x.document.file_name, sha256: x.document.sha256, extraction_status: x.extraction.status, origin: 'submitted' as const })),
    supplier,
    declarations,
    classification: null,
    decision: null,
    max_line: null,
    questions: [],
    asked: [],
    asked_keys: loaded.rounds.flatMap((r) => z.array(Question).parse(r.questions).map(questionKey)),
    answers: [],
    rejected_answers: [],
    contradictions,
    rounds: loaded.rounds.length,
    failure_reason: null,
    calls: [],
    notes: [],
  }
  const external = s.external ? await s.external(ctx, state) : emptyExternalSnapshot()
  let decided = decideState(state, external)
  // Without corrections, the re-evaluation comes from the amount requested after the offer: the
  // engine opens no new questions for that amount (e.g. main client) and decides with what it has.
  if (decided.decision?.status === 'needs_clarification' && loaded.fixes.length === 0) {
    decided = decideState({ ...state, rounds: ctx.active.policy.clarification.maxRounds }, external)
  }
  let decision = decided.decision
  if (!decision) throw new Error('el motor no devolvió un veredicto')
  // With the correction the engine might ask a new clarification; there is no suspended workflow to
  // hand it back to, so it stays with the analyst rather than leaving the request with no way out.
  if (decision.status === 'needs_clarification') {
    decision = Decision.parse({
      ...decision,
      status: 'human_review',
      limit: null,
      clarification: null,
      reasons: [...decision.reasons, { code: 'correction_needs_clarification', message: 'Con las correcciones el motor pediría una aclaración al proveedor; revisa el documento antes de decidir.', features: [] }],
    })
  }

  await withTenant(s.db, job.tenant_id, async (tx) => {
    await insertDecisions(tx, ctx, decision)
    await tx.update(applications).set({ status: decision.status, failureReason: null, updatedAt: new Date() }).where(eq(applications.id, ctx.application.id))
    await tx.insert(auditLog).values({ tenantId: job.tenant_id, actor: 'worker', action: 'application.redecided', subject: ctx.application.id, details: { status: decision.status, corrections: loaded.fixes.length } })
    await queueVerdict(tx, ctx, decision.status, decision.limit, null, decision)
  })
  s.logger.info(`application ${ctx.application.id} reevaluada → ${decision.status}`)
  return decision.status
}
