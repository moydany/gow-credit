/**
 * Base compartida del constructor del recorrido (ADR 0067): utilidades de lectura defensiva, tipos
 * internos, el contexto que recorren las reglas y el alta de eventos. Ver `timeline-build.ts`.
 */
import type { ApplicationStatus } from './enums.ts'
import type { TimelineChapter, TimelineEvent, TimelineEventKind, TimelineJob } from './timeline.ts'
import type { TimelineAuditRow, TimelineClarificationRow, TimelineDocumentRow, TimelineExchangeRow, TimelineInboundRow, TimelineSources } from './timeline-sources.ts'

/** Tramo sin actividad desde el cual la línea de tiempo lo comprime. */
export const GAP_MS = 60_000
/** Holgura para ligar filas escritas en transacciones distintas del mismo trabajo. */
export const TOL_MS = 1_000
/** Dos filas del analista de la misma jugada (resultado y su bitácora) se tratan como una. */
export const SAME_ACTION_MS = 5_000

/**
 * Qué marca `llm_exchanges.created_at`. El sumidero (`apps/worker/src/llm-exchanges.ts`) guarda
 * `createdAt: new Date(e.at)` y `e.at` es el instante en que EMPEZÓ la llamada (`recording.ts`), así que
 * hoy es el inicio. Si la fila pasa a guardarse al terminar, basta con cambiar esto a `'end'`.
 */
export const EXCHANGE_CREATED_AT_MARKS = 'start' as 'start' | 'end'

// ---------------------------------------------------------------- lectura defensiva

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

/** El valor si es uno de los permitidos; si no, null. */
export function oneOf<T extends string>(x: unknown, values: readonly T[]): T | null {
  return typeof x === 'string' && (values as readonly string[]).includes(x) ? (x as T) : null
}

/** Tramo inferido: sin fin si no tiene duración. */
export const spanEnd = (a: number, b: number | null): number | null => (b !== null && b > a ? b : null)

// ---------------------------------------------------------------- tipos internos

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
  /** null: se toma el capítulo del evento anterior ya ubicado. */
  chap: Chap | null
  rank: number
  sub: number
  /** Cuenta como actividad para los tramos sin actividad. */
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
  /** null: trabajo en curso (no dejó cierre todavía). */
  endRow: TimelineAuditRow | null
  endMs: number
  prevEndMs: number
  status: ApplicationStatus
  round: number
  queueStartMs: number
  /** Aclaración contestada que disparó la reanudación. */
  resumed: TimelineClarificationRow | null
  /** Aclaración que este trabajo abrió. */
  opened: TimelineClarificationRow | null
  exchanges: ExchangeInfo[]
  extractions: ExtractionInfo[]
  /** Instante donde se coloca la decisión que guardó este trabajo. */
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

// ---------------------------------------------------------------- capítulos

/** Fábrica de capítulos: cada llamada devuelve el mismo objeto para el mismo id. */
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

// ---------------------------------------------------------------- contexto

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

/** Alta de un evento; el capítulo definitivo se pone al final (`chap` null: hereda del anterior). */
export function addEvent<K extends TimelineEventKind>(ctx: Ctx, body: Body<K>, startMs: number, endMs: number | null, chap: Chap | null, opts: { active?: boolean; sub?: number } = {}): void {
  let end = endMs
  if (end !== null && end < startMs) end = startMs
  const event = { ...body, start: iso(startMs), end: end === null ? null : iso(end), chapter: '' } as unknown as TimelineEvent
  ctx.drafts.push({ event, startMs, endMs: end, chap, rank: RANK[body.kind], sub: opts.sub ?? 0, active: opts.active ?? true })
}

export const endOf = (d: Draft): number => d.endMs ?? d.startMs
