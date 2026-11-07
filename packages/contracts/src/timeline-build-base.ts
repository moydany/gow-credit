/**
 * Shared base of the timeline builder: defensive reading helpers, internal types, the context the
 * rules walk and event creation. See `timeline-build.ts`.
 */
import type { ApplicationStatus } from './enums.ts'
import type { TimelineChapter, TimelineEvent, TimelineEventKind, TimelineJob } from './timeline.ts'
import type { TimelineAuditRow, TimelineClarificationRow, TimelineDocumentRow, TimelineExchangeRow, TimelineInboundRow, TimelineSources } from './timeline-sources.ts'

/** Inactive stretch from which the timeline collapses it. */
export const GAP_MS = 60_000
/** Slack for linking rows written in different transactions of the same job. */
export const TOL_MS = 1_000
/** Two analyst rows of the same action (outcome and its log entry) count as one. */
export const SAME_ACTION_MS = 5_000

/**
 * What `llm_exchanges.created_at` marks. The sink (`apps/worker/src/llm-exchanges.ts`) stores
 * `createdAt: new Date(e.at)` and `e.at` is when the call STARTED (`recording.ts`), so today it is
 * the start. If the row is saved at the end instead, change this to `'end'`.
 */
export const EXCHANGE_CREATED_AT_MARKS = 'start' as 'start' | 'end'

// ---------------------------------------------------------------- defensive reading

export type Rec = Record<string, unknown>
export const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x)
export const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
export const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const ms = (d: Date): number => d.getTime()
export const iso = (n: number): string => new Date(n).toISOString()
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6
export const cut = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const pageNumber = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : null)
export const count = (x: unknown): number => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : 0)

export function get(x: unknown, ...path: string[]): unknown {
  let cur = x
  for (const k of path) {
    if (!isRec(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

export function parseMs(x: unknown): number | null {
  const s = str(x)
  if (s === null) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** The value if it is an allowed one; otherwise null. */
export function oneOf<T extends string>(x: unknown, values: readonly T[]): T | null {
  return typeof x === 'string' && (values as readonly string[]).includes(x) ? (x as T) : null
}

/** Inferred span: no end if it has no duration. */
export const spanEnd = (a: number, b: number | null): number | null => (b !== null && b > a ? b : null)

// ---------------------------------------------------------------- internal types

export interface Chap {
  id: string
  kind: TimelineChapter['kind']
  title: string
  round: number
}

export type Body<K extends TimelineEventKind> = Omit<Extract<TimelineEvent, { kind: K }>, 'start' | 'end' | 'chapter'>

export interface Draft {
  event: TimelineEvent
  startMs: number
  endMs: number | null
  /** null: takes the chapter of the previous event already placed. */
  chap: Chap | null
  rank: number
  sub: number
  /** Counts as activity for the inactive stretches. */
  active: boolean
}

export interface CallInfo {
  index: number
  purpose: string
  model: string
  prompt: string | null
  effort: string | null
  pages: number[]
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cacheHit: boolean
}

export interface ExtractionInfo {
  docIndex: number
  doc: TimelineDocumentRow
  extractionId: string
  payload: unknown
  startMs: number
  finishedMs: number
  calls: CallInfo[]
}

export interface ExchangeInfo {
  row: TimelineExchangeRow
  startMs: number
  endMs: number
}

export interface Job {
  index: number
  kind: TimelineJob
  /** null: job in progress (has not closed yet). */
  endRow: TimelineAuditRow | null
  endMs: number
  prevEndMs: number
  status: ApplicationStatus
  round: number
  queueStartMs: number
  /** Answered clarification that triggered the resume. */
  resumed: TimelineClarificationRow | null
  /** Clarification this job opened. */
  opened: TimelineClarificationRow | null
  exchanges: ExchangeInfo[]
  extractions: ExtractionInfo[]
  /** Instant at which the decision this job saved is placed. */
  decideAtMs: number | null
}

export const RANK: Record<TimelineEventKind, number> = {
  application_created: 0,
  inbound_message: 1,
  clarification_opened: 2,
  outbound_message: 3,
  queue_wait: 4,
  workflow_step: 5,
  model_call: 6,
  verification: 7,
  decision: 8,
  workflow_suspended: 9,
  clarification_answered: 10,
  job_finished: 11,
  verdict_queued: 12,
  correction: 13,
  analyst_action: 14,
}

// ---------------------------------------------------------------- chapters

/** Chapter factory: each call returns the same object for the same id. */
export function chapterFactory(chapters: Map<string, Chap>) {
  const chapter = (id: string, kind: Chap['kind'], title: string, round = 0): Chap => {
    let c = chapters.get(id)
    if (!c) {
      c = { id, kind, title, round }
      chapters.set(id, c)
    }
    return c
  }
  const n = (x: number): string => String(x)
  return {
    reception: () => chapter('reception', 'reception', 'Recepción'),
    registration: () => chapter('registration', 'registration', 'Registro por WhatsApp'),
    intake: () => chapter('intake', 'intake', 'Datos de la factura'),
    offer: () => chapter('offer', 'offer', 'Oferta del monto'),
    analyst: () => chapter('analyst', 'analyst', 'Revisión del analista'),
    failure: () => chapter('failure', 'failure', 'Falla'),
    extraction: (j: Job) => chapter(`extraction:${n(j.index)}`, 'extraction', 'Extracción', j.round),
    classification: (j: Job) => chapter(`classification:${n(j.index)}`, 'classification', 'Movimientos', j.round),
    decision: (r: number) => chapter(`decision:${n(r)}`, 'decision', `Decisión · ronda ${n(r)}`, r),
    clarification: (r: number) => chapter(`clarification:${n(r)}`, 'clarification', `Aclaración · ronda ${n(r)}`, r),
    resume: (r: number) => chapter(`resume:${n(r)}`, 'resume', `Reanudación · ronda ${n(r)}`, r),
    explanation: (j: Job) => chapter(`explanation:${n(j.index)}`, 'explanation', 'Explicación', j.round),
    verdict: (j: Job | null) => chapter(`verdict:${n(j?.index ?? 0)}`, 'verdict', 'Veredicto', j?.round ?? 0),
    redecide: (j: Job) => chapter(`redecide:${n(j.index)}`, 'redecide', 'Reevaluación', j.round),
  }
}
export type Chapters = ReturnType<typeof chapterFactory>

// ---------------------------------------------------------------- context

export interface Ctx {
  src: TimelineSources
  app: TimelineSources['application']
  drafts: Draft[]
  chapters: Map<string, Chap>
  C: Chapters
  limitations: string[]
  audit: TimelineAuditRow[]
  clarById: Map<string, TimelineClarificationRow>
  clarsSorted: TimelineClarificationRow[]
  inboundById: Map<string, TimelineInboundRow>
  docIndexBySha: Map<string, number>
  extractions: ExtractionInfo[]
  appExchanges: ExchangeInfo[]
  inboundExchanges: ExchangeInfo[]
  jobs: Job[]
  inboundChapters: Map<string, Chap | null>
  callOfExchange: Map<string, CallInfo>
  matchedCalls: Set<CallInfo>
  inferredSteps: number
}

/** Adds an event; the final chapter is set at the end (`chap` null: inherits from the previous). */
export function addEvent<K extends TimelineEventKind>(ctx: Ctx, body: Body<K>, startMs: number, endMs: number | null, chap: Chap | null, opts: { active?: boolean; sub?: number } = {}): void {
  let end = endMs
  if (end !== null && end < startMs) end = startMs
  const event = { ...body, start: iso(startMs), end: end === null ? null : iso(end), chapter: '' } as unknown as TimelineEvent
  ctx.drafts.push({ event, startMs, endMs: end, chap, rank: RANK[body.kind], sub: opts.sub ?? 0, active: opts.active ?? true })
}

export const endOf = (d: Draft): number => d.endMs ?? d.startMs
