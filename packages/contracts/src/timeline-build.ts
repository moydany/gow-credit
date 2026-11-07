/**
 * Journey builder: a pure function from stored rows to `ApplicationTimeline`. No clock, network or
 * randomness: same input, same output. No PII: texts come from label tables and counts, never
 * from messages, amounts or document data.
 *
 * What each event knows about its time (`precision`):
 * - `exact`: the time column of its own row.
 * - `derived`: computed from two rows with a time (queue wait).
 * - `inferred`: the step has no time of its own and is placed among those that do.
 *
 * One rule per module, in this order:
 * - `timeline-build-jobs`: queue jobs, recognized by the log row that closes them.
 * - `timeline-build-messages`: request created, incoming and outgoing messages.
 * - `timeline-build-calls`: model calls and their matching with the extraction payload.
 * - `timeline-build-steps`: queue wait, workflow steps, verification and job close.
 * - `timeline-build-decisions`: engine decisions.
 * - `timeline-build-records`: clarifications, verdict notices and analyst actions.
 * - `timeline-build-layout`: chapters, order, inactive stretches and totals.
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
