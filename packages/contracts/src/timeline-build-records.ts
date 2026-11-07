/**
 * Regla de aclaraciones, bitácora y analista (ADR 0067): aclaración abierta, espera del proveedor y
 * respuesta; avisos de veredicto en cola; acciones del analista, resultados y correcciones.
 */
import { ApplicationStatus } from './enums.ts'
import { addEvent, count, cut, ms, SAME_ACTION_MS, type Ctx } from './timeline-build-base.ts'
import { verdictChapter } from './timeline-build-jobs.ts'
import { ANALYST_ES, STATUS_ES } from './timeline-build-text.ts'
import type { TimelineAuditRow, TimelineClarificationRow } from './timeline-sources.ts'

const OUTCOME_RECORDED = 'outcome.recorded'

function suspendedBody(c: TimelineClarificationRow) {
  return { id: `clarifications:${c.id}:suspended`, kind: 'workflow_suspended', lane: 'workflow', precision: 'exact', label: `Espera la respuesta del proveedor · ronda ${String(c.round)}`, source: { table: 'clarifications', id: c.id }, round: Math.max(1, c.round) } as const
}

/** Abierta y contestada de cada aclaración; la espera de las contestadas (las abiertas llegan al final, ver `emitOpenWaits`). */
export function emitClarifications(ctx: Ctx): void {
  for (const c of ctx.src.clarifications) {
    const chap = ctx.C.clarification(c.round)
    addEvent<'clarification_opened'>(ctx, { id: `clarifications:${c.id}:opened`, kind: 'clarification_opened', lane: 'workflow', precision: 'exact', label: `Se abre la aclaración de la ronda ${String(c.round)} (${String(c.questions)} pregunta(s))`, source: { table: 'clarifications', id: c.id }, clarification_id: c.id, round: Math.max(1, c.round), channel: c.channel, questions: Math.max(0, c.questions) }, ms(c.createdAt), null, chap)
    if (!c.answeredAt) continue
    addEvent<'clarification_answered'>(ctx, { id: `clarifications:${c.id}:answered`, kind: 'clarification_answered', lane: 'supplier', precision: 'exact', label: `Respuestas recibidas (${String(c.answers)}) · ronda ${String(c.round)}`, source: { table: 'clarifications', id: c.id }, clarification_id: c.id, round: Math.max(1, c.round), answers: Math.max(0, c.answers) }, ms(c.answeredAt), null, chap)
    addEvent<'workflow_suspended'>(ctx, suspendedBody(c), ms(c.createdAt), ms(c.answeredAt), chap, { active: false })
  }
}

/** La espera de una aclaración sin contestar llega hasta el final de lo demás en la línea. */
export function emitOpenWaits(ctx: Ctx): void {
  const lastOther = ctx.drafts.reduce((m, d) => Math.max(m, d.endMs ?? d.startMs), Number.NEGATIVE_INFINITY)
  for (const c of ctx.src.clarifications) {
    if (c.answeredAt) continue
    const start = ms(c.createdAt)
    addEvent<'workflow_suspended'>(ctx, suspendedBody(c), start, lastOther > start ? lastOther : null, ctx.C.clarification(c.round), { active: false })
  }
}

function emitVerdictQueued(ctx: Ctx, a: TimelineAuditRow): void {
  const parsed = ApplicationStatus.safeParse(a.details.status)
  const status = parsed.success ? parsed.data : ctx.app.status
  addEvent<'verdict_queued'>(
    ctx,
    { id: `audit_log:${a.id}`, kind: 'verdict_queued', lane: 'relay', precision: 'exact', label: `Aviso del resultado en cola: ${STATUS_ES[status]}`, source: { table: 'audit_log', id: a.id }, application_status: status },
    ms(a.at),
    null,
    status === 'failed' ? ctx.C.failure() : verdictChapter(ctx, ms(a.at)),
  )
}

function analystLabel(a: TimelineAuditRow): string {
  if (a.action === 'correction.recorded') return `El analista registró ${String(count(a.details.corrections))} corrección(es)`
  return ANALYST_ES[a.action] ?? `Acción del analista: ${a.action}`
}

/** ¿Es una acción de un usuario del backoffice sobre esta solicitud (o sus aclaraciones)? */
function isAnalystAction(ctx: Ctx, a: TimelineAuditRow): boolean {
  if (!a.actor.startsWith('user:')) return false
  const mine = a.subject === ctx.app.id || a.details.application_id === ctx.app.id || (a.subject !== null && ctx.clarById.has(a.subject))
  if (!mine) return false
  // El resultado ya sale de su propia fila (`outcomes`).
  return !(a.action === OUTCOME_RECORDED && ctx.src.outcomes.some((o) => Math.abs(ms(o.createdAt) - ms(a.at)) <= SAME_ACTION_MS))
}

/** Avisos de veredicto en cola y acciones del analista, de la bitácora. */
export function emitAudit(ctx: Ctx): void {
  for (const a of ctx.audit) {
    if (a.action === 'verdict.queued' && a.subject === ctx.app.id) emitVerdictQueued(ctx, a)
    else if (isAnalystAction(ctx, a)) addEvent<'analyst_action'>(ctx, { id: `audit_log:${a.id}`, kind: 'analyst_action', lane: 'analyst', precision: 'exact', label: cut(analystLabel(a)), source: { table: 'audit_log', id: a.id }, action: a.action }, ms(a.at), null, ctx.C.analyst())
  }
}

/** Resultados registrados y correcciones del analista. */
export function emitAnalystRows(ctx: Ctx): void {
  for (const o of ctx.src.outcomes) {
    addEvent<'analyst_action'>(ctx, { id: `outcomes:${o.id}`, kind: 'analyst_action', lane: 'analyst', precision: 'exact', label: ANALYST_ES[OUTCOME_RECORDED] ?? 'Resultado registrado', source: { table: 'outcomes', id: o.id }, action: OUTCOME_RECORDED }, ms(o.createdAt), null, ctx.C.analyst())
  }
  for (const c of ctx.src.corrections) {
    const idx = ctx.src.documents.findIndex((d) => d.documentId === c.documentId)
    addEvent<'correction'>(ctx, { id: `corrections:${c.id}`, kind: 'correction', lane: 'analyst', precision: 'exact', label: cut(`Corrección del analista: ${c.target}`), source: { table: 'corrections', id: c.id }, document_index: idx >= 0 ? idx : null, page: c.page !== null && c.page >= 1 ? c.page : null, target: c.target }, ms(c.createdAt), null, ctx.C.analyst())
  }
}
