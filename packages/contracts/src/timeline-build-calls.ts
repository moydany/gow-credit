/**
 * Regla de llamadas al modelo (ADR 0067). Cada fila de `llm_exchanges` es una llamada exacta; la
 * extracción además lista sus llamadas en el payload (con las páginas que leyó). Se emparejan por
 * documento, propósito y latencia. Las del payload sin fila (anteriores a ADR 0064, o del clasificador
 * local) se colocan por inferencia dentro de la ventana de la extracción.
 */
import { addEvent, cut, type Body, type CallInfo, type Chap, type Ctx, type ExchangeInfo, type ExtractionInfo, type Job } from './timeline-build-base.ts'
import { EXPLAIN_PURPOSES, EXTRACTION_PURPOSES, P_CLASSIFY_TX, P_QUESTIONS, PURPOSE_ES, pagesText } from './timeline-build-text.ts'
import type { TimelineExchangeRow } from './timeline-sources.ts'

const SEQUENTIAL_HEAD: ReadonlySet<string> = new Set(['classify', 'summary'])
const PARALLEL: ReadonlySet<string> = new Set(['transactions', 'citations'])
const READS_PAGES: ReadonlySet<string> = new Set(['transactions', 'retry_page'])
const CACHED = ' (de caché)'

const sameLatency = (e: ExchangeInfo, c: CallInfo): boolean => Math.abs(Math.round(e.row.latencyMs) - c.latencyMs) <= 1

/** Empareja las llamadas de un propósito con los intercambios libres: por latencia y modelo, y luego por orden. */
function pairPurpose(ctx: Ctx, calls: CallInfo[], free: ExchangeInfo[]): void {
  const pair = (c: CallInfo, e: ExchangeInfo): void => {
    ctx.callOfExchange.set(e.row.id, c)
    ctx.matchedCalls.add(c)
    free.splice(free.indexOf(e), 1)
  }
  for (const c of calls) {
    const e = free.find((f) => sameLatency(f, c) && f.row.model === c.model) ?? free.find((f) => sameLatency(f, c))
    if (e) pair(c, e)
  }
  for (const c of calls) {
    const e = free[0]
    if (e && !ctx.matchedCalls.has(c)) pair(c, e)
  }
}

function pairExtraction(ctx: Ctx, x: ExtractionInfo): void {
  const cands = ctx.appExchanges.filter((e) => e.row.documentSha256 === x.doc.sha256 && e.row.outcome === 'ok').sort((a, b) => a.endMs - b.endMs || a.row.id.localeCompare(b.row.id))
  for (const purpose of new Set(x.calls.map((c) => c.purpose))) {
    pairPurpose(ctx, x.calls.filter((c) => c.purpose === purpose), cands.filter((e) => e.row.purpose === purpose))
  }
}

/** `purpose` coincide en la fila y en el payload (extract.ts graba lo mismo que pasa a `llm.call`). */
export function pairCalls(ctx: Ctx): void {
  for (const x of ctx.extractions) pairExtraction(ctx, x)
}

/** Capítulo de una llamada según su propósito y el trabajo donde ocurrió; null: hereda. */
function chapterOfPurpose(ctx: Ctx, j: Job, purpose: string): Chap | null {
  if (EXTRACTION_PURPOSES.has(purpose)) return j.kind === 'resume' ? ctx.C.resume(j.round) : ctx.C.extraction(j)
  if (purpose === P_CLASSIFY_TX) return j.kind === 'resume' ? ctx.C.resume(j.round) : ctx.C.classification(j)
  if (purpose === P_QUESTIONS) return ctx.C.clarification(j.opened?.round ?? j.round + 1)
  return EXPLAIN_PURPOSES.has(purpose) ? ctx.C.explanation(j) : null
}

function callLabel(purpose: string, model: string, pages: readonly number[], suffix: string): string {
  const pagesPart = READS_PAGES.has(purpose) ? pagesText(pages) : ''
  return cut(`${PURPOSE_ES[purpose] ?? purpose}${pagesPart} · ${model}${suffix}`)
}

function exchangeSuffix(row: TimelineExchangeRow): string {
  if (row.outcome === 'error') return ' (error)'
  return row.responseCacheHit ? CACHED : ''
}

function exchangeBody(ctx: Ctx, row: TimelineExchangeRow, call: CallInfo | undefined): Body<'model_call'> {
  const pages = call?.pages ?? []
  return {
    id: `llm_exchanges:${row.id}`,
    kind: 'model_call',
    lane: 'models',
    precision: 'exact',
    label: callLabel(row.purpose, row.model, pages, exchangeSuffix(row)),
    source: { table: 'llm_exchanges', id: row.id },
    purpose: row.purpose,
    model: row.model,
    prompt: row.promptVersion || null,
    effort: row.effort || null,
    pages,
    document_index: (row.documentSha256 ? ctx.docIndexBySha.get(row.documentSha256) : undefined) ?? null,
    cache_hit: row.responseCacheHit,
    outcome: row.outcome,
    error_code: row.errorCode,
    cost_usd: Math.max(0, row.costUsd),
    latency_ms: Math.max(0, Math.round(row.latencyMs)),
    input_tokens: Math.max(0, row.usage?.input_tokens ?? 0),
    output_tokens: Math.max(0, row.usage?.output_tokens ?? 0),
    exchange_id: row.id,
  }
}

/** Una llamada exacta por fila de intercambio: las de los trabajos y las del intérprete de mensajes. */
export function emitExchangeCalls(ctx: Ctx): void {
  for (const j of ctx.jobs) {
    for (const e of j.exchanges) addEvent<'model_call'>(ctx, exchangeBody(ctx, e.row, ctx.callOfExchange.get(e.row.id)), e.startMs, e.endMs, chapterOfPurpose(ctx, j, e.row.purpose))
  }
  for (const x of ctx.inboundExchanges) {
    const mid = x.row.inboundMessageId
    addEvent<'model_call'>(ctx, exchangeBody(ctx, x.row, undefined), x.startMs, x.endMs, mid ? (ctx.inboundChapters.get(mid) ?? null) : null)
  }
}

type Placed = [CallInfo, number, number]

/**
 * Coloca llamadas sin fila dentro de [S, F]: resumen y clasificación en secuencia al inicio, los
 * bloques de movimientos en paralelo después y lo demás (relecturas) al final. Con su `latency_ms` como
 * duración, recortada a la ventana.
 */
export function placeInferred(pending: readonly CallInfo[], S: number, F: number): Placed[] {
  const clip = (a: number, b: number): [number, number] => {
    const s = Math.min(Math.max(a, S), F)
    return [s, Math.min(Math.max(b, s), F)]
  }
  const placed: Placed[] = []
  let cur = S
  for (const c of pending.filter((p) => SEQUENTIAL_HEAD.has(p.purpose))) {
    const [s, e] = clip(cur, cur + c.latencyMs)
    placed.push([c, s, e])
    cur = e
  }
  let parEnd = cur
  for (const c of pending.filter((p) => PARALLEL.has(p.purpose))) {
    const [s, e] = clip(cur, cur + c.latencyMs)
    placed.push([c, s, e])
    parEnd = Math.max(parEnd, e)
  }
  cur = parEnd
  for (const c of pending.filter((p) => !SEQUENTIAL_HEAD.has(p.purpose) && !PARALLEL.has(p.purpose))) {
    const [s, e] = clip(cur, cur + c.latencyMs)
    placed.push([c, s, e])
    cur = e
  }
  return placed
}

function inferredBody(x: ExtractionInfo, c: CallInfo): Body<'model_call'> {
  return {
    id: `extractions:${x.extractionId}:call:${String(c.index)}`,
    kind: 'model_call',
    lane: 'models',
    precision: 'inferred',
    label: callLabel(c.purpose, c.model, c.pages, c.cacheHit ? CACHED : ''),
    source: { table: 'extractions', id: x.extractionId },
    purpose: c.purpose,
    model: c.model,
    prompt: c.prompt,
    effort: c.effort,
    pages: c.pages,
    document_index: x.docIndex,
    cache_hit: c.cacheHit,
    outcome: 'ok',
    error_code: null,
    cost_usd: c.costUsd,
    latency_ms: c.latencyMs,
    input_tokens: c.inputTokens,
    output_tokens: c.outputTokens,
    exchange_id: null,
  }
}

/** Llamadas del payload sin intercambio: eventos inferidos y el aviso correspondiente. */
export function emitInferredCalls(ctx: Ctx): void {
  let total = 0
  for (const x of ctx.extractions) {
    const pending = x.calls.filter((c) => !ctx.matchedCalls.has(c))
    if (pending.length === 0) continue
    const job = ctx.jobs.find((j) => j.extractions.includes(x)) ?? null
    const chap = job ? chapterOfPurpose(ctx, job, 'summary') : ctx.C.reception()
    for (const [c, s, e] of placeInferred(pending, x.startMs, x.finishedMs)) {
      total++
      addEvent<'model_call'>(ctx, inferredBody(x, c), s, e, chap)
    }
  }
  if (total > 0) ctx.limitations.push(`${String(total)} llamada(s) al modelo no tienen fila de intercambio (extracción anterior al registro de llamadas, ADR 0064, o clasificador local): se colocaron por inferencia dentro de la ventana de la extracción.`)
}
