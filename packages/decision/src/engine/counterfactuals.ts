/**
 * Counterfactuals for `next_steps`: which change in a feature, everything else equal, would move
 * the result under the same policy. The "second chance" engine: "with 3 months of history the cap
 * goes away", "current on your loan you qualify again".
 *
 * Each candidate is verified by re-evaluating the modified profile: a next step's `to` (status,
 * score and line) is exactly what the engine would give (checked by a property test). A candidate
 * counts only if it improves the status or, for a qualifying status, raises the line.
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

/** Features that move together: being current is zero days late and zero overdue amount; the full PDF balances. */
const COMPANIONS: Readonly<Partial<Record<FeatureName, readonly FeatureChange[]>>> = {
  existing_exposure_days_past_due: [{ feature: 'existing_exposure_past_due_amount', value: 0 }],
  // With the full PDF the balance check stops failing on the missing pages.
  document_pages_missing: [{ feature: 'integrity_ok', value: true }],
}

/** Copy of the profile with changed features, verified and with confidence 1. Does not mutate the original. */
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
  /** Tie-break priority: gates, then caps, then dimensions. */
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

/** What would pass every gate that blocks today, from the most severe to the least. */
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

function capCandidates(policy: Policy, after: Core): Candidate[] {
  const out: Candidate[] = []
  for (const c of after.caps) {
    if (!c.applied) continue
    const cap = policy.decision.caps[c.index]
    if (!cap) continue
    const target = satisfyingValue(negate(cap.when))
    if (target !== undefined) out.push({ code: codeOf('cap', c.feature), changes: withCompanions(c.feature, target), priority: 1 })
  }
  return out
}

function dimensionCandidates(policy: Policy, profile: Profile, after: Core): Candidate[] {
  const next = policy.decision.bands[after.bandIndex - 1]
  if (next === undefined) return []
  const out: Candidate[] = []
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
    const main = numberOf(profile, d.feature)
    if (d.relativeTo === 'requested_amount' && !d.inverse && main !== null && main > 0 && ratio > 0) {
      out.push({ code: 'reduce_requested_amount', changes: [{ feature: 'requested_amount', value: roundToward('requested_amount', main / ratio, false) }], priority: 3 })
    }
  }
  return out
}

/** Caps and dimensions, measured on the result with the gates already resolved. */
function scoreCandidates(policy: Policy, profile: Profile, after: Core): Candidate[] {
  return [...capCandidates(policy, after), ...dimensionCandidates(policy, profile, after)]
}

/**
 * Better status, or the same qualifying status with a bigger line. The score band is not
 * considered: a cap can leave status and line identical even if the score moves up a band, and
 * telling the supplier they would go "de califica con límite a califica con límite" is useless.
 * No line counts as 0.
 */
function improves(base: Core, to: Core): boolean {
  const a = DECISION_STATUS_RANK[base.status]
  const b = DECISION_STATUS_RANK[to.status]
  const qualifies = to.status === 'qualified' || to.status === 'qualified_with_limit'
  return b > a || (b === a && qualifies && (to.limit ?? 0) > (base.limit ?? 0))
}

/** If rounding left the target one step short, try one more step. */
function nudge(c: Candidate): Candidate | null {
  const [main, ...rest] = c.changes
  if (!main || typeof main.value !== 'number' || c.priority < 2) return null
  const step = stepOf(main.feature)
  const direction = c.code === 'reduce_requested_amount' ? -1 : 1
  return { ...c, changes: [{ feature: main.feature, value: Math.round((main.value + direction * step) * 10_000) / 10_000 }, ...rest] }
}

function evaluateCandidate(
  c0: Candidate,
  fixes: FeatureChange[],
  policy: Policy,
  profile: Profile,
  base: Core,
  afterGates: Core,
  opts: CoreOptions,
): { c: Candidate; to: Core } | null {
  let c: Candidate = { ...c0, changes: [...c0.changes, ...fixes.filter((f) => !c0.changes.some((x) => x.feature === f.feature))] }
  const useful = (t: Core) => improves(afterGates, t) && improves(base, t)
  let to = evaluateCore(policy, withFeatures(profile, c.changes), opts)
  if (!useful(to)) {
    const n = nudge(c)
    if (n === null) return null
    const toN = evaluateCore(policy, withFeatures(profile, n.changes), opts)
    if (!useful(toN)) return null
    c = n
    to = toN
  }
  return { c, to }
}

/**
 * With blocking gates, an isolated change almost never moves the status. So the first step is to
 * pass all gates together (`pass_gates`), and each cap or dimension is measured on that result:
 * its `related` includes the gates, so `to` is still exactly what the engine gives with all those
 * changes.
 */
export function counterfactuals(policy: Policy, profile: Profile, base: Core, opts: CoreOptions, max = 5): NextStepOut[] {
  const fixes = gateFixes(policy, base)
  const afterGates = fixes.length > 0 ? evaluateCore(policy, withFeatures(profile, fixes), opts) : base
  const found: { c: Candidate; to: Core }[] = []
  if (fixes.length > 0 && improves(base, afterGates)) found.push({ c: { code: 'pass_gates', changes: fixes, priority: 0 }, to: afterGates })

  for (const c0 of scoreCandidates(policy, profile, afterGates)) {
    const res = evaluateCandidate(c0, fixes, policy, profile, base, afterGates, opts)
    if (res) found.push(res)
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
      current_value: profile.features[main.feature].value,
      target_value: main.value as NextStepOut['target_value'],
      related: related.map((r) => ({ feature: r.feature, current_value: profile.features[r.feature].value, target_value: r.value as NextStepOut['target_value'] })),
      from: { status: base.status, score: base.score, limit: base.limit },
      to: { status: to.status, score: to.score, limit: to.limit },
      message: null,
    })
    if (steps.length >= max) break
  }
  return steps
}
