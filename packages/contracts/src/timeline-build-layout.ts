/**
 * Journey layout: chapter inheritance, stable ordering, chapters, inactive stretches and totals.
 */
import type { ApplicationStatus } from './enums.ts'
import { endOf, GAP_MS, iso, ms, round6, type Chap, type Ctx, type Draft } from './timeline-build-base.ts'
import type { TimelineChapter, TimelineEvent, TimelineGap } from './timeline.ts'

/** Events without their own chapter take that of the nearest preceding placed event (or receipt). */
export function inheritChapters(ctx: Ctx): void {
  const anchored = ctx.drafts.filter((d) => d.chap !== null).sort((a, b) => a.startMs - b.startMs || a.rank - b.rank)
  for (const d of ctx.drafts) {
    if (d.chap) continue
    let found: Chap | null = null
    for (const a of anchored) {
      if (a.startMs > d.startMs || (a.startMs === d.startMs && a.rank >= d.rank)) break
      found = a.chap
    }
    d.chap = found ?? ctx.C.reception()
  }
}

/** Order by start, then a stable order; unique ids; the chapter ends up on each event. */
export function orderEvents(ctx: Ctx): void {
  ctx.drafts.sort((a, b) => a.startMs - b.startMs || a.rank - b.rank || a.sub - b.sub || a.event.id.localeCompare(b.event.id))
  const seen = new Set<string>()
  for (const d of ctx.drafts) {
    let id = d.event.id
    for (let n = 2; seen.has(id); n++) id = `${d.event.id}#${String(n)}`
    seen.add(id)
    d.event.id = id
    d.event.chapter = (d.chap ?? ctx.C.reception()).id
  }
}

/** Start ties between chapters: the order they happen in (re-evaluation before the verdict it produces). */
const KIND_ORDER: readonly TimelineChapter['kind'][] = ['reception', 'registration', 'intake', 'extraction', 'classification', 'decision', 'clarification', 'resume', 'explanation', 'offer', 'redecide', 'verdict', 'analyst', 'failure']

/** Each chapter is the envelope of its events. */
export function chaptersOf(ctx: Ctx): TimelineChapter[] {
  const list = new Map<string, TimelineChapter>()
  for (const d of ctx.drafts) {
    const c = d.chap
    if (!c) continue
    const existing = list.get(c.id)
    if (!existing) list.set(c.id, { id: c.id, kind: c.kind, title: c.title, round: c.round, start: iso(d.startMs), end: iso(endOf(d)) })
    else if (endOf(d) > Date.parse(existing.end)) existing.end = iso(endOf(d))
  }
  return [...list.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

export function bounds(ctx: Ctx): { startMs: number; endMs: number } {
  const startMs = ctx.drafts.reduce((m, d) => Math.min(m, d.startMs), Number.POSITIVE_INFINITY)
  const endMs = ctx.drafts.reduce((m, d) => Math.max(m, endOf(d)), Number.NEGATIVE_INFINITY)
  return { startMs: Number.isFinite(startMs) ? startMs : ms(ctx.app.createdAt), endMs: Number.isFinite(endMs) ? endMs : ms(ctx.app.updatedAt) }
}

// ---------------------------------------------------------------- inactive stretches

type Hole = [number, number]

/** Gaps over a minute between activity (queue and clarification wait do not count). */
function holesOf(drafts: readonly Draft[], endMs: number): Hole[] {
  const merged: Hole[] = []
  for (const d of [...drafts].filter((x) => x.active).sort((x, y) => x.startMs - y.startMs)) {
    const last = merged.at(-1)
    if (last && d.startMs <= last[1]) last[1] = Math.max(last[1], endOf(d))
    else merged.push([d.startMs, endOf(d)])
  }
  const holes: Hole[] = []
  merged.forEach((m, i) => {
    const next = merged[i + 1]
    if (next && next[0] - m[1] > GAP_MS) holes.push([m[1], next[0]])
  })
  const last = merged.at(-1)
  if (last && endMs - last[1] > GAP_MS) holes.push([last[1], endMs])
  return holes
}

const ASKED_KINDS: readonly string[] = ['question', 'reask', 'invoice', 'registration']
const ANSWERABLE_KINDS: readonly string[] = ['verdict', 'document']

/** Was the last thing before the gap a message to the supplier awaiting a reply? */
function askedSupplier(before: readonly TimelineEvent[], after: readonly TimelineEvent[]): boolean {
  return before.some((e) => {
    if (e.kind !== 'outbound_message') return false
    if (ASKED_KINDS.includes(e.message_kind)) return true
    return ANSWERABLE_KINDS.includes(e.message_kind) && after.some((n) => n.kind === 'inbound_message')
  })
}

function reasonOf(ctx: Ctx, hole: Hole, drafts: readonly Draft[]): TimelineGap['reason'] {
  const [gs, ge] = hole
  const active = drafts.filter((d) => d.active)
  const before = active.filter((d) => endOf(d) === gs).map((d) => d.event)
  const after = active.filter((d) => d.startMs === ge).map((d) => d.event)
  if (ctx.src.clarifications.some((c) => ms(c.createdAt) <= gs && (c.answeredAt === null || ms(c.answeredAt) > gs))) return 'waiting_supplier'
  const queued = drafts.some((d) => d.event.kind === 'queue_wait' && Math.min(ge, endOf(d)) - Math.max(gs, d.startMs) >= (ge - gs) / 2)
  if (queued) return 'waiting_queue'
  if (askedSupplier(before, after)) return 'waiting_supplier'
  const analystNext = after.some((e) => e.lane === 'analyst')
  const trailingReview = after.length === 0 && ctx.app.status === 'human_review'
  if (statusAt(drafts, gs) === 'human_review' && (analystNext || trailingReview)) return 'waiting_analyst'
  return 'idle'
}

/** Request state after the last job closed up to `t`. */
function statusAt(drafts: readonly Draft[], t: number): ApplicationStatus | null {
  let s: ApplicationStatus | null = null
  for (const d of drafts) if (d.startMs <= t && d.event.kind === 'job_finished') s = d.event.application_status
  return s
}

export function gapsOf(ctx: Ctx, endMs: number): { gaps: TimelineGap[]; totalMs: number } {
  const holes = holesOf(ctx.drafts, endMs)
  return {
    gaps: holes.map((h) => ({ start: iso(h[0]), end: iso(h[1]), reason: reasonOf(ctx, h, ctx.drafts) })),
    totalMs: holes.reduce((s, [a, b]) => s + (b - a), 0),
  }
}

export function totalsOf(ctx: Ctx, durationMs: number, gapMs: number) {
  const calls = ctx.drafts.flatMap((d) => (d.event.kind === 'model_call' ? [d.event] : []))
  return {
    duration_ms: Math.round(durationMs),
    active_ms: Math.round(Math.max(0, durationMs - gapMs)),
    model_calls: calls.length,
    cache_hits: calls.filter((c) => c.cache_hit).length,
    cost_usd: round6(calls.reduce((s, c) => s + c.cost_usd, 0)),
  }
}

/** Warnings about what could not be known, only those that apply to this request. */
export function addLimitations(ctx: Ctx): void {
  const { src, jobs, limitations } = ctx
  if (jobs.length > 0) limitations.push('Los reintentos de la cola no quedan en el esquema app: solo se ve el resultado de cada trabajo.')
  if (ctx.inferredSteps > 0) limitations.push('Los pasos decide, re-decide, apply-answers y finalize no dejan hora propia: se colocaron por inferencia entre los eventos que sí la tienen.')
  if (src.decisions.length > 0) limitations.push('La hora guardada de cada decisión es la del cierre del trabajo: se colocó al inicio del paso de decisión.')
  if (src.outbound.some((o) => o.clarificationId === null)) limitations.push('Los mensajes salientes sin aclaración (avisos, registro, oferta) se ligan a la solicitud por el instante de su transacción.')
  if (jobs.some((j) => j.endRow === null)) limitations.push('Hay un trabajo en curso: todavía no deja la fila que lo cierra.')
}
