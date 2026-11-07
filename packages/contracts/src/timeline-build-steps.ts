/**
 * Regla de trabajos y pasos del workflow (ADR 0067): la espera en cola, los pasos de
 * `process-application` (extract → classify-transactions → decide → ask-owner | explain → finalize), la
 * verificación de cada documento y el cierre del trabajo. Los pasos que no dejan hora propia se colocan
 * por inferencia entre los eventos que sí la tienen.
 */
import { addEvent, ms, spanEnd, type Chap, type Ctx, type ExchangeInfo, type Job } from './timeline-build-base.ts'
import { extractionStatus, payloadStats } from './timeline-build-payload.ts'
import { EXPLAIN_PURPOSES, JOB_DONE_ES, JOB_ES, P_CLASSIFY_TX, P_QUESTIONS, STATUS_ES, STEP_ES } from './timeline-build-text.ts'
import { WorkflowStepId, type TimelinePrecision, type TimelineSource } from './timeline.ts'

interface View {
  j: Job
  key: string
  source: TimelineSource | null
  running: boolean
  failed: boolean
  suspended: boolean
  firstActivity: number | null
  write: ExchangeInfo[]
  explain: ExchangeInfo[]
  classify: ExchangeInfo[]
  exChap: Chap
}

const minStart = (l: readonly ExchangeInfo[]): number => Math.min(...l.map((e) => e.startMs))
const maxEnd = (l: readonly ExchangeInfo[]): number => Math.max(...l.map((e) => e.endMs))
const stepOrder = (s: WorkflowStepId): number => WorkflowStepId.options.indexOf(s)

function viewOf(ctx: Ctx, j: Job): View {
  const running = j.endRow === null
  const failed = !running && j.status === 'failed'
  const times = [...j.exchanges.map((e) => e.startMs), ...j.extractions.map((e) => e.startMs)]
  return {
    j,
    key: j.endRow ? `audit_log:${j.endRow.id}` : `applications:${ctx.app.id}:job${String(j.index)}`,
    source: j.endRow ? { table: 'audit_log', id: j.endRow.id } : null,
    running,
    failed,
    suspended: !running && !failed && (j.status === 'needs_clarification' || j.endRow?.action === 'application.suspended'),
    firstActivity: times.length ? Math.min(...times) : null,
    write: j.exchanges.filter((e) => e.row.purpose === P_QUESTIONS),
    explain: j.exchanges.filter((e) => EXPLAIN_PURPOSES.has(e.row.purpose)),
    classify: j.exchanges.filter((e) => e.row.purpose === P_CLASSIFY_TX),
    exChap: j.kind === 'resume' ? ctx.C.resume(j.round) : ctx.C.extraction(j),
  }
}

function step(ctx: Ctx, v: View, name: WorkflowStepId, startMs: number, endMs: number | null, precision: TimelinePrecision, chap: Chap, o: { source?: TimelineSource | null; suffix?: string } = {}): void {
  if (precision === 'inferred') ctx.inferredSteps++
  addEvent<'workflow_step'>(
    ctx,
    { id: `${v.key}:step:${name}${o.suffix ?? ''}`, kind: 'workflow_step', lane: 'workflow', precision, label: STEP_ES[name], source: o.source ?? v.source, step: name, round: v.j.round },
    startMs,
    endMs,
    chap,
    { sub: stepOrder(name) },
  )
}

/** Espera en la cola (derivada): del encolado a la primera actividad del trabajo. */
function emitQueueWait(ctx: Ctx, v: View): void {
  const { j } = v
  if (v.firstActivity === null || v.firstActivity <= j.queueStartMs || !Number.isFinite(j.queueStartMs)) return
  const chaps = { process: ctx.C.extraction(j), resume: ctx.C.resume(j.round), redecide: ctx.C.redecide(j) }
  addEvent<'queue_wait'>(
    ctx,
    { id: `${v.key}:queue_wait`, kind: 'queue_wait', lane: 'queue', precision: 'derived', label: `En cola: ${JOB_ES[j.kind].toLowerCase()}`, source: v.source, job: j.kind },
    j.queueStartMs,
    v.firstActivity,
    chaps[j.kind],
    { active: false },
  )
}

/** ask-owner: de la redacción de las preguntas a que se abre la aclaración. */
function emitAskOwner(ctx: Ctx, v: View, decideEnd: number): void {
  const { j } = v
  const askStart = v.write.length ? minStart(v.write) : decideEnd
  const opened = j.opened
  const askEnd = opened ? Math.max(askStart, ms(opened.createdAt)) : v.write.length ? maxEnd(v.write) : null
  const exact = v.write.length > 0 && opened !== null
  step(ctx, v, 'ask-owner', askStart, spanEnd(askStart, askEnd), exact ? 'exact' : 'inferred', ctx.C.clarification(opened?.round ?? j.round + 1), { source: opened ? { table: 'clarifications', id: opened.id } : null })
}

/** explain (exacto si hubo redacción) y finalize (justo antes del cierre). */
function emitExplainFinalize(ctx: Ctx, v: View, decideEnd: number): void {
  const chap = ctx.C.explanation(v.j)
  let explainEnd = decideEnd
  if (v.explain.length) {
    explainEnd = maxEnd(v.explain)
    step(ctx, v, 'explain', minStart(v.explain), explainEnd, 'exact', chap)
  } else step(ctx, v, 'explain', decideEnd, null, 'inferred', chap)
  const last = Math.max(decideEnd, explainEnd)
  step(ctx, v, 'finalize', last, spanEnd(last, v.j.endMs), 'inferred', ctx.C.verdict(v.j))
}

/** decide (o re-decide) y lo que sigue: preguntar al dueño si se suspendió; explicar y guardar si no. */
function emitDecideTail(ctx: Ctx, v: View, cursor: number): void {
  const boundary = v.suspended ? (v.write.length ? minStart(v.write) : null) : v.explain.length ? minStart(v.explain) : null
  step(ctx, v, v.j.kind === 'resume' ? 're-decide' : 'decide', cursor, spanEnd(cursor, boundary), 'inferred', ctx.C.decision(v.j.round + 1))
  v.j.decideAtMs = cursor
  const decideEnd = boundary !== null && boundary > cursor ? boundary : cursor
  if (v.suspended) emitAskOwner(ctx, v, decideEnd)
  else emitExplainFinalize(ctx, v, decideEnd)
}

function emitExtractSteps(ctx: Ctx, v: View): void {
  for (const x of v.j.extractions) step(ctx, v, 'extract', x.startMs, x.finishedMs > x.startMs ? x.finishedMs : null, 'exact', v.exChap, { source: { table: 'extractions', id: x.extractionId }, suffix: `:${String(x.docIndex)}` })
}

/** Reanudación: apply-answers contiene la extracción y la clasificación de los documentos de la respuesta. */
function emitResumeSteps(ctx: Ctx, v: View, extractEnd: number | null): number {
  const owner = Math.max(extractEnd ?? Number.NEGATIVE_INFINITY, v.classify.length ? maxEnd(v.classify) : Number.NEGATIVE_INFINITY)
  const applyStart = v.firstActivity ?? v.j.queueStartMs
  const hasOwner = Number.isFinite(owner)
  if (!v.running) step(ctx, v, 'apply-answers', applyStart, spanEnd(applyStart, hasOwner ? owner : null), 'inferred', ctx.C.resume(v.j.round))
  return hasOwner ? Math.max(owner, applyStart) : applyStart
}

/** classify-transactions: exacto si hubo llamadas; si no, un punto tras la extracción. */
function emitClassifyStep(ctx: Ctx, v: View, cursor: number): number {
  if (v.classify.length) {
    step(ctx, v, 'classify-transactions', minStart(v.classify), maxEnd(v.classify), 'exact', ctx.C.classification(v.j))
    return Math.max(cursor, maxEnd(v.classify))
  }
  if (!v.running && !v.failed) step(ctx, v, 'classify-transactions', cursor, null, 'inferred', ctx.C.classification(v.j))
  return cursor
}

function emitWorkflowSteps(ctx: Ctx, v: View): void {
  const { j } = v
  const extractEnd = j.extractions.length ? Math.max(...j.extractions.map((e) => e.finishedMs)) : null
  emitExtractSteps(ctx, v)
  const cursor = j.kind === 'resume' ? emitResumeSteps(ctx, v, extractEnd) : emitClassifyStep(ctx, v, extractEnd ?? v.firstActivity ?? j.queueStartMs)
  if (!v.running && !v.failed) emitDecideTail(ctx, v, cursor)
  else if (v.running && v.explain.length) step(ctx, v, 'explain', minStart(v.explain), maxEnd(v.explain), 'exact', ctx.C.explanation(j))
}

function emitVerification(ctx: Ctx, v: View): void {
  for (const x of v.j.extractions) {
    const st = payloadStats(x.payload)
    addEvent<'verification'>(
      ctx,
      {
        id: `extractions:${x.extractionId}:verification`,
        kind: 'verification',
        lane: 'workflow',
        precision: 'exact',
        label: `Verificación del documento: ${String(st.verified)} verificados, ${String(st.unverified)} sin verificar, ${String(st.conflict)} en conflicto`,
        source: { table: 'extractions', id: x.extractionId },
        document_index: x.docIndex,
        extraction_status: extractionStatus(x.payload) ?? 'complete',
        verified: st.verified,
        unverified: st.unverified,
        conflict: st.conflict,
        pages_with_issues: st.pagesWithIssues,
        flags: st.flags,
      },
      x.finishedMs,
      null,
      v.exChap,
    )
  }
}

function finishChapter(ctx: Ctx, v: View): Chap {
  const { j } = v
  if (v.failed) return ctx.C.failure()
  if (v.suspended) return ctx.C.clarification(j.opened?.round ?? j.round + 1)
  return j.kind === 'redecide' ? ctx.C.redecide(j) : ctx.C.verdict(j)
}

function emitFinish(ctx: Ctx, v: View): void {
  const { j } = v
  if (!j.endRow) return
  addEvent<'job_finished'>(
    ctx,
    { id: v.key, kind: 'job_finished', lane: 'queue', precision: 'exact', label: `${JOB_DONE_ES[j.kind]}: ${STATUS_ES[j.status]}`, source: v.source, job: j.kind, application_status: j.status },
    j.endMs,
    null,
    finishChapter(ctx, v),
  )
}

/** Una solicitud en falla sin fila de cierre (por ejemplo, sin política activa): queda su estado. */
function emitFailureWithoutRow(ctx: Ctx): void {
  const { app } = ctx
  if (app.status !== 'failed' || ctx.jobs.some((j) => j.endRow !== null)) return
  addEvent<'job_finished'>(
    ctx,
    { id: `applications:${app.id}:failed`, kind: 'job_finished', lane: 'queue', precision: 'exact', label: `${JOB_DONE_ES.process}: ${STATUS_ES.failed}`, source: { table: 'applications', id: app.id }, job: null, application_status: 'failed' },
    ms(app.updatedAt),
    null,
    ctx.C.failure(),
  )
  ctx.limitations.push('La solicitud falló sin dejar la fila de bitácora que cierra el trabajo; se usó la hora de su última actualización.')
}

export function emitJobs(ctx: Ctx): void {
  for (const j of ctx.jobs) {
    const v = viewOf(ctx, j)
    emitQueueWait(ctx, v)
    if (j.kind === 'redecide') j.decideAtMs = j.endMs
    else emitWorkflowSteps(ctx, v)
    emitVerification(ctx, v)
    emitFinish(ctx, v)
  }
  emitFailureWithoutRow(ctx)
}

