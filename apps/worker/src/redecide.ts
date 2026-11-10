/**
 * Re-evaluation after an analyst correction. It goes through neither the workflow nor any model:
 * it takes the stored extraction, applies the corrections (which recompute the reconciliation),
 * re-applies the supplier answers that already existed and decides again with the active policy
 * and the tenant's current statement-age setting, using the same pure code as the workflow
 * (`decideState`). The result is stored as a new verdict; the previous one is kept.
 */
import { calendarToday, CorrectionTarget, Decision, emptyExternalSnapshot, NO_DECLARATIONS, OwnerAnswer, Question, StatementExtraction, type ApplicationRequest, type ExternalSnapshot, type OwnerDeclarations, type SupplierIdentity } from '@gow/contracts'
import { auditLog, applications, clarifications, corrections, decisions, extractions, withTenant, type Tx } from '@gow/db'
import { applyOwnerAnswers } from '@gow/decision'
import { applyCorrections } from '@gow/extraction/corrections'
import { decideState, questionKey, type AppState } from '@gow/mastra'
import type { RedecideJob } from '@gow/platform'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { insertDecisions, loadContext, queueVerdict, requestOf, supplierIdentity } from './store.ts'
import type { WorkerServices } from './worker.ts'

/** The first extraction of each document, as stored. */
async function storedExtractions(tx: Tx, documentIds: readonly string[]): Promise<{ documentId: string; payload: unknown }[]> {
  const out: { documentId: string; payload: unknown }[] = []
  for (const id of documentIds) {
    const [o] = await tx.select({ payload: extractions.payload }).from(extractions).where(eq(extractions.documentId, id)).orderBy(asc(extractions.createdAt)).limit(1)
    if (o) out.push({ documentId: id, payload: o.payload })
  }
  return out
}

const rangesOf = (s: StatementExtraction): [string, string][] => s.accounts.flatMap((a) => a.periods.flatMap((p) => (p.period_start.value && p.period_end.value ? [[p.period_start.value, p.period_end.value] as [string, string]] : [])))

/**
 * The submitted statements and, from the answers, those that add months: an answer that
 * covers days already there replaced or repeated a document and stays out, as in the workflow.
 */
function withAddedMonths(submitted: readonly StatementExtraction[], answers: readonly StatementExtraction[]): StatementExtraction[] {
  const out = [...submitted]
  for (const s of answers) {
    const taken = out.flatMap(rangesOf)
    if (!rangesOf(s).some(([a, b]) => taken.some(([c, d]) => a <= d && c <= b))) out.push(s)
  }
  return out
}

/**
 * What the re-evaluation starts from: corrections, answered rounds, the last verdict and the
 * statements, each with its own corrections. A failed extraction stays out unless it is
 * the first one; answers add months only if they do not overlap.
 */
async function loadForRedecide(s: WorkerServices, job: RedecideJob, applicationId: string, submitted: readonly { id: string }[], answered: readonly { id: string }[]) {
  const loaded = await withTenant(s.db, job.tenant_id, async (tx) => {
    const fixes = await tx.select().from(corrections).where(eq(corrections.applicationId, applicationId)).orderBy(asc(corrections.createdAt))
    const rounds = await tx.select().from(clarifications).where(and(eq(clarifications.applicationId, applicationId), eq(clarifications.status, 'answered'))).orderBy(asc(clarifications.round))
    const [last] = await tx.select({ payload: decisions.payload }).from(decisions).where(and(eq(decisions.applicationId, applicationId), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
    return { fixes, rounds, last, rows: await storedExtractions(tx, [...submitted, ...answered].map((d) => d.id)) }
  })
  const corrected = (id: string) =>
    loaded.rows
      .filter((r) => r.documentId === id)
      .map((r) =>
        applyCorrections(
          StatementExtraction.parse(r.payload),
          loaded.fixes.filter((c) => c.documentId === id).map((c) => ({ target: CorrectionTarget.parse(c.target), value: z.union([z.string(), z.number()]).parse(c.value) })),
        ),
      )
  const [first, ...rest] = submitted.flatMap((d) => corrected(d.id))
  if (!first) throw new Error('la solicitud no tiene extracción')
  const usable = (x: StatementExtraction) => x.extraction.status !== 'failed'
  const statements = withAddedMonths([first, ...rest.filter(usable)], answered.flatMap((d) => corrected(d.id)).filter(usable))
  return { ...loaded, statements, submittedSha: new Set([first, ...rest].map((x) => x.document.sha256)) }
}

function resolveAsOfDate(ctx: Awaited<ReturnType<typeof loadContext>>, lastPayload: unknown, today?: () => string): string {
  if (ctx.application.asOf) return ctx.application.asOf
  const previous = lastPayload ? Decision.safeParse(lastPayload) : null
  if (previous?.success) return previous.data.profile.computed_at.slice(0, 10)
  return today ? today() : calendarToday()
}

function replayRounds(
  rounds: { questions: unknown; answers: unknown }[],
  initialStatements: StatementExtraction[],
  initialSupplier: SupplierIdentity | null,
  request: ApplicationRequest | null,
): { statements: StatementExtraction[]; supplier: SupplierIdentity | null; declarations: OwnerDeclarations; contradictions: AppState['contradictions'] } {
  let statements = initialStatements
  let supplier = initialSupplier
  let declarations: OwnerDeclarations = NO_DECLARATIONS
  const contradictions: AppState['contradictions'] = []
  for (const r of rounds) {
    const applied = applyOwnerAnswers({ statements, supplier, request, questions: z.array(Question).parse(r.questions), answers: z.array(OwnerAnswer).parse(r.answers), declarations })
    statements = applied.statements
    supplier = applied.supplier
    declarations = applied.declarations
    contradictions.push(...applied.contradictions)
  }
  return { statements, supplier, declarations, contradictions }
}

function finalizeRedecideDecision(
  state: AppState,
  external: ExternalSnapshot,
  maxRounds: number,
  fixesCount: number,
): Decision {
  let decided = decideState(state, external)
  if (decided.decision?.status === 'needs_clarification' && fixesCount === 0) {
    decided = decideState({ ...state, rounds: maxRounds }, external)
  }
  let decision = decided.decision
  if (!decision) throw new Error('el motor no devolvió un veredicto')
  if (decision.status === 'needs_clarification') {
    decision = Decision.parse({
      ...decision,
      status: 'human_review',
      limit: null,
      clarification: null,
      reasons: [...decision.reasons, { code: 'correction_needs_clarification', message: 'Con las correcciones el motor pediría una aclaración al proveedor; revisa el documento antes de decidir.', features: [] }],
    })
  }
  return decision
}

export async function handleRedecide(s: WorkerServices, job: RedecideJob): Promise<string> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  // The API puts the request in `deciding` when saving corrections; if it no longer is, this job already ran.
  if (ctx.application.status !== 'deciding') return ctx.application.status
  if (!ctx.active) throw new Error('el tenant no tiene una política activa')
  // Submitted documents first, then the ones answers brought (the missing months).
  const submitted = ctx.submitted.length > 0 ? ctx.submitted : ctx.documents
  const answered = ctx.documents.filter((d) => !submitted.some((x) => x.id === d.id))
  const [doc, ...extra] = submitted
  if (!doc) throw new Error('la solicitud no tiene documento')

  const loaded = await loadForRedecide(s, job, ctx.application.id, submitted, answered)
  const req = requestOf(ctx)
  const { statements, supplier, declarations, contradictions } = replayRounds(
    loaded.rounds,
    loaded.statements,
    supplierIdentity(ctx.supplier),
    req,
  )

  // Same "today" as the previous decision: correcting a value does not age the document.
  const asOf = resolveAsOfDate(ctx, loaded.last?.payload, s.today)
  const state: AppState = {
    input: { application_id: ctx.application.id, pdf_path: doc.storagePath, extra_pdf_paths: extra.map((d) => d.storagePath), as_of: asOf, request: req, supplier: supplierIdentity(ctx.supplier), policy: ctx.active.policy, policy_id: ctx.active.id, statement_age: ctx.statementAge },
    statements,
    documents: statements.map((x) => ({ file_name: x.document.file_name, sha256: x.document.sha256, extraction_status: x.extraction.status, origin: loaded.submittedSha.has(x.document.sha256) ? ('submitted' as const) : ('owner_answer' as const) })),
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
  const decision = finalizeRedecideDecision(state, external, ctx.active.policy.clarification.maxRounds, loaded.fixes.length)

  await withTenant(s.db, job.tenant_id, async (tx) => {
    await insertDecisions(tx, ctx, decision)
    await tx.update(applications).set({ status: decision.status, failureReason: null, updatedAt: new Date() }).where(eq(applications.id, ctx.application.id))
    await tx.insert(auditLog).values({ tenantId: job.tenant_id, actor: 'worker', action: 'application.redecided', subject: ctx.application.id, details: { status: decision.status, corrections: loaded.fixes.length } })
    await queueVerdict(tx, ctx, decision.status, decision.limit, null, decision)
  })
  s.logger.info(`application ${ctx.application.id} reevaluada → ${decision.status}`)
  return decision.status
}
