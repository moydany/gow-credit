/**
 * Estado declarativo de la escena 3D en un instante `t` (ms desde epoch). Función pura de
 * (recorrido, t): no importa three ni toca el DOM, así que retroceder y adelantar es calcular otra vez.
 * `scene.ts` aplica este estado a objetos de three que se reutilizan.
 */
import type { ApplicationStatus, ApplicationTimeline, DecisionStatus, TimelineEvent } from '@gow/contracts'

export type StationId =
  | 'chat'
  | 'relay'
  | 'queue'
  | 'extract'
  | 'classify-transactions'
  | 'decide'
  | 'ask-owner'
  | 'explain'
  | 'verdict_ok'
  | 'verdict_review'
  | 'verdict_no'
  | 'analyst'

export type PageVerification = 'pending' | 'verified' | 'unverified' | 'conflict' | 'none'
export type GateColor = 'pass' | 'unknown' | 'clarify' | 'review' | 'reject' | 'fail'

export interface Beam {
  eventId: string
  model: string
  /** Páginas que lee; vacío: el haz va a una estación. */
  pages: { document: number; page: number }[]
  station: StationId | null
  /** 0..1: cuánto del haz se ha extendido. */
  progress: number
  kind: 'ok' | 'error'
  /** Ya terminó la llamada y el haz se está apagando. */
  fading: boolean
}

export interface Flash {
  eventId: string
  model: string
  /** 1 al inicio, 0 al apagarse. */
  strength: number
}

export interface Capsule {
  eventId: string
  direction: 'in' | 'out'
  path: StationId[]
  progress: number
  message: string
  failed: boolean
}

export interface PageState {
  document: number
  page: number
  verification: PageVerification
  /** Alguna llamada la está leyendo ahora. */
  reading: boolean
  issues: boolean
}

export interface GateState {
  id: string
  color: GateColor
}

export interface SceneState {
  t: number
  token: { station: StationId; floating: boolean; status: ApplicationStatus; eventId: string | null }
  ghost: { status: DecisionStatus; eventId: string } | null
  beams: Beam[]
  flashes: Flash[]
  capsules: Capsule[]
  relayGlow: number
  pages: PageState[]
  gates: GateState[]
  dimensions: { id: string; value: number; used: boolean }[]
  models: { model: string; active: boolean }[]
  analyst: { level: number; active: boolean; eventId: string | null }
  /** Evento más reciente que ya empezó (el que el panel sigue al reproducir). */
  activeEventId: string | null
  chapterId: string | null
}

/** Lo que la escena necesita construir una sola vez (cambia solo si cambia la estructura). */
export interface SceneLayout {
  documents: { index: number; pages: number[] }[]
  models: string[]
  gates: string[]
  dimensions: { id: string; weight: number }[]
}

export type ScenePick = { type: 'page'; document: number; page: number } | { type: 'orb'; model: string } | { type: 'gate'; id: string } | { type: 'token' } | { type: 'analyst' } | { type: 'station'; station: StationId }

export interface SceneOptions {
  /** Cuánto se queda visible lo instantáneo (cápsulas, destellos, haces ya terminados), en ms reales. */
  lingerMs?: number
}
export const DEFAULT_LINGER_MS = 1500

type Ev = TimelineEvent & { s: number; e: number | null }
type Of<K extends TimelineEvent['kind']> = Extract<TimelineEvent, { kind: K }>
interface Prepared {
  events: Ev[]
  chapters: { id: string; s: number; e: number }[]
}
const cache = new WeakMap<ApplicationTimeline, Prepared>()

function prepare(tl: ApplicationTimeline): Prepared {
  const hit = cache.get(tl)
  if (hit) return hit
  const events: Ev[] = tl.events.map((ev) => ({ ...ev, s: Date.parse(ev.start), e: ev.end ? Date.parse(ev.end) : null }))
  const p: Prepared = { events, chapters: tl.chapters.map((c) => ({ id: c.id, s: Date.parse(c.start), e: Date.parse(c.end) })) }
  cache.set(tl, p)
  return p
}

export function sceneLayout(tl: ApplicationTimeline): SceneLayout {
  const models: string[] = []
  const gates: string[] = []
  const dims = new Map<string, number>()
  for (const ev of tl.events) {
    if (ev.kind === 'model_call' && !models.includes(ev.model)) models.push(ev.model)
    if (ev.kind === 'decision') collectDecision(ev, gates, dims)
  }
  return {
    documents: tl.documents.map((d, index) => ({ index, pages: d.pages.map((p) => p.page) })),
    models,
    gates,
    dimensions: [...dims].map(([id, weight]) => ({ id, weight })),
  }
}

function collectDecision(ev: Of<'decision'>, gates: string[], dims: Map<string, number>): void {
  for (const g of ev.gates) if (!gates.includes(g.id)) gates.push(g.id)
  for (const d of ev.dimensions) if (!dims.has(d.id)) dims.set(d.id, d.weight)
}

const STEP_STATION: Record<string, StationId> = {
  extract: 'extract',
  'classify-transactions': 'classify-transactions',
  decide: 'decide',
  'apply-answers': 'ask-owner',
  're-decide': 'decide',
  'ask-owner': 'ask-owner',
  explain: 'explain',
}

const VERDICT_STATION: Partial<Record<ApplicationStatus | DecisionStatus, StationId>> = {
  qualified: 'verdict_ok',
  qualified_with_limit: 'verdict_ok',
  human_review: 'verdict_review',
  not_qualified: 'verdict_no',
  failed: 'verdict_no',
}
const verdictStation = (status: ApplicationStatus | DecisionStatus | null): StationId | null => (status ? (VERDICT_STATION[status] ?? null) : null)

/** A dónde mira cada propósito de modelo cuando no lee páginas. */
export function purposeStation(purpose: string, fallback: StationId): StationId {
  if (purpose.startsWith('classify_transactions')) return 'classify-transactions'
  if (purpose === 'write_questions') return 'ask-owner'
  if (purpose === 'explain') return 'explain'
  if (purpose === 'interpret_reply') return 'relay'
  return fallback
}

const GATE_EFFECT_COLOR: Record<string, GateColor> = { needs_clarification: 'clarify', human_review: 'review', not_qualified: 'reject' }
function gateColor(g: { outcome: 'pass' | 'fail' | 'unknown'; effect: string }): GateColor {
  if (g.outcome === 'pass') return 'pass'
  return GATE_EFFECT_COLOR[g.effect] ?? (g.outcome === 'unknown' ? 'unknown' : 'fail')
}

const isFinal = (s: ApplicationStatus): boolean => s === 'qualified' || s === 'qualified_with_limit' || s === 'not_qualified' || s === 'failed'

const STEP_STATUS: Record<string, ApplicationStatus> = {
  extract: 'extracting',
  'classify-transactions': 'extracted',
  decide: 'deciding',
  'apply-answers': 'deciding',
  're-decide': 'deciding',
  'ask-owner': 'needs_clarification',
  explain: 'deciding',
}

/** Lo que se va acumulando al recorrer los eventos hasta `t`. */
interface Acc {
  t: number
  linger: number
  station: StationId
  floating: boolean
  status: ApplicationStatus
  tokenEvent: string | null
  activeEventId: string | null
  lastDecisionStatus: DecisionStatus | null
  lastActiveDecision: Of<'decision'> | null
  ghost: SceneState['ghost']
  analystLevel: number
  analystEvent: string | null
  verification: Map<number, Of<'verification'>>
  beams: Beam[]
  flashes: Flash[]
  capsules: Capsule[]
  activeModels: Set<string>
  reading: Set<string>
}
type EvOf<K extends TimelineEvent['kind']> = Extract<Ev, { kind: K }>
type Handlers = { [K in TimelineEvent['kind']]?: (a: Acc, ev: EvOf<K>) => void }

const spanEnd = (ev: Ev): number => ev.e ?? ev.s
const inFlight = (a: Acc, ev: Ev): number => Math.max(spanEnd(ev) - ev.s, a.linger)

function onInbound(a: Acc, ev: EvOf<'inbound_message'>): void {
  // La cápsula sube al buzón y luego baja a la cola; la ficha se queda en el relay hasta que algo la mueva.
  if (!a.floating && !isFinal(a.status)) a.station = 'relay'
  a.tokenEvent = ev.id
  const dur = inFlight(a, ev)
  if (a.t <= ev.s + dur) a.capsules.push({ eventId: ev.id, direction: 'in', path: ['chat', 'relay', 'queue'], progress: (a.t - ev.s) / dur, message: ev.has_document ? 'document' : (ev.media_kind ?? 'text'), failed: false })
}

function onOutbound(a: Acc, ev: EvOf<'outbound_message'>): void {
  const dur = inFlight(a, ev)
  const from: StationId = a.station === 'chat' || a.station === 'relay' || a.station === 'queue' ? 'decide' : a.station
  if (a.t <= ev.s + dur) a.capsules.push({ eventId: ev.id, direction: 'out', path: [from, 'relay', 'chat'], progress: (a.t - ev.s) / dur, message: ev.message_kind, failed: ev.delivery === 'failed' })
}

function onStep(a: Acc, ev: EvOf<'workflow_step'>): void {
  a.floating = false
  const target = STEP_STATION[ev.step]
  if (target) a.station = target
  else if (ev.step === 'finalize') a.station = verdictStation(a.lastDecisionStatus) ?? a.station
  const st = STEP_STATUS[ev.step]
  if (st) a.status = st
  a.tokenEvent = ev.id
}

function onModelCall(a: Acc, ev: EvOf<'model_call'>): void {
  if (ev.cache_hit) {
    if (a.t <= ev.s + a.linger) a.flashes.push({ eventId: ev.id, model: ev.model, strength: 1 - (a.t - ev.s) / a.linger })
    return
  }
  const doc = ev.document_index
  const pageRefs = doc === null ? [] : ev.pages.map((page) => ({ document: doc, page }))
  const end = spanEnd(ev)
  const running = a.t < end
  if (!running && a.t > end + a.linger * 0.6) return
  a.beams.push({
    eventId: ev.id,
    model: ev.model,
    pages: pageRefs,
    station: pageRefs.length ? null : purposeStation(ev.purpose, a.station),
    progress: Math.min(1, Math.max(0.12, (a.t - ev.s) / Math.max(end - ev.s, 1))),
    kind: ev.outcome === 'error' ? 'error' : 'ok',
    fading: !running,
  })
  a.activeModels.add(ev.model)
  if (running) for (const r of pageRefs) a.reading.add(`${String(r.document)}:${String(r.page)}`)
}

function onDecision(a: Acc, ev: EvOf<'decision'>): void {
  if (ev.decision_kind === 'shadow') {
    if (a.t <= Math.max(spanEnd(ev), ev.s + a.linger)) a.ghost = { status: ev.status, eventId: ev.id }
    return
  }
  a.lastActiveDecision = ev
  a.lastDecisionStatus = ev.status
  if (!a.floating) a.station = 'decide'
  a.tokenEvent = ev.id
  a.status = ev.status
}

function onVerdictQueued(a: Acc, ev: EvOf<'verdict_queued'>): void {
  a.status = ev.application_status
  if (!a.floating) a.station = verdictStation(ev.application_status) ?? a.station
  a.tokenEvent = ev.id
}

function onJobFinished(a: Acc, ev: EvOf<'job_finished'>): void {
  a.status = ev.application_status
  const v = verdictStation(ev.application_status)
  if (!a.floating && v) a.station = v
  a.tokenEvent = ev.id
}

const mark = (station: StationId | null, extra?: (a: Acc) => void) => (a: Acc, ev: Ev) => {
  if (station) a.station = station
  extra?.(a)
  a.tokenEvent = ev.id
}

const HANDLERS: Handlers = {
  application_created: (a, ev) => { a.station = ev.origin === 'whatsapp' ? 'relay' : 'queue'; a.tokenEvent = ev.id },
  inbound_message: onInbound,
  outbound_message: onOutbound,
  queue_wait: (a, ev) => { mark('queue', (x) => { x.floating = false })(a, ev) },
  job_finished: onJobFinished,
  workflow_step: onStep,
  workflow_suspended: (a, ev) => { mark('chat', (x) => { x.floating = true; x.status = 'needs_clarification' })(a, ev) },
  model_call: onModelCall,
  verification: (a, ev) => { a.verification.set(ev.document_index, ev); a.tokenEvent = a.tokenEvent ?? ev.id },
  decision: onDecision,
  clarification_opened: (a, ev) => { if (!a.floating) a.station = 'ask-owner'; a.status = 'needs_clarification'; a.tokenEvent = ev.id },
  clarification_answered: (a, ev) => { a.tokenEvent = ev.id },
  verdict_queued: onVerdictQueued,
  correction: (a, ev) => { a.analystLevel += 1; a.analystEvent = ev.id },
  analyst_action: (a, ev) => { a.analystLevel += 1; a.analystEvent = ev.id },
}

function accumulate(events: Ev[], t: number, linger: number): Acc {
  const a: Acc = {
    t, linger, station: 'chat', floating: false, status: 'received', tokenEvent: null, activeEventId: null, lastDecisionStatus: null, lastActiveDecision: null, ghost: null,
    analystLevel: 0, analystEvent: null, verification: new Map(), beams: [], flashes: [], capsules: [], activeModels: new Set(), reading: new Set(),
  }
  for (const ev of events) {
    if (ev.s > t) break
    a.activeEventId = ev.id
    ;(HANDLERS[ev.kind] as ((acc: Acc, e: Ev) => void) | undefined)?.(a, ev)
  }
  return a
}

function pageStates(tl: ApplicationTimeline, a: Acc): PageState[] {
  return tl.documents.flatMap((doc, di) => {
    const v = a.verification.get(di)
    return doc.pages.map((p) => ({
      document: di,
      page: p.page,
      verification: v ? p.verification : ('pending' as const),
      reading: a.reading.has(`${String(di)}:${String(p.page)}`),
      issues: Boolean(v?.pages_with_issues.includes(p.page)),
    }))
  })
}

export function sceneStateAt(tl: ApplicationTimeline, t: number, opts: SceneOptions = {}): SceneState {
  const linger = Math.max(opts.lingerMs ?? DEFAULT_LINGER_MS, 1)
  const { events, chapters } = prepare(tl)
  const layout = sceneLayout(tl)
  const a = accumulate(events, t, linger)
  const decision = a.lastActiveDecision

  const lastAnalyst = a.analystEvent ? events.find((e) => e.id === a.analystEvent) : undefined
  // Activa solo mientras el último movimiento del analista sigue vigente.
  const analystActive = lastAnalyst ? t <= Math.max(spanEnd(lastAnalyst), lastAnalyst.s + linger) : false
  const chapter = [...chapters].reverse().find((c) => c.s <= t) ?? chapters[0] ?? null

  return {
    t,
    token: { station: a.station, floating: a.floating, status: a.status, eventId: a.tokenEvent },
    ghost: a.ghost,
    beams: a.beams,
    flashes: a.flashes,
    capsules: a.capsules,
    relayGlow: a.capsules.reduce((m, c) => Math.max(m, Math.sin(Math.PI * Math.min(Math.max(c.progress, 0), 1))), 0),
    pages: pageStates(tl, a),
    gates: layout.gates.map((id) => {
      const g = decision?.gates.find((x) => x.id === id)
      return { id, color: g ? gateColor(g) : 'unknown' }
    }),
    dimensions: layout.dimensions.map((d) => {
      const x = decision?.dimensions.find((q) => q.id === d.id)
      return { id: d.id, value: x?.normalized ?? 0, used: x?.used ?? false }
    }),
    models: layout.models.map((model) => ({ model, active: a.activeModels.has(model) })),
    analyst: { level: a.analystLevel, active: analystActive, eventId: a.analystEvent },
    activeEventId: a.activeEventId,
    chapterId: chapter?.id ?? null,
  }
}

/** El evento al que lleva un clic en la escena (null si no hay uno relacionado). */
export function eventForPick(tl: ApplicationTimeline, t: number, pick: ScenePick): TimelineEvent | null {
  const { events } = prepare(tl)
  const latest = <T extends Ev>(list: T[]): T | null => {
    const upTo = list.filter((e) => e.s <= t)
    return upTo[upTo.length - 1] ?? list[0] ?? null
  }
  switch (pick.type) {
    case 'page': {
      const v = events.filter((e): e is Ev & { kind: 'verification' } => e.kind === 'verification' && e.document_index === pick.document)
      const calls = events.filter((e): e is Ev & { kind: 'model_call' } => e.kind === 'model_call' && e.document_index === pick.document && e.pages.includes(pick.page))
      const seen = latest(v)
      if (seen && seen.s <= t) return seen
      return latest(calls) ?? seen
    }
    case 'orb':
      return latest(events.filter((e): e is Ev & { kind: 'model_call' } => e.kind === 'model_call' && e.model === pick.model))
    case 'gate':
      return latest(events.filter((e): e is Ev & { kind: 'decision' } => e.kind === 'decision' && e.decision_kind === 'active' && e.gates.some((g) => g.id === pick.id)))
    case 'token': {
      const s = sceneStateAt(tl, t)
      return events.find((e) => e.id === (s.token.eventId ?? s.activeEventId)) ?? null
    }
    case 'analyst':
      return latest(events.filter((e) => e.lane === 'analyst'))
    case 'station': {
      const stepFor = (st: StationId) => (e: Ev) => e.kind === 'workflow_step' && STEP_STATION[e.step] === st
      if (pick.station === 'queue') return latest(events.filter((e) => e.kind === 'queue_wait'))
      return latest(events.filter(stepFor(pick.station)))
    }
  }
}
