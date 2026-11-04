/**
 * Contrafactuales para `next_steps` (docs/03 §6): qué cambio en una feature, con todo lo demás
 * igual, movería el resultado sobre la misma política. Es el "motor de segunda oportunidad":
 * "con 3 meses de historial el tope desaparece", "al corriente en tu crédito vuelves a calificar".
 *
 * Cada candidato se verifica re-evaluando el perfil modificado: el `to` de un next step es
 * exactamente lo que daría el motor (lo comprueba un test de propiedades).
 */
import { FEATURE_CATALOG, type FeatureName, type NextStep, type Policy, type Profile } from '@gow/contracts'
import type { z } from 'zod'
import { ceil2, floor2 } from '../util/num.ts'
import { negate, satisfyingValue, stepOf } from './conditions.ts'
import { DECISION_STATUS_RANK, evaluateCore, type Core, type CoreOptions } from './core.ts'
import { codeOf } from './messages.ts'

type NextStepOut = z.infer<typeof NextStep>

export interface FeatureChange {
  feature: FeatureName
  value: unknown
}

/** Features que se mueven juntas: quedar al corriente es cero días de atraso y cero monto vencido. */
const COMPANIONS: Readonly<Partial<Record<FeatureName, readonly FeatureChange[]>>> = {
  existing_exposure_days_past_due: [{ feature: 'existing_exposure_past_due_amount', value: 0 }],
}

/** Copia del perfil con features cambiadas, verificadas y con confianza 1. No muta el original. */
export function withFeatures(profile: Profile, changes: readonly FeatureChange[]): Profile {
  const features = { ...profile.features } as Record<FeatureName, unknown>
  for (const c of changes) {
    features[c.feature] = { value: c.value, confidence: 1, verification: 'verified', provenance: profile.features[c.feature].provenance, evidence: [], note: 'contrafactual' }
  }
  return { ...profile, features: features as Profile['features'] }
}

interface Candidate {
  code: string
  changes: FeatureChange[]
  /** Prioridad para ordenar empates: compuertas, luego topes, luego dimensiones. */
  priority: number
}

function roundToward(feature: FeatureName, value: number, up: boolean): number {
  const kind = FEATURE_CATALOG[feature].kind
  if (kind === 'int') return Math.max(0, up ? Math.ceil(value - 1e-9) : Math.floor(value + 1e-9))
  if (kind === 'money') return Math.max(0, up ? ceil2(value) : floor2(value))
  return up ? Math.ceil(value * 10_000 - 1e-6) / 10_000 : Math.floor(value * 10_000 + 1e-6) / 10_000
}

function numberOf(profile: Profile, f: FeatureName): number | null {
  const v = profile.features[f].value
  return typeof v === 'number' ? v : null
}

function withCompanions(feature: FeatureName, value: unknown): FeatureChange[] {
  return [{ feature, value }, ...(COMPANIONS[feature] ?? [])]
}

const GATE_SEVERITY = { not_qualified: 0, human_review: 1, needs_clarification: 2, none: 3 } as const

/** Lo que haría pasar todas las compuertas que hoy bloquean, de la más grave a la menos. */
function gateFixes(policy: Policy, base: Core): FeatureChange[] {
  const out: FeatureChange[] = []
  const blocking = base.gates.filter((g) => g.effect !== 'none').sort((a, b) => GATE_SEVERITY[a.effect] - GATE_SEVERITY[b.effect])
  for (const g of blocking) {
    const gate = policy.gates.find((x) => x.id === g.id)
    const target = gate ? satisfyingValue(gate.when) : undefined
    if (target === undefined || out.some((c) => c.feature === g.feature)) continue
    out.push(...withCompanions(g.feature, target))
  }
  return out
}

/** Topes y dimensiones, medidos sobre el resultado que quedaría con las compuertas ya resueltas. */
function scoreCandidates(policy: Policy, profile: Profile, after: Core): Candidate[] {
  const out: Candidate[] = []
  for (const c of after.caps) {
    if (!c.applied) continue
    const cap = policy.decision.caps[c.index]
    if (!cap) continue
    const target = satisfyingValue(negate(cap.when))
    if (target !== undefined) out.push({ code: codeOf('cap', c.feature), changes: withCompanions(c.feature, target), priority: 1 })
  }
  const next = policy.decision.bands[after.bandIndex - 1]
  if (next === undefined) return out
  for (const d of policy.score.dimensions) {
    const ev = after.dimensions.find((x) => x.id === d.id)
    if (!ev || ev.points >= d.weight) continue
    const needed = next.min - (after.score - ev.points)
    if (needed > d.weight + 1e-9 || needed <= 0) continue
    const ratio = d.zeroAt + (needed / d.weight) * (d.fullAt - d.zeroAt)
    const up = !d.inverse
    if (d.relativeTo === undefined) {
      out.push({ code: codeOf('improve', d.id), changes: [{ feature: d.feature, value: roundToward(d.feature, ratio, up) }], priority: 2 })
      continue
    }
    const rel = numberOf(profile, d.relativeTo)
    if (rel !== null && rel > 0) out.push({ code: codeOf('improve', d.id), changes: [{ feature: d.feature, value: roundToward(d.feature, ratio * rel, up) }], priority: 2 })
    // Pedir menos también sube la capacidad: monto / razón objetivo.
    const main = numberOf(profile, d.feature)
    if (d.relativeTo === 'requested_amount' && !d.inverse && main !== null && main > 0 && ratio > 0) {
      out.push({ code: 'reduce_requested_amount', changes: [{ feature: 'requested_amount', value: roundToward('requested_amount', main / ratio, false) }], priority: 3 })
    }
  }
  return out
}

/** Mejor estado, o la misma calificación en una banda más alta (más línea). */
function improves(base: Core, to: Core): boolean {
  const a = DECISION_STATUS_RANK[base.status]
  const b = DECISION_STATUS_RANK[to.status]
  const qualifies = to.status === 'qualified' || to.status === 'qualified_with_limit'
  return b > a || (b === a && qualifies && to.bandIndex < base.bandIndex)
}

/** Si el redondeo dejó el objetivo un paso corto, se intenta un paso más. */
function nudge(c: Candidate): Candidate | null {
  const [main, ...rest] = c.changes
  if (!main || typeof main.value !== 'number' || c.priority < 2) return null
  const step = stepOf(main.feature)
  const direction = c.code === 'reduce_requested_amount' ? -1 : 1
  return { ...c, changes: [{ feature: main.feature, value: Math.round((main.value + direction * step) * 10_000) / 10_000 }, ...rest] }
}

/**
 * Cuando hay compuertas que bloquean, un cambio aislado casi nunca mueve el estado. Por eso el
 * primer paso es pasar todas las compuertas juntas (`pass_gates`), y cada tope o dimensión se
 * mide sobre ese resultado: sus `related` incluyen las compuertas, así que `to` sigue siendo
 * exactamente lo que da el motor con todos esos cambios.
 */
export function counterfactuals(policy: Policy, profile: Profile, base: Core, opts: CoreOptions, max = 5): NextStepOut[] {
  const fixes = gateFixes(policy, base)
  const afterGates = fixes.length > 0 ? evaluateCore(policy, withFeatures(profile, fixes), opts) : base
  const found: { c: Candidate; to: Core }[] = []
  if (fixes.length > 0 && improves(base, afterGates)) found.push({ c: { code: 'pass_gates', changes: fixes, priority: 0 }, to: afterGates })

  for (const c0 of scoreCandidates(policy, profile, afterGates)) {
    let c: Candidate = { ...c0, changes: [...c0.changes, ...fixes.filter((f) => !c0.changes.some((x) => x.feature === f.feature))] }
    // Debe mejorar lo que queda tras las compuertas y no quedar peor que el estado actual.
    const useful = (t: Core) => improves(afterGates, t) && improves(base, t)
    let to = evaluateCore(policy, withFeatures(profile, c.changes), opts)
    if (!useful(to)) {
      const n = nudge(c)
      if (n === null) continue
      const toN = evaluateCore(policy, withFeatures(profile, n.changes), opts)
      if (!useful(toN)) continue
      c = n
      to = toN
    }
    found.push({ c, to })
  }
  found.sort((x, y) => x.c.priority - y.c.priority || DECISION_STATUS_RANK[y.to.status] - DECISION_STATUS_RANK[x.to.status] || y.to.score - x.to.score)
  const seen = new Set<string>()
  const steps: NextStepOut[] = []
  for (const { c, to } of found) {
    const [main, ...related] = c.changes
    if (!main || seen.has(`${c.code}:${main.feature}`)) continue
    seen.add(`${c.code}:${main.feature}`)
    steps.push({
      code: c.code,
      feature: main.feature,
      current_value: profile.features[main.feature].value as NextStepOut['current_value'],
      target_value: main.value as NextStepOut['target_value'],
      related: related.map((r) => ({ feature: r.feature, current_value: profile.features[r.feature].value as NextStepOut['current_value'], target_value: r.value as NextStepOut['target_value'] })),
      from: { status: base.status, score: base.score },
      to: { status: to.status, score: to.score },
      message: null,
    })
    if (steps.length >= max) break
  }
  return steps
}
