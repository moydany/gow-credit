/**
 * Contexto y trabajos de la cola (ADR 0067). Un trabajo (`process`, `resume`, `redecide`) se reconoce
 * por la fila de bitácora que lo cierra (`application.success|suspended|failed|redecided`); cada llamada
 * al modelo y cada extracción se asigna al primer trabajo que cierra después de ellas.
 */
import { ApplicationStatus } from './enums.ts'
import { chapterFactory, EXCHANGE_CREATED_AT_MARKS, ms, TOL_MS, type Chap, type Ctx, type ExchangeInfo, type Job } from './timeline-build-base.ts'
import { extractionsOf } from './timeline-build-payload.ts'
import { JOB_END_ACTIONS } from './timeline-build-text.ts'
import type { TimelineAuditRow, TimelineClarificationRow, TimelineExchangeRow, TimelineSources } from './timeline-sources.ts'

function exchangeInfo(row: TimelineExchangeRow): ExchangeInfo {
  const latency = Math.max(0, row.latencyMs)
  const created = ms(row.createdAt)
  return EXCHANGE_CREATED_AT_MARKS === 'start' ? { row, startMs: created, endMs: created + latency } : { row, startMs: created - latency, endMs: created }
}

const byAt = (a: TimelineAuditRow, b: TimelineAuditRow): number => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id)

/** Índices de las filas y listas de trabajo; aún sin trabajos. */
export function newCtx(src: TimelineSources): Ctx {
  const chapters = new Map<string, Chap>()
  const docIndexBySha = new Map<string, number>()
  src.documents.forEach((d, i) => {
    if (!docIndexBySha.has(d.sha256)) docIndexBySha.set(d.sha256, i)
  })
  const inboundById = new Map(src.inbound.map((m) => [m.id, m]))
  const mine = (e: TimelineExchangeRow) => e.applicationId === src.application.id
  const ofInbound = (e: TimelineExchangeRow) => e.applicationId === null && e.inboundMessageId !== null && inboundById.has(e.inboundMessageId)
  return {
    src,
    app: src.application,
    drafts: [],
    chapters,
    C: chapterFactory(chapters),
    limitations: [],
    audit: [...src.audit].sort(byAt),
    clarById: new Map(src.clarifications.map((c) => [c.id, c])),
    clarsSorted: [...src.clarifications].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.round - b.round || a.id.localeCompare(b.id)),
    inboundById,
    docIndexBySha,
    extractions: extractionsOf(src),
    appExchanges: src.exchanges.filter(mine).map(exchangeInfo).sort((a, b) => a.startMs - b.startMs || a.row.id.localeCompare(b.row.id)),
    inboundExchanges: src.exchanges.filter(ofInbound).map(exchangeInfo),
    jobs: [],
    inboundChapters: new Map(),
    callOfExchange: new Map(),
    matchedCalls: new Set(),
    inferredSteps: 0,
  }
}

function newJob(index: number, endRow: TimelineAuditRow | null, endMs: number, prevEndMs: number, status: Job['status'], queueStartMs: number): Job {
  return { index, kind: 'process', endRow, endMs, prevEndMs, status, round: 0, queueStartMs, resumed: null, opened: null, exchanges: [], extractions: [], decideAtMs: null }
}

/** Un trabajo por fila de cierre y, si hay actividad después del último cierre, uno en curso. */
function createJobs(ctx: Ctx): void {
  const { app, jobs } = ctx
  const endRows = ctx.audit.filter((a) => JOB_END_ACTIONS.has(a.action) && (a.subject === null || a.subject === app.id))
  let prevEnd = Number.NEGATIVE_INFINITY
  endRows.forEach((row, index) => {
    const parsed = ApplicationStatus.safeParse(row.details.status)
    jobs.push(newJob(index, row, ms(row.at), prevEnd, parsed.success ? parsed.data : app.status, ms(row.at)))
    prevEnd = ms(row.at)
  })
  const all = [...ctx.appExchanges.map((e) => e.endMs), ...ctx.extractions.map((e) => e.finishedMs)]
  const leftover = all.some((t) => jobFor(ctx, t) === null)
  if (!leftover && !(jobs.length === 0 && all.length > 0)) return
  const ends = all.filter((t) => t > prevEnd)
  jobs.push(newJob(jobs.length, null, ends.length ? Math.max(...ends) : ms(app.updatedAt), prevEnd, app.status, ms(app.createdAt)))
}

/** El primer trabajo que cierra después de `atMs` (con holgura). */
export function jobFor(ctx: Ctx, atMs: number): Job | null {
  return ctx.jobs.find((j) => atMs <= j.endMs + TOL_MS) ?? null
}

function assignActivity(ctx: Ctx): void {
  for (const e of ctx.appExchanges) (jobFor(ctx, e.endMs) ?? ctx.jobs.at(-1))?.exchanges.push(e)
  for (const x of ctx.extractions) (jobFor(ctx, x.finishedMs) ?? ctx.jobs.at(-1))?.extractions.push(x)
}

/** Cuándo se completaron los datos de la factura (encola el primer `process`), si hubo. */
function intakeCompletedMs(ctx: Ctx): number | null {
  const done = ctx.src.inbound.filter((m) => m.resolution === 'intake_completed').sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt)).at(-1)
  if (done) return ms(done.processedAt ?? done.receivedAt)
  const viaAudit = ctx.audit.filter((a) => a.action === 'inbound.intake_completed' && a.details.application_id === ctx.app.id).at(-1)
  return viaAudit ? ms(viaAudit.at) : null
}

/** La aclaración contestada más reciente dentro de la ventana del trabajo. */
function answeredIn(ctx: Ctx, j: Job): TimelineClarificationRow | undefined {
  const answered = (c: TimelineClarificationRow): number => c.answeredAt?.getTime() ?? Number.NEGATIVE_INFINITY
  return ctx.clarsSorted.filter((c) => answered(c) > j.prevEndMs && answered(c) <= j.endMs).sort((a, b) => answered(b) - answered(a))[0]
}

function redecideQueueStart(ctx: Ctx, j: Job): number {
  const offers = ctx.src.inbound.filter((m) => m.resolution === 'offer_accepted').map((m) => ms(m.processedAt ?? m.receivedAt))
  const triggers = [...ctx.src.corrections.map((c) => ms(c.createdAt)), ...offers].filter((t) => t > j.prevEndMs && t <= j.endMs)
  return triggers.length ? Math.max(...triggers) : Math.max(j.prevEndMs, ms(ctx.app.createdAt))
}

/** Tipo de trabajo, ronda y desde cuándo está encolado. `answeredRounds` es la ronda del resume anterior. */
function classifyJob(ctx: Ctx, j: Job, answeredRounds: number, intakeMs: number | null): number {
  const answered = answeredIn(ctx, j)
  if (j.endRow?.action === 'application.redecided') j.kind = 'redecide'
  else if (j.index > 0 && answered) j.kind = 'resume'
  j.resumed = j.kind === 'resume' ? (answered ?? null) : null
  j.opened = ctx.clarsSorted.find((c) => ms(c.createdAt) > j.prevEndMs && ms(c.createdAt) <= j.endMs + TOL_MS) ?? null
  if (j.kind === 'resume' && j.resumed) {
    j.round = j.resumed.round
    j.queueStartMs = ms(j.resumed.answeredAt ?? j.resumed.createdAt)
    return j.resumed.round
  }
  if (j.kind === 'redecide') {
    j.round = answeredRounds
    j.queueStartMs = redecideQueueStart(ctx, j)
    return answeredRounds
  }
  j.round = 0
  j.queueStartMs = j.index === 0 ? Math.max(ms(ctx.app.createdAt), intakeMs ?? Number.NEGATIVE_INFINITY) : j.prevEndMs
  return answeredRounds
}

/** Regla de trabajos: los crea, les asigna la actividad y los clasifica. */
export function buildJobs(ctx: Ctx): void {
  createJobs(ctx)
  assignActivity(ctx)
  const intakeMs = intakeCompletedMs(ctx)
  let rounds = 0
  for (const j of ctx.jobs) rounds = classifyJob(ctx, j, rounds, intakeMs)
}

/** Capítulo del veredicto (o de la falla) del último trabajo cerrado hasta `atMs`; null sin trabajos. */
export function verdictChapter(ctx: Ctx, atMs: number): Chap | null {
  const j = [...ctx.jobs].reverse().find((x) => x.endRow !== null && x.endMs <= atMs + TOL_MS) ?? null
  if (j === null) return null
  return j.status === 'failed' ? ctx.C.failure() : ctx.C.verdict(j)
}
