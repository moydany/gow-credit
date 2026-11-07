/**
 * Applies a policy to a profile and returns status, score, band, limit and reasons.
 * Pure: same profile and policy, same result.
 *
 * Status precedence:
 *   1. Gates: not_qualified > human_review > needs_clarification. While a gate asks for missing
 *      pages, the integrity gate waits for the full document (ADR 0058).
 *   2. If a doubtful feature (unverified, conflicting, low confidence) could change the band,
 *      don't decide with it: ask the supplier, or send it to human review (docs/04 §5).
 *   3. Band from the score, lowered by caps.
 *   4. Limit from `limitFormula`; zero or less means not qualified.
 *   5. With no clarification rounds left, needs_clarification becomes human_review.
 */
import {
  FINAL_STATUS_RANK,
  formatLimitTerm,
  parseLimitFormula,
  type AskTopic,
  type Band,
  type CapEvaluation,
  type DecisionStatus,
  type DimensionEvaluation,
  type FeatureName,
  type FinalDecisionStatus,
  type GateEvaluation,
  type LimitTerm,
  type Policy,
  type Profile,
} from '@gow/contracts'
import type { z } from 'zod'
import type { LimitEvaluation, Reason } from '@gow/contracts'
import { clamp01, floor2, round2, round4 } from '../util/num.ts'
import { checkCondition, readFeature, type ExclusionReason } from './conditions.ts'
import { ASK_TEXT, codeOf, EXCLUSION_TEXT, fmt, STATUS_TEXT } from './messages.ts'

type GateEval = z.infer<typeof GateEvaluation>
type DimensionEval = z.infer<typeof DimensionEvaluation>
type CapEval = z.infer<typeof CapEvaluation>
type LimitEval = z.infer<typeof LimitEvaluation>
export type ReasonOut = z.infer<typeof Reason>

/** Status order, used to compare results. */
export const DECISION_STATUS_RANK: Readonly<Record<DecisionStatus, number>> = {
  qualified: 4,
  qualified_with_limit: 3,
  needs_clarification: 2,
  human_review: 1,
  not_qualified: 0,
}

/**
 * What we can ask the supplier when a feature isn't enough to decide. Income features are cleared
 * by asking about deposits, debt service by asking about charges (ADR 0050).
 */
export const FEATURE_ASK: Readonly<Partial<Record<FeatureName, AskTopic>>> = {
  operating_income_monthly: 'deposit_classification',
  free_cash_flow_monthly: 'deposit_classification',
  payment_capacity_pct: 'deposit_classification',
  debt_capacity: 'deposit_classification',
  debt_service_monthly: 'charge_classification',
  new_debt_in_period: 'deposit_classification',
  external_debt_signal: 'deposit_classification',
  income_trend: 'deposit_classification',
  buyer_payments_count: 'deposit_classification',
  buyer_payments_amount: 'deposit_classification',
  recurring_income_share: 'deposit_classification',
  top_payer_concentration: 'deposit_classification',
  income_from_listed_rfc_share: 'deposit_classification',
  regime_income_plausible: 'deposit_classification',
  identity_match: 'identity_fields',
  document_age_days: 'recent_statement',
  months_of_history: 'additional_months',
}

/** Features the supplier can confirm even if extraction left them unverified. */
const OWNER_VERIFIABLE: ReadonlySet<FeatureName> = new Set(['identity_match', 'document_age_days', 'months_of_history'])

/**
 * Can we ask the supplier? Low classification confidence yes (they know where a deposit came from).
 * An unverified value no, except identity and dates, which a person checks against the page.
 */
export function topicFor(feature: FeatureName, exclusion: ExclusionReason): AskTopic | null {
  const topic = FEATURE_ASK[feature] ?? null
  if (topic === null || exclusion === 'unknown') return null
  if (exclusion === 'low_confidence') return topic
  return OWNER_VERIFIABLE.has(feature) ? topic : null
}

export interface Uncertain {
  feature: FeatureName
  exclusion: Exclude<ExclusionReason, 'unknown'>
  topic: AskTopic | null
  where: string
}

interface GateEffect {
  id: string
  feature: FeatureName
  status: 'needs_clarification' | 'human_review' | 'not_qualified'
  ask: AskTopic | null
}

interface Scored {
  dimensions: DimensionEval[]
  score: number
  bandIndex: number
  caps: CapEval[]
  finalStatus: FinalDecisionStatus
  limitBandIndex: number | null
  uncertain: Uncertain[]
}

export interface Core {
  status: DecisionStatus
  score: number
  bandIndex: number
  gates: GateEval[]
  dimensions: DimensionEval[]
  caps: CapEval[]
  limitEvaluation: LimitEval | null
  limit: number | null
  topics: AskTopic[]
  reasons: ReasonOut[]
}

export interface CoreOptions {
  clarificationRoundsUsed: number
}

/**
 * Missing pages break the balance for the same reason: the document is incomplete (ADR 0058).
 * While a gate asks for the pages, an `integrity_ok` gate that would go to human review waits.
 * If the full PDF still doesn't balance, the gate fails again. Older policies are unaffected.
 */
function deferIntegrityToMissingPages(evals: GateEval[], effects: GateEffect[]): string[] {
  if (!evals.some((e) => e.effect === 'needs_clarification' && e.ask === 'missing_pages')) return []
  const deferred = evals.filter((e) => e.feature === 'integrity_ok' && e.effect === 'human_review')
  for (const e of deferred) e.effect = 'none'
  const ids = new Set(deferred.map((e) => e.id))
  effects.splice(0, effects.length, ...effects.filter((e) => !ids.has(e.id)))
  return [...ids]
}

type GateResult = Pick<GateEval, 'outcome' | 'effect' | 'ask'>

function gateResult(g: Policy['gates'][number], f: ReturnType<typeof readFeature>): GateResult {
  if (f.exclusion === 'unknown') {
    const ask = g.onFail.ask ?? null
    switch (g.onUnknown) {
      case 'pass':
        return { outcome: 'unknown', effect: 'none', ask: null }
      case 'fail':
        return { outcome: 'unknown', effect: g.onFail.status, ask }
      case 'ask':
        return { outcome: 'unknown', effect: 'needs_clarification', ask }
      case 'human_review':
        return { outcome: 'unknown', effect: 'human_review', ask: null }
    }
  }
  if (f.exclusion !== null) {
    // An unverified value neither passes nor fails a gate.
    const ask = g.onFail.ask ?? topicFor(g.when.feature, f.exclusion)
    return { outcome: 'unknown', effect: ask !== null ? 'needs_clarification' : 'human_review', ask }
  }
  if (checkCondition(g.when, f.value)) return { outcome: 'pass', effect: 'none', ask: null }
  return { outcome: 'fail', effect: g.onFail.status, ask: g.onFail.ask ?? null }
}

function evaluateGates(policy: Policy, profile: Profile): { evals: GateEval[]; effects: GateEffect[]; deferred: string[] } {
  const evals: GateEval[] = []
  const effects: GateEffect[] = []
  for (const g of policy.gates) {
    const f = readFeature(profile, g.when.feature)
    const { outcome, effect, ask } = gateResult(g, f)
    evals.push({ id: g.id, feature: g.when.feature, op: g.when.op, threshold: (g.when.value ?? null), value: f.value as GateEval['value'], outcome, effect, ask })
    if (effect !== 'none') effects.push({ id: g.id, feature: g.when.feature, status: effect, ask })
  }
  return { evals, effects, deferred: deferIntegrityToMissingPages(evals, effects) }
}

function minStatus(a: FinalDecisionStatus, b: FinalDecisionStatus): FinalDecisionStatus {
  return FINAL_STATUS_RANK[b] < FINAL_STATUS_RANK[a] ? b : a
}

type DimensionDef = Policy['score']['dimensions'][number]

/** A dimension's value (divided by `relativeTo` when set) and why it can't be used, if it can't. */
function readDimension(d: DimensionDef, profile: Profile, minConf: number) {
  const f = readFeature(profile, d.feature, minConf)
  const r = d.relativeTo !== undefined ? readFeature(profile, d.relativeTo, minConf) : null
  let exclusion: ExclusionReason | null = f.exclusion ?? r?.exclusion ?? null
  const excludedFeature: FeatureName = f.exclusion !== null ? d.feature : (d.relativeTo ?? d.feature)
  let raw = typeof f.value === 'number' ? f.value : null
  if (r !== null) {
    const rv = typeof r.value === 'number' ? r.value : null
    if (raw !== null && rv !== null && rv > 0) raw = raw / rv
    else {
      raw = null
      exclusion ??= 'unknown'
    }
  }
  return { value: raw === null ? null : round4(raw), exclusion, excludedFeature }
}

function scoreDimension(d: DimensionDef, profile: Profile, minConf: number, optimistic: boolean, uncertain: Uncertain[]): DimensionEval {
  const { value, exclusion, excludedFeature } = readDimension(d, profile, minConf)
  const base = { id: d.id, feature: d.feature, relative_to: d.relativeTo ?? null, value, weight: d.weight }
  if (exclusion !== null || value === null) {
    const reason = exclusion ?? 'unknown'
    if (reason !== 'unknown') uncertain.push({ feature: excludedFeature, exclusion: reason, topic: topicFor(excludedFeature, reason), where: `dimension:${d.id}` })
    const full = optimistic && reason !== 'unknown'
    return { ...base, normalized: full ? 1 : null, points: full ? d.weight : 0, used: false, excluded_reason: reason }
  }
  const normalized = round4(clamp01((value - d.zeroAt) / (d.fullAt - d.zeroAt)))
  return { ...base, normalized, points: round4(d.weight * normalized), used: true, excluded_reason: null }
}

function evaluateCap(c: Policy['decision']['caps'][number], index: number, profile: Profile, optimistic: boolean, uncertain: Uncertain[]): CapEval {
  const f = readFeature(profile, c.when.feature)
  let applied: boolean
  if (f.exclusion === 'unknown') applied = true // no data: apply the cap to be safe
  else if (f.exclusion !== null) {
    uncertain.push({ feature: c.when.feature, exclusion: f.exclusion, topic: topicFor(c.when.feature, f.exclusion), where: `cap:${String(index)}` })
    applied = !optimistic
  } else applied = checkCondition(c.when, f.value)
  return { index, feature: c.when.feature, applied, max_status: c.maxStatus }
}

/**
 * Score, band and caps. With `optimistic`, dimensions excluded for doubt (not for missing data)
 * get full points and caps on doubtful data don't apply: the best case docs/04 §5 allows.
 */
function scoreProfile(policy: Policy, profile: Profile, optimistic: boolean): Scored {
  const uncertain: Uncertain[] = []
  const dimensions = policy.score.dimensions.map((d) => scoreDimension(d, profile, policy.score.minConfidence, optimistic, uncertain))
  const score = round2(dimensions.reduce((s, d) => s + d.points, 0))
  const bands = policy.decision.bands
  const bandIndex = Math.max(
    0,
    bands.findIndex((b) => score >= b.min),
  )
  const band = bands[bandIndex] as Band

  const caps = policy.decision.caps.map((c, index) => evaluateCap(c, index, profile, optimistic, uncertain))
  let finalStatus: FinalDecisionStatus = band.status
  for (const c of caps) if (c.applied) finalStatus = minStatus(finalStatus, c.max_status)

  // The limit comes from the band of the final status: the first band with that status after a
  // cap, or the score's band if the policy has none.
  let limitBandIndex: number | null = null
  if (finalStatus !== 'not_qualified') {
    const same = bands.findIndex((b) => b.status === finalStatus)
    limitBandIndex = band.status === finalStatus || same < 0 ? bandIndex : same
  }
  return { dimensions, score, bandIndex, caps, finalStatus, limitBandIndex, uncertain }
}

interface LimitResult {
  evaluation: LimitEval
  value: number | null
  binding: LimitTerm | null
  bandExclusion: { feature: FeatureName; exclusion: ExclusionReason } | null
  assumedZero: FeatureName[]
}

function numberOf(profile: Profile, f: FeatureName): number | null {
  const v = profile.features[f].value
  return typeof v === 'number' ? v : null
}

interface TermRead {
  value: number | null
  bandExclusion?: NonNullable<LimitResult['bandExclusion']>
  assumedZero?: FeatureName
}

function readTerm(term: LimitTerm, policy: Policy, profile: Profile, band: Band): TermRead {
  switch (term.type) {
    case 'band': {
      const lim = band.limit
      if (!lim) return { value: null }
      const f = readFeature(profile, lim.pctOf, policy.score.minConfidence)
      if (f.exclusion !== null) return { value: null, bandExclusion: { feature: lim.pctOf, exclusion: f.exclusion } }
      return { value: typeof f.value === 'number' ? round2((f.value * lim.pct) / 100) : null }
    }
    case 'feature':
      return { value: numberOf(profile, term.feature) }
    case 'difference': {
      const a = numberOf(profile, term.minuend)
      const b = numberOf(profile, term.subtrahend)
      return { value: a === null ? null : round2(a - (b ?? 0)), ...(a !== null && b === null ? { assumedZero: term.subtrahend } : {}) }
    }
  }
}

/**
 * `limitFormula`: the minimum of the known terms, never negative. Unknown feature terms are
 * skipped. An unknown subtrahend counts as 0 and is reported. The `band` term needs its
 * feature verified, since it sets the amount.
 */
function computeLimit(policy: Policy, profile: Profile, band: Band): LimitResult {
  const parsed = parseLimitFormula(policy.decision.limitFormula)
  if (!parsed.ok) throw new Error(`limitFormula inválida en una política ya validada: ${parsed.error}`)
  const terms: { term: LimitTerm; value: number | null }[] = []
  let bandExclusion: LimitResult['bandExclusion'] = null
  const assumedZero: FeatureName[] = []
  for (const term of parsed.formula.terms) {
    const read = readTerm(term, policy, profile, band)
    terms.push({ term, value: read.value })
    if (read.bandExclusion) bandExclusion = read.bandExclusion
    if (read.assumedZero) assumedZero.push(read.assumedZero)
  }
  const known = terms.filter((t): t is { term: LimitTerm; value: number } => t.value !== null)
  const min = known.length === 0 ? null : known.reduce((a, b) => (b.value < a.value ? b : a))
  const value = bandExclusion !== null || min === null ? null : floor2(Math.max(0, min.value))
  return {
    evaluation: { formula: policy.decision.limitFormula, terms: terms.map((t) => ({ term: formatLimitTerm(t.term), value: t.value })), value },
    value,
    binding: min?.term ?? null,
    bandExclusion,
    assumedZero,
  }
}

/** A dimension scoring less than this share of its weight gets a reason. */
const LOW_DIMENSION = 0.5

function worstGate(effects: readonly GateEffect[]): GateEffect['status'] | null {
  if (effects.some((e) => e.status === 'not_qualified')) return 'not_qualified'
  if (effects.some((e) => e.status === 'human_review')) return 'human_review'
  if (effects.some((e) => e.status === 'needs_clarification')) return 'needs_clarification'
  return null
}

/** Why a gate acts: it failed its condition, or its data is unusable. */
function gateHow(profile: Profile, feature: FeatureName, g: GateEval | undefined): string {
  if (g?.outcome === 'fail') return `${feature} = ${fmt(g.value)} no cumple ${g.op} ${fmt(g.threshold)}`
  return `${feature}: ${EXCLUSION_TEXT[readFeature(profile, feature).exclusion ?? 'unknown']}`
}

function gateReasons(profile: Profile, gates: ReturnType<typeof evaluateGates>): ReasonOut[] {
  const reasons: ReasonOut[] = []
  for (const e of gates.effects) {
    const g = gates.evals.find((x) => x.id === e.id)
    reasons.push({
      code: g?.outcome === 'fail' ? codeOf('gate', e.id) : codeOf('gate', e.id, 'unknown'),
      message: `Compuerta "${e.id}": ${gateHow(profile, e.feature, g)} → ${STATUS_TEXT[e.status]}${e.ask ? ` (pedir ${ASK_TEXT[e.ask]})` : ''}.`,
      features: [e.feature],
    })
  }
  for (const g of gates.evals.filter((x) => gates.deferred.includes(x.id))) {
    reasons.push({
      code: codeOf('gate', g.id, 'deferred'),
      message: `Compuerta "${g.id}": ${gateHow(profile, g.feature, g)}, pero al documento le faltan páginas: primero se pide ${ASK_TEXT.missing_pages} y, si con el documento completo sigue sin cuadrar, pasa a revisión humana.`,
      features: [g.feature],
    })
  }
  return reasons
}

const dimensionFeatures = (d: DimensionEval): FeatureName[] => (d.relative_to ? [d.feature, d.relative_to] : [d.feature])

/** Dimensions that add no points: no data, or doubtful data (ADR 0045). */
function unusedDimensionReasons(policy: Policy, profile: Profile, scored: Scored): ReasonOut[] {
  const reasons: ReasonOut[] = []
  for (const d of scored.dimensions) {
    if (d.used) continue
    const reason = d.excluded_reason ?? 'unknown'
    // The missing feature is the dimension's own, or the one it's compared against.
    const missing = readFeature(profile, d.feature, policy.score.minConfidence).exclusion !== null || d.relative_to === null ? d.feature : d.relative_to
    reasons.push({
      code: codeOf('dimension', d.id, reason === 'unknown' ? 'without_data' : reason),
      message: `La dimensión "${d.id}" no suma puntos: ${reason === 'unknown' ? `sin dato de ${missing}` : `${missing}: ${EXCLUSION_TEXT[reason]}`}.`,
      features: dimensionFeatures(d),
    })
  }
  return reasons
}

/** Dimensions with data that score under half their weight (ADR 0045). */
function lowDimensionReasons(policy: Policy, scored: Scored): ReasonOut[] {
  const reasons: ReasonOut[] = []
  for (const d of scored.dimensions) {
    if (!d.used || d.normalized === null || d.normalized >= LOW_DIMENSION) continue
    const def = policy.score.dimensions.find((x) => x.id === d.id)
    const what = d.relative_to ? `${d.feature} / ${d.relative_to}` : d.feature
    reasons.push({
      code: codeOf('dimension', d.id, 'low'),
      message: `La dimensión "${d.id}" suma ${fmt(round2(d.points))} de ${fmt(d.weight)}: ${what} = ${fmt(d.value)}${def ? ` (cero puntos en ${fmt(def.zeroAt)}, completos en ${fmt(def.fullAt)})` : ''}.`,
      features: dimensionFeatures(d),
    })
  }
  return reasons
}

const dimensionReasons = (policy: Policy, profile: Profile, scored: Scored): ReasonOut[] => [...unusedDimensionReasons(policy, profile, scored), ...lowDimensionReasons(policy, scored)]

function capReasons(policy: Policy, profile: Profile, scored: Scored): ReasonOut[] {
  const reasons: ReasonOut[] = []
  for (const c of scored.caps) {
    if (!c.applied) continue
    const cap = policy.decision.caps[c.index]
    const f = readFeature(profile, c.feature)
    const max = `máximo "${STATUS_TEXT[c.max_status]}"`
    reasons.push({
      code: codeOf('cap', c.feature),
      // With no data the cap applies as a precaution; say so instead of quoting a value.
      message:
        f.exclusion === 'unknown'
          ? `Tope: sin dato de ${c.feature}, por precaución aplica ${max}.`
          : `Tope: ${c.feature} ${cap?.when.op ?? ''} ${fmt(cap?.when.value)} (valor: ${fmt(f.value)}${f.exclusion ? `, ${EXCLUSION_TEXT[f.exclusion]}` : ''}) → ${max}.`,
      features: [c.feature],
    })
  }
  return reasons
}

/** Would the band change if the doubtful data were favorable? If so, also returns the reason. */
function sensitivityOf(policy: Policy, profile: Profile, scored: Scored): { sensitive: boolean; reason: ReasonOut | null } {
  if (scored.uncertain.length === 0) return { sensitive: false, reason: null }
  const best = scoreProfile(policy, profile, true)
  const sensitive = best.finalStatus !== scored.finalStatus || best.limitBandIndex !== scored.limitBandIndex
  if (!sensitive) return { sensitive, reason: null }
  const kinds = [...new Set(scored.uncertain.map((u) => u.exclusion))]
  return {
    sensitive,
    reason: {
      code: kinds.includes('low_confidence') && kinds.length === 1 ? 'decision_depends_on_low_confidence' : 'decision_depends_on_unverified',
      message: `Con ${scored.uncertain.map((u) => `${u.feature} (${EXCLUSION_TEXT[u.exclusion]})`).join('; ')} el resultado puede ir de "${STATUS_TEXT[scored.finalStatus]}" a "${STATUS_TEXT[best.finalStatus]}": no se decide con esos datos.`,
      features: [...new Set(scored.uncertain.map((u) => u.feature))],
    },
  }
}

interface Outcome {
  status: DecisionStatus
  limit: number | null
  topics: Set<AskTopic>
  reasons: ReasonOut[]
}

/** Gates decide first. A clarification can also carry doubtful topics, in the same round. */
function gateOutcome(status: ReturnType<typeof worstGate> & string, gates: ReturnType<typeof evaluateGates>, scored: Scored, sensitive: boolean): Outcome {
  const topics = new Set<AskTopic>()
  if (status === 'needs_clarification') {
    for (const e of gates.effects) if (e.ask) topics.add(e.ask)
    // One round only (docs/03 §7): anything else we can ask goes in the same one.
    if (sensitive) uncertainTopics(scored).forEach((t) => topics.add(t))
  }
  return { status, limit: null, topics, reasons: [] }
}

const uncertainTopics = (scored: Scored): AskTopic[] => scored.uncertain.flatMap((u) => (u.topic ? [u.topic] : []))

/** The band depends on doubtful data: ask if every doubt is askable, otherwise a person reviews. */
function sensitiveOutcome(scored: Scored): Outcome {
  const clarifiable = scored.uncertain.every((u) => u.topic !== null)
  return { status: clarifiable ? 'needs_clarification' : 'human_review', limit: null, topics: new Set(clarifiable ? uncertainTopics(scored) : []), reasons: [] }
}

/** No gate or doubt in the way: the score and the limit formula decide. */
function limitOutcome(scored: Scored, lim: LimitResult | null): Outcome {
  const topics = new Set<AskTopic>()
  const none = (status: DecisionStatus, reasons: ReasonOut[] = []): Outcome => ({ status, limit: null, topics, reasons })
  if (scored.finalStatus === 'not_qualified' || lim === null) return none('not_qualified')
  if (lim.bandExclusion !== null) {
    const topic = topicFor(lim.bandExclusion.feature, lim.bandExclusion.exclusion)
    if (topic) topics.add(topic)
    return none(topic ? 'needs_clarification' : 'human_review', [
      {
        code: 'limit_depends_on_unverified',
        message: `La línea se calcula sobre ${lim.bandExclusion.feature}, que no se puede usar: ${EXCLUSION_TEXT[lim.bandExclusion.exclusion]}.`,
        features: [lim.bandExclusion.feature],
      },
    ])
  }
  if (lim.value === null) return none('human_review', [{ code: 'limit_unavailable', message: 'No hay datos para calcular la línea.', features: [] }])
  if (lim.value <= 0) {
    return none('not_qualified', [
      {
        code: 'no_available_line',
        message: `La fórmula de línea da ${fmt(lim.value)}: no hay línea disponible (${lim.evaluation.terms.map((t) => `${t.term} = ${fmt(t.value)}`).join('; ')}).`,
        features: limitFeatures(lim.binding),
      },
    ])
  }
  return { status: scored.finalStatus, limit: lim.value, topics, reasons: [] }
}

/** Status and limit, following the precedence in the file header. */
function resolveOutcome(gates: ReturnType<typeof evaluateGates>, scored: Scored, sensitive: boolean, lim: LimitResult | null): Outcome {
  const gateStatus = worstGate(gates.effects)
  if (gateStatus !== null) return gateOutcome(gateStatus, gates, scored, sensitive)
  if (sensitive) return sensitiveOutcome(scored)
  return limitOutcome(scored, lim)
}

export function evaluateCore(policy: Policy, profile: Profile, opts: CoreOptions): Core {
  const gates = evaluateGates(policy, profile)
  const scored = scoreProfile(policy, profile, false)
  const band = policy.decision.bands[scored.bandIndex] as Band

  const reasons: ReasonOut[] = [
    ...gateReasons(profile, gates),
    ...dimensionReasons(policy, profile, scored),
    {
      code: 'score_band',
      message: `Puntaje ${fmt(scored.score)} de 100: banda "${STATUS_TEXT[band.status]}" (desde ${fmt(band.min)}).`,
      features: scored.dimensions.filter((d) => d.used).map((d) => d.feature),
    },
    ...capReasons(policy, profile, scored),
  ]
  const { sensitive, reason: sensitivity } = sensitivityOf(policy, profile, scored)
  if (sensitivity) reasons.push(sensitivity)

  const limitBand = scored.limitBandIndex !== null ? (policy.decision.bands[scored.limitBandIndex] as Band) : null
  const lim = limitBand ? computeLimit(policy, profile, limitBand) : null
  const outcome = resolveOutcome(gates, scored, sensitive, lim)
  reasons.push(...outcome.reasons)
  let { status } = outcome
  const { topics } = outcome

  if (lim !== null && lim.binding !== null && (status === 'qualified' || status === 'qualified_with_limit')) {
    reasons.push(limitReason(profile, lim))
  }
  if (lim !== null) {
    for (const f of lim.assumedZero) reasons.push({ code: codeOf('assumed_zero', f), message: `Sin dato de ${f}: se toma 0 en la fórmula de línea.`, features: [f] })
  }

  if (status === 'needs_clarification' && opts.clarificationRoundsUsed >= policy.clarification.maxRounds) {
    status = 'human_review'
    topics.clear()
    reasons.push({
      code: 'clarification_rounds_exhausted',
      message: `Ya se usaron ${String(opts.clarificationRoundsUsed)} de ${String(policy.clarification.maxRounds)} rondas de aclaración: pasa a revisión humana.`,
      features: [],
    })
  }

  return {
    status,
    score: scored.score,
    bandIndex: scored.bandIndex,
    gates: gates.evals,
    dimensions: scored.dimensions,
    caps: scored.caps,
    limitEvaluation: lim?.evaluation ?? null,
    limit: outcome.limit,
    topics: status === 'needs_clarification' ? [...topics] : [],
    reasons,
  }
}

function limitFeatures(t: LimitTerm | null): FeatureName[] {
  if (t === null) return []
  switch (t.type) {
    case 'band':
      return []
    case 'feature':
      return [t.feature]
    case 'difference':
      return [t.minuend, t.subtrahend]
  }
}

/** Which term sets the limit. `existing_exposure` is the code the docs/06 scenarios expect. */
function limitReason(profile: Profile, lim: LimitResult): ReasonOut {
  const t = lim.binding as LimitTerm
  const value = fmt(lim.value)
  switch (t.type) {
    case 'band':
      return { code: 'limit_band', message: `La línea (${value}) la fija el porcentaje de la banda.`, features: [] }
    case 'feature':
      return {
        code: t.feature === 'program_available_limit' ? 'program_limit' : codeOf('limit', t.feature),
        message: `La línea (${value}) la fija ${t.feature} = ${fmt(profile.features[t.feature].value)}.`,
        features: [t.feature],
      }
    case 'difference': {
      const sub = profile.features[t.subtrahend].value
      const exposure = t.subtrahend === 'existing_exposure_balance' && typeof sub === 'number' && sub > 0
      if (exposure) {
        return {
          code: 'existing_exposure',
          message: `La línea (${value}) se reduce por la exposición vigente con esta institución crediticia: ${t.minuend} ${fmt(profile.features[t.minuend].value)} menos saldo vigente ${fmt(sub)}.`,
          features: [t.minuend, t.subtrahend],
        }
      }
      // Nothing to subtract: the minuend sets it.
      if (sub === null || sub === 0) return { code: codeOf('limit', t.minuend), message: `La línea (${value}) la fija ${t.minuend} = ${fmt(profile.features[t.minuend].value)}.`, features: [t.minuend] }
      return { code: codeOf('limit', t.minuend, 'minus', t.subtrahend), message: `La línea (${value}) la fija ${t.minuend} − ${t.subtrahend}.`, features: [t.minuend, t.subtrahend] }
    }
  }
}
