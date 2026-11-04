/**
 * Núcleo del motor: aplica la política al perfil y produce estado, puntaje, banda, línea y
 * razones. Puro: mismo perfil y misma política dan exactamente el mismo resultado. Los
 * contrafactuales (counterfactuals.ts) lo llaman sobre perfiles modificados.
 *
 * Orden de precedencia del estado:
 *   1. Compuertas: not_qualified > human_review > needs_clarification.
 *   2. Regla de docs/04 §5: si una feature excluida por no verificada, en conflicto o con
 *      confianza baja puede cambiar la banda, no se decide con ella: se pregunta al proveedor si
 *      puede aclararla, o va a revisión humana si no.
 *   3. Banda por puntaje, rebajada por los topes (`caps`).
 *   4. Línea: `limitFormula`; si queda en cero o menos, no califica (no hay línea que dar).
 *   5. Sin rondas de aclaración disponibles, needs_clarification se vuelve human_review.
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

/** Orden de los estados para comparar resultados (contrafactuales, simulación). */
export const DECISION_STATUS_RANK: Readonly<Record<DecisionStatus, number>> = {
  qualified: 4,
  qualified_with_limit: 3,
  needs_clarification: 2,
  human_review: 1,
  not_qualified: 0,
}

/**
 * Qué se le puede pedir al proveedor cuando una feature no alcanza para decidir. Lo que
 * depende de la clasificación de abonos se aclara preguntando por ellos; identidad,
 * antigüedad e historia, pidiendo el dato o el documento.
 */
export const FEATURE_ASK: Readonly<Partial<Record<FeatureName, AskTopic>>> = {
  operating_income_monthly: 'deposit_classification',
  free_cash_flow_monthly: 'deposit_classification',
  payment_capacity_pct: 'deposit_classification',
  debt_capacity: 'deposit_classification',
  debt_service_monthly: 'deposit_classification',
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

/** Features que el proveedor puede confirmar aunque la extracción no las haya verificado. */
const OWNER_VERIFIABLE: ReadonlySet<FeatureName> = new Set(['identity_match', 'document_age_days', 'months_of_history'])

/**
 * ¿Se le puede preguntar al proveedor? Confianza baja en la clasificación sí (él sabe de dónde
 * vino un abono); un valor no verificado contra el documento no, salvo identidad y fechas: lo
 * revisa una persona con la página a la vista (docs/04 §5).
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

function evaluateGates(policy: Policy, profile: Profile): { evals: GateEval[]; effects: GateEffect[] } {
  const evals: GateEval[] = []
  const effects: GateEffect[] = []
  for (const g of policy.gates) {
    const f = readFeature(profile, g.when.feature)
    let outcome: GateEval['outcome']
    let effect: GateEval['effect'] = 'none'
    let ask: AskTopic | null = null
    if (f.exclusion === 'unknown') {
      outcome = 'unknown'
      switch (g.onUnknown) {
        case 'pass':
          break
        case 'fail':
          effect = g.onFail.status
          ask = g.onFail.ask ?? null
          break
        case 'ask':
          effect = 'needs_clarification'
          ask = g.onFail.ask ?? null
          break
        case 'human_review':
          effect = 'human_review'
          break
      }
    } else if (f.exclusion !== null) {
      // docs/04 §5: un valor no verificado no pasa ni reprueba una compuerta.
      outcome = 'unknown'
      ask = g.onFail.ask ?? topicFor(g.when.feature, f.exclusion)
      effect = ask !== null ? 'needs_clarification' : 'human_review'
    } else {
      outcome = checkCondition(g.when, f.value) ? 'pass' : 'fail'
      if (outcome === 'fail') {
        effect = g.onFail.status
        ask = g.onFail.ask ?? null
      }
    }
    evals.push({ id: g.id, feature: g.when.feature, op: g.when.op, threshold: (g.when.value ?? null), value: f.value as GateEval['value'], outcome, effect, ask })
    if (effect !== 'none') effects.push({ id: g.id, feature: g.when.feature, status: effect, ask })
  }
  return { evals, effects }
}

function minStatus(a: FinalDecisionStatus, b: FinalDecisionStatus): FinalDecisionStatus {
  return FINAL_STATUS_RANK[b] < FINAL_STATUS_RANK[a] ? b : a
}

/**
 * Puntaje, banda y topes. Con `optimistic`, las dimensiones excluidas por dudas (no por falta de
 * dato) suman todos sus puntos y los topes que dependen de un dato dudoso no aplican: es el mejor
 * caso que permite la regla de docs/04 §5.
 */
function scoreProfile(policy: Policy, profile: Profile, optimistic: boolean): Scored {
  const minConf = policy.score.minConfidence
  const uncertain: Uncertain[] = []
  const dimensions: DimensionEval[] = policy.score.dimensions.map((d) => {
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
    const value = raw === null ? null : round4(raw)
    const base = { id: d.id, feature: d.feature, relative_to: d.relativeTo ?? null, value, weight: d.weight }
    if (exclusion !== null || value === null) {
      const reason = exclusion ?? 'unknown'
      if (reason !== 'unknown') uncertain.push({ feature: excludedFeature, exclusion: reason, topic: topicFor(excludedFeature, reason), where: `dimension:${d.id}` })
      const full = optimistic && reason !== 'unknown'
      return { ...base, normalized: full ? 1 : null, points: full ? d.weight : 0, used: false, excluded_reason: reason }
    }
    const normalized = round4(clamp01((value - d.zeroAt) / (d.fullAt - d.zeroAt)))
    return { ...base, normalized, points: round4(d.weight * normalized), used: true, excluded_reason: null }
  })
  const score = round2(dimensions.reduce((s, d) => s + d.points, 0))
  const bands = policy.decision.bands
  const bandIndex = Math.max(
    0,
    bands.findIndex((b) => score >= b.min),
  )
  const band = bands[bandIndex] as Band

  let finalStatus: FinalDecisionStatus = band.status
  const caps: CapEval[] = policy.decision.caps.map((c, index) => {
    const f = readFeature(profile, c.when.feature)
    let applied: boolean
    if (f.exclusion === 'unknown') applied = true // sin dato: el tope aplica (conservador)
    else if (f.exclusion !== null) {
      uncertain.push({ feature: c.when.feature, exclusion: f.exclusion, topic: topicFor(c.when.feature, f.exclusion), where: `cap:${String(index)}` })
      applied = !optimistic
    } else applied = checkCondition(c.when, f.value)
    if (applied) finalStatus = minStatus(finalStatus, c.maxStatus)
    return { index, feature: c.when.feature, applied, max_status: c.maxStatus }
  })

  // La línea sale de la banda del estado final: si un tope bajó el estado, de la primera banda con
  // ese estado; si la política no tiene banda con ese estado, de la banda del puntaje.
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

/**
 * `limitFormula`: mínimo de los términos conocidos, nunca negativo. Un término de feature
 * desconocida no cuenta; en una resta, un sustraendo desconocido se toma como 0 y se dice
 * (sin adaptador de créditos vigentes no hay exposición conocida). El término `band` exige
 * su feature verificada: es la que fija el monto.
 */
function computeLimit(policy: Policy, profile: Profile, band: Band): LimitResult {
  const parsed = parseLimitFormula(policy.decision.limitFormula)
  if (!parsed.ok) throw new Error(`limitFormula inválida en una política ya validada: ${parsed.error}`)
  const terms: { term: LimitTerm; value: number | null }[] = []
  let bandExclusion: LimitResult['bandExclusion'] = null
  const assumedZero: FeatureName[] = []
  for (const term of parsed.formula.terms) {
    switch (term.type) {
      case 'band': {
        const lim = band.limit
        if (!lim) {
          terms.push({ term, value: null })
          break
        }
        const f = readFeature(profile, lim.pctOf, policy.score.minConfidence)
        if (f.exclusion !== null) bandExclusion = { feature: lim.pctOf, exclusion: f.exclusion }
        terms.push({ term, value: f.exclusion === null && typeof f.value === 'number' ? round2((f.value * lim.pct) / 100) : null })
        break
      }
      case 'feature':
        terms.push({ term, value: numberOf(profile, term.feature) })
        break
      case 'difference': {
        const a = numberOf(profile, term.minuend)
        const b = numberOf(profile, term.subtrahend)
        if (a !== null && b === null) assumedZero.push(term.subtrahend)
        terms.push({ term, value: a === null ? null : round2(a - (b ?? 0)) })
        break
      }
    }
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

function worstGate(effects: readonly GateEffect[]): GateEffect['status'] | null {
  if (effects.some((e) => e.status === 'not_qualified')) return 'not_qualified'
  if (effects.some((e) => e.status === 'human_review')) return 'human_review'
  if (effects.some((e) => e.status === 'needs_clarification')) return 'needs_clarification'
  return null
}

export function evaluateCore(policy: Policy, profile: Profile, opts: CoreOptions): Core {
  const reasons: ReasonOut[] = []
  const topics = new Set<AskTopic>()
  const gates = evaluateGates(policy, profile)
  const scored = scoreProfile(policy, profile, false)
  const bands = policy.decision.bands

  for (const e of gates.effects) {
    const g = gates.evals.find((x) => x.id === e.id)
    const how = g?.outcome === 'fail' ? `${e.feature} = ${fmt(g.value)} no cumple ${g.op} ${fmt(g.threshold)}` : `${e.feature}: ${EXCLUSION_TEXT[readFeature(profile, e.feature).exclusion ?? 'unknown']}`
    reasons.push({
      code: g?.outcome === 'fail' ? codeOf('gate', e.id) : codeOf('gate', e.id, 'unknown'),
      message: `Compuerta "${e.id}": ${how} → ${STATUS_TEXT[e.status]}${e.ask ? ` (pedir ${ASK_TEXT[e.ask]})` : ''}.`,
      features: [e.feature],
    })
  }
  for (const d of scored.dimensions) {
    if (d.used) continue
    const reason = d.excluded_reason ?? 'unknown'
    reasons.push({
      code: codeOf('dimension', d.id, reason === 'unknown' ? 'without_data' : reason),
      message: `La dimensión "${d.id}" no suma puntos: ${EXCLUSION_TEXT[reason]}.`,
      features: d.relative_to ? [d.feature, d.relative_to] : [d.feature],
    })
  }
  const band = bands[scored.bandIndex] as Band
  reasons.push({
    code: 'score_band',
    message: `Puntaje ${fmt(scored.score)} de 100: banda "${STATUS_TEXT[band.status]}" (desde ${fmt(band.min)}).`,
    features: scored.dimensions.filter((d) => d.used).map((d) => d.feature),
  })
  scored.caps.forEach((c) => {
    if (!c.applied) return
    const cap = policy.decision.caps[c.index]
    const f = readFeature(profile, c.feature)
    reasons.push({
      code: codeOf('cap', c.feature),
      message: `Tope: ${c.feature} ${cap?.when.op ?? ''} ${fmt(cap?.when.value)} (valor: ${fmt(f.value)}${f.exclusion && f.exclusion !== 'unknown' ? `, ${EXCLUSION_TEXT[f.exclusion]}` : ''}) → máximo "${STATUS_TEXT[c.max_status]}".`,
      features: [c.feature],
    })
  })

  // docs/04 §5: ¿cambia la banda si los datos dudosos fueran favorables?
  let sensitive = false
  if (scored.uncertain.length > 0) {
    const best = scoreProfile(policy, profile, true)
    sensitive = best.finalStatus !== scored.finalStatus || best.limitBandIndex !== scored.limitBandIndex
    if (sensitive) {
      const kinds = [...new Set(scored.uncertain.map((u) => u.exclusion))]
      reasons.push({
        code: kinds.includes('low_confidence') && kinds.length === 1 ? 'decision_depends_on_low_confidence' : 'decision_depends_on_unverified',
        message: `Con ${scored.uncertain.map((u) => `${u.feature} (${EXCLUSION_TEXT[u.exclusion]})`).join('; ')} el resultado puede ir de "${STATUS_TEXT[scored.finalStatus]}" a "${STATUS_TEXT[best.finalStatus]}": no se decide con esos datos.`,
        features: [...new Set(scored.uncertain.map((u) => u.feature))],
      })
    }
  }

  const limitBand = scored.limitBandIndex !== null ? (bands[scored.limitBandIndex] as Band) : null
  const lim = limitBand ? computeLimit(policy, profile, limitBand) : null

  let status: DecisionStatus
  let limit: number | null = null
  const gateStatus = worstGate(gates.effects)
  const addUncertainTopics = () => {
    for (const u of scored.uncertain) if (u.topic) topics.add(u.topic)
  }
  if (gateStatus !== null) {
    status = gateStatus
    if (status === 'needs_clarification') {
      for (const e of gates.effects) if (e.ask) topics.add(e.ask)
      // Una sola ronda (docs/03 §7): lo que también se puede preguntar va en la misma.
      if (sensitive) addUncertainTopics()
    }
  } else if (sensitive) {
    const clarifiable = scored.uncertain.every((u) => u.topic !== null)
    status = clarifiable ? 'needs_clarification' : 'human_review'
    if (clarifiable) addUncertainTopics()
  } else if (scored.finalStatus === 'not_qualified' || lim === null) {
    status = 'not_qualified'
  } else if (lim.bandExclusion !== null) {
    const topic = topicFor(lim.bandExclusion.feature, lim.bandExclusion.exclusion)
    status = topic ? 'needs_clarification' : 'human_review'
    if (topic) topics.add(topic)
    reasons.push({
      code: 'limit_depends_on_unverified',
      message: `La línea se calcula sobre ${lim.bandExclusion.feature}, que no se puede usar: ${EXCLUSION_TEXT[lim.bandExclusion.exclusion]}.`,
      features: [lim.bandExclusion.feature],
    })
  } else if (lim.value === null) {
    status = 'human_review'
    reasons.push({ code: 'limit_unavailable', message: 'No hay datos para calcular la línea.', features: [] })
  } else if (lim.value <= 0) {
    status = 'not_qualified'
    reasons.push({
      code: 'no_available_line',
      message: `La fórmula de línea da ${fmt(lim.value)}: no hay línea disponible (${lim.evaluation.terms.map((t) => `${t.term} = ${fmt(t.value)}`).join('; ')}).`,
      features: limitFeatures(lim.binding),
    })
  } else {
    status = scored.finalStatus
    limit = lim.value
  }

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
    limit,
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

/** Qué término fija la línea. `existing_exposure` es el código que piden los escenarios de docs/06. */
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
          message: `La línea (${value}) se reduce por la exposición vigente con este prestamista: ${t.minuend} ${fmt(profile.features[t.minuend].value)} menos saldo vigente ${fmt(sub)}.`,
          features: [t.minuend, t.subtrahend],
        }
      }
      // Sin nada que restar, la fija el minuendo.
      if (sub === null || sub === 0) return { code: codeOf('limit', t.minuend), message: `La línea (${value}) la fija ${t.minuend} = ${fmt(profile.features[t.minuend].value)}.`, features: [t.minuend] }
      return { code: codeOf('limit', t.minuend, 'minus', t.subtrahend), message: `La línea (${value}) la fija ${t.minuend} − ${t.subtrahend}.`, features: [t.minuend, t.subtrahend] }
    }
  }
}
