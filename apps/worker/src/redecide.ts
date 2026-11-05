/**
 * Reevaluación tras la corrección de un analista (docs/08 §2, ADR 0020). No pasa por el workflow
 * ni por ningún modelo: toma la extracción guardada, le aplica las correcciones (que recalculan el
 * cuadre), vuelve a aplicar las respuestas del proveedor que ya hubo y decide de nuevo con la
 * política activa, con el mismo código puro que el workflow (`decideState`). El resultado queda como
 * un veredicto nuevo; el anterior se conserva.
 */
import { CorrectionTarget, Decision, emptyExternalSnapshot, OwnerAnswer, Question, StatementExtraction, type SupplierIdentity } from '@gow/contracts'
import { auditLog, applications, clarifications, corrections, decisions, extractions, withTenant } from '@gow/db'
import { applyOwnerAnswers } from '@gow/decision'
import { applyCorrections } from '@gow/extraction/corrections'
import { decideState, type AppState } from '@gow/mastra'
import type { RedecideJob } from '@gow/platform'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { insertDecisions, loadContext, requestOf, supplierIdentity } from './store.ts'
import type { WorkerServices } from './worker.ts'

export async function handleRedecide(s: WorkerServices, job: RedecideJob): Promise<string> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  // La API pone la solicitud en `deciding` al guardar las correcciones; si ya no está así, este trabajo ya se hizo.
  if (ctx.application.status !== 'deciding') return ctx.application.status
  if (!ctx.active) throw new Error('el tenant no tiene una política activa')
  const doc = ctx.documents[0]
  if (!doc) throw new Error('la solicitud no tiene documento')

  const loaded = await withTenant(s.db, job.tenant_id, async (tx) => {
    const [ex] = await tx.select().from(extractions).where(eq(extractions.documentId, doc.id)).orderBy(asc(extractions.createdAt)).limit(1)
    const fixes = await tx.select().from(corrections).where(eq(corrections.applicationId, ctx.application.id)).orderBy(asc(corrections.createdAt))
    const rounds = await tx.select().from(clarifications).where(and(eq(clarifications.applicationId, ctx.application.id), eq(clarifications.status, 'answered'))).orderBy(asc(clarifications.round))
    const [last] = await tx.select({ payload: decisions.payload }).from(decisions).where(and(eq(decisions.applicationId, ctx.application.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
    return { ex, fixes, rounds, last }
  })
  if (!loaded.ex) throw new Error('la solicitud no tiene extracción')

  let statement = applyCorrections(
    StatementExtraction.parse(loaded.ex.payload),
    loaded.fixes.map((c) => ({ target: CorrectionTarget.parse(c.target), value: z.union([z.string(), z.number()]).parse(c.value) })),
  )
  // Lo que el proveedor ya contestó sigue valiendo: se reaplica en el orden de las rondas.
  let supplier: SupplierIdentity | null = supplierIdentity(ctx.supplier)
  const contradictions: AppState['contradictions'] = []
  for (const r of loaded.rounds) {
    const applied = applyOwnerAnswers({ statements: [statement], supplier, request: requestOf(ctx), questions: z.array(Question).parse(r.questions), answers: z.array(OwnerAnswer).parse(r.answers) })
    statement = applied.statements[0] ?? statement
    supplier = applied.supplier
    contradictions.push(...applied.contradictions)
  }

  // Mismo "hoy" que la decisión anterior: corregir un valor no envejece el documento.
  const previous = loaded.last ? Decision.safeParse(loaded.last.payload) : null
  const asOf = ctx.application.asOf ?? (previous?.success ? previous.data.profile.computed_at.slice(0, 10) : (s.today ? s.today() : new Date().toISOString().slice(0, 10)))
  const state: AppState = {
    input: { application_id: ctx.application.id, pdf_path: doc.storagePath, as_of: asOf, request: requestOf(ctx), supplier: supplierIdentity(ctx.supplier), policy: ctx.active.policy, policy_id: ctx.active.id },
    statements: [statement],
    documents: [{ file_name: statement.document.file_name, sha256: statement.document.sha256, extraction_status: statement.extraction.status, origin: 'submitted' }],
    supplier,
    classification: null,
    decision: null,
    max_line: null,
    questions: [],
    asked: [],
    answers: [],
    rejected_answers: [],
    contradictions,
    rounds: loaded.rounds.length,
    failure_reason: null,
    calls: [],
    notes: [],
  }
  const decided = decideState(state, s.external ? await s.external(ctx, state) : emptyExternalSnapshot())
  let decision = decided.decision
  if (!decision) throw new Error('el motor no devolvió un veredicto')
  // Con la corrección el motor podría pedir una aclaración nueva; no hay workflow suspendido al cual
  // devolverla, así que se queda con el analista en vez de dejar la solicitud sin salida.
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
  })
  s.logger.info(`application ${ctx.application.id} reevaluada → ${decision.status}`)
  return decision.status
}
