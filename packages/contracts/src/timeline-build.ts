/**
 * Constructor del recorrido (ADR 0067): función pura de las filas guardadas a `ApplicationTimeline`.
 * Sin reloj, sin red, sin azar: la misma entrada da la misma salida. Nada de PII: los textos salen de
 * tablas de etiquetas y de conteos, nunca de los mensajes, los montos ni los datos del documento.
 *
 * Lo que cada evento sabe de su tiempo (`precision`):
 * - `exact`: la columna de tiempo de su propia fila.
 * - `derived`: calculado de dos filas con tiempo (la espera en cola).
 * - `inferred`: el paso no deja tiempo propio y se coloca entre lo que sí lo deja.
 *
 * Una regla por módulo, en este orden:
 * - `timeline-build-jobs`: trabajos de la cola, reconocidos por la fila de bitácora que los cierra.
 * - `timeline-build-messages`: solicitud creada, entrantes y salientes.
 * - `timeline-build-calls`: llamadas al modelo y su emparejamiento con el payload de la extracción.
 * - `timeline-build-steps`: espera en cola, pasos del workflow, verificación y cierre del trabajo.
 * - `timeline-build-decisions`: decisiones del motor.
 * - `timeline-build-records`: aclaraciones, avisos de veredicto y acciones del analista.
 * - `timeline-build-layout`: capítulos, orden, tramos sin actividad y totales.
 */
import { iso, ms } from './timeline-build-base.ts'
import { emitExchangeCalls, emitInferredCalls, pairCalls } from './timeline-build-calls.ts'
import { emitDecisions } from './timeline-build-decisions.ts'
import { addLimitations, bounds, chaptersOf, gapsOf, inheritChapters, orderEvents, totalsOf } from './timeline-build-layout.ts'
import { buildJobs, newCtx } from './timeline-build-jobs.ts'
import { emitCreated, emitInbound, emitOutbound } from './timeline-build-messages.ts'
import { documentsOf } from './timeline-build-payload.ts'
import { emitAnalystRows, emitAudit, emitClarifications, emitOpenWaits } from './timeline-build-records.ts'
import { emitJobs } from './timeline-build-steps.ts'
import { ApplicationTimeline } from './timeline.ts'
import type { TimelineSources } from './timeline-sources.ts'

export { EXCHANGE_CREATED_AT_MARKS } from './timeline-build-base.ts'

export function buildTimeline(src: TimelineSources): ApplicationTimeline {
  const ctx = newCtx(src)
  buildJobs(ctx)
  emitCreated(ctx)
  emitInbound(ctx)
  emitOutbound(ctx)
  pairCalls(ctx)
  emitExchangeCalls(ctx)
  emitInferredCalls(ctx)
  emitJobs(ctx)
  emitDecisions(ctx)
  emitClarifications(ctx)
  emitAudit(ctx)
  emitAnalystRows(ctx)
  inheritChapters(ctx)
  emitOpenWaits(ctx)
  orderEvents(ctx)
  addLimitations(ctx)
  const { startMs, endMs } = bounds(ctx)
  const { gaps, totalMs } = gapsOf(ctx, endMs)
  return ApplicationTimeline.parse({
    application_id: ctx.app.id,
    status: ctx.app.status,
    created_at: iso(ms(ctx.app.createdAt)),
    start: iso(startMs),
    end: iso(endMs),
    documents: documentsOf(src),
    events: ctx.drafts.map((d) => d.event),
    chapters: chaptersOf(ctx),
    gaps,
    totals: totalsOf(ctx, Math.max(0, endMs - startMs), totalMs),
    limitations: ctx.limitations,
  })
}
