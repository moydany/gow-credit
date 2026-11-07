/**
 * Engine properties: it is pure. fast-check generates profiles with random values, unknowns,
 * verification and confidence over the base policy and valid variations of it.
 */
import { FINAL_STATUS_RANK, type FeatureName, type Policy, type Profile, type Verification } from '@gow/contracts'
import { sampleProfile } from '@gow/contracts/testing'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { simulatePolicy } from '../simulate.ts'
import { basePolicyTemplate, clonePolicy } from '../template.ts'
import { withFeatures } from './counterfactuals.ts'
import { DECISION_STATUS_RANK } from './core.ts'
import { evaluate } from './evaluate.ts'

const BASE = basePolicyTemplate()
const RUNS = { numRuns: 300 }

type Values = NonNullable<Parameters<typeof sampleProfile>[0]>

const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null, freq: 5 })
const money = (max: number) => fc.integer({ min: 0, max: max * 100 }).map((c) => c / 100)
const ratio = (min: number, max: number) => fc.integer({ min: Math.round(min * 10_000), max: Math.round(max * 10_000) }).map((n) => n / 10_000)

const valuesArb: fc.Arbitrary<Values> = fc.record({
  document_age_days: maybe(fc.integer({ min: 0, max: 400 })),
  identity_match: maybe(fc.constantFrom('match' as const, 'partial' as const, 'mismatch' as const)),
  integrity_ok: maybe(fc.boolean()),
  red_flags: maybe(fc.subarray(['overdraft', 'returned_check', 'garnishment', 'judicial_order', 'tax_requirement'] as const).map((a) => [...a])),
  existing_exposure_days_past_due: maybe(fc.integer({ min: 0, max: 120 })),
  existing_exposure_past_due_amount: maybe(money(100_000)),
  existing_exposure_balance: maybe(money(1_000_000)),
  operating_income_monthly: maybe(money(2_000_000)),
  requested_amount: maybe(money(1_000_000).filter((n) => n > 0)),
  buyer_payments_count: maybe(fc.integer({ min: 0, max: 12 })),
  payment_capacity_pct: maybe(ratio(-2, 1)),
  debt_service_monthly: maybe(money(500_000)),
  recurring_income_share: maybe(ratio(0, 1)),
  months_of_history: maybe(fc.integer({ min: 0, max: 24 })),
  debt_capacity: maybe(money(3_000_000)),
  program_available_limit: maybe(money(1_000_000)),
})

const DECISION_FEATURES = Object.keys(sampleProfile().features).filter((f) => f !== 'prior_applications') as FeatureName[]
const metaArb = fc.dictionary(
  fc.constantFrom(...DECISION_FEATURES),
  fc.record({ verification: fc.constantFrom<Verification>('verified', 'verified', 'verified', 'unverified', 'conflict'), confidence: ratio(0.4, 1) }),
  { maxKeys: 4 },
)

function build(values: Values, meta: Record<string, { verification: Verification; confidence: number }> = {}): Profile {
  const p = sampleProfile(values)
  for (const [name, m] of Object.entries(meta)) {
    const f = p.features[name as FeatureName]
    if (f.value !== null) Object.assign(f, m)
  }
  return p
}

const profileArb = fc.tuple(valuesArb, metaArb).map(([v, m]) => build(v, m))
const verifiedProfileArb = valuesArb.map((v) => build(v))

/** Valid template variations: thresholds, weights that sum to 100, and shifted bands. */
const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    age: fc.integer({ min: 30, max: 180 }),
    weights: fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 5, maxLength: 5 }),
    top: fc.integer({ min: 60, max: 90 }),
    gap: fc.integer({ min: 5, max: 30 }),
    pctTop: fc.integer({ min: 20, max: 80 }),
    minConfidence: ratio(0.5, 0.9),
    rounds: fc.integer({ min: 0, max: 3 }),
  })
  .map((r) => {
    const p = basePolicyTemplate()
    const total = r.weights.reduce((a, b) => a + b, 0)
    const scaled = r.weights.map((w) => Math.floor((w / total) * 100))
    scaled[0] = (scaled[0] ?? 0) + 100 - scaled.reduce((a, b) => a + b, 0)
    p.score.dimensions.forEach((d, i) => {
      d.weight = scaled[i] ?? 1
    })
    p.score.dimensions = p.score.dimensions.filter((d) => d.weight > 0)
    const gate = p.gates.find((g) => g.id === 'doc_recent')
    if (gate) gate.when.value = r.age
    const [b0, b1] = p.decision.bands
    if (b0 && b1) {
      b0.min = r.top
      b1.min = r.top - r.gap
      if (b0.limit) b0.limit.pct = r.pctTop
    }
    p.score.minConfidence = r.minConfidence
    p.clarification.maxRounds = r.rounds
    return clonePolicy(p, { version: 2 })
  })

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

describe('propiedades de evaluate(policy, profile)', () => {
  it('es puro: determinístico y no toca su entrada (perfil y política congelados)', () => {
    fc.assert(
      fc.property(policyArb, profileArb, (policy, profile) => {
        const a = evaluate(deepFreeze(policy), deepFreeze(profile))
        expect(evaluate(policy, profile)).toEqual(a)
      }),
      RUNS,
    )
  })

  it('el puntaje es la suma de los puntos, entre 0 y 100, y ninguna dimensión pasa su peso', () => {
    fc.assert(
      fc.property(policyArb, profileArb, (policy, profile) => {
        const d = evaluate(policy, profile, { counterfactuals: false })
        const sum = d.evaluation.dimensions.reduce((s, x) => s + x.points, 0)
        expect(d.score).toBeGreaterThanOrEqual(0)
        expect(d.score).toBeLessThanOrEqual(100)
        expect(Math.abs((d.score ?? 0) - sum)).toBeLessThan(0.01)
        for (const x of d.evaluation.dimensions) expect(x.points).toBeLessThanOrEqual(x.weight + 1e-9)
      }),
      RUNS,
    )
  })

  it('un tope nunca mejora el estado de la banda', () => {
    fc.assert(
      fc.property(policyArb, profileArb, (policy, profile) => {
        const d = evaluate(policy, profile, { counterfactuals: false })
        if (d.status === 'qualified' || d.status === 'qualified_with_limit') expect(FINAL_STATUS_RANK[d.status]).toBeLessThanOrEqual(FINAL_STATUS_RANK[d.band?.status ?? 'not_qualified'])
      }),
      RUNS,
    )
  })

  it('calificar implica una línea positiva que no pasa ningún término conocido', () => {
    fc.assert(
      fc.property(policyArb, profileArb, (policy, profile) => {
        const d = evaluate(policy, profile, { counterfactuals: false })
        if (d.status !== 'qualified' && d.status !== 'qualified_with_limit') {
          expect(d.limit).toBeNull()
          return
        }
        expect(d.limit).toBeGreaterThan(0)
        for (const t of d.evaluation.limit?.terms ?? []) if (t.value !== null) expect(d.limit).toBeLessThanOrEqual(t.value + 0.01)
      }),
      RUNS,
    )
  })

  it('docs/04 §5: el valor de una feature no verificada fuera de la fórmula de línea no cambia el estado', () => {
    const perturbable: FeatureName[] = ['document_age_days', 'identity_match', 'integrity_ok', 'buyer_payments_count', 'payment_capacity_pct', 'debt_service_monthly', 'recurring_income_share', 'months_of_history', 'existing_exposure_days_past_due']
    fc.assert(
      fc.property(valuesArb, valuesArb, fc.constantFrom(...perturbable), fc.constantFrom<Verification>('unverified', 'conflict'), (v1, v2, feature, verification) => {
        const a = v1[feature] ?? null
        const b = v2[feature] ?? null
        fc.pre(a !== null && b !== null)
        const p1 = build(v1, { [feature]: { verification, confidence: 1 } })
        const p2 = build({ ...v1, [feature]: b }, { [feature]: { verification, confidence: 1 } })
        expect(evaluate(BASE, p2, { counterfactuals: false }).status).toBe(evaluate(BASE, p1, { counterfactuals: false }).status)
      }),
      RUNS,
    )
  })

  it('cada next step da exactamente el resultado que anuncia', () => {
    fc.assert(
      fc.property(policyArb, profileArb, (policy, profile) => {
        const d = evaluate(policy, profile)
        for (const s of d.next_steps) {
          const changed = withFeatures(profile, [{ feature: s.feature, value: s.target_value }, ...s.related.map((r) => ({ feature: r.feature, value: r.target_value }))])
          const to = evaluate(policy, changed, { counterfactuals: false })
          // `to` is exactly what the engine gives, with its line; `from` is today's result.
          expect({ status: to.status, score: to.score, limit: to.limit }).toEqual(s.to)
          expect({ status: d.status, score: d.score, limit: d.limit }).toEqual(s.from)
          // And a step counts only if it improves the status or, for a qualifying status, raises the line.
          const better = DECISION_STATUS_RANK[to.status] > DECISION_STATUS_RANK[d.status]
          const moreLine = to.status === d.status && (to.status === 'qualified' || to.status === 'qualified_with_limit') && (to.limit ?? 0) > (d.limit ?? 0)
          expect(better || moreLine, s.code).toBe(true)
        }
      }),
      RUNS,
    )
  })

  it('con todo verificado, más ingreso nunca baja el puntaje ni el estado', () => {
    fc.assert(
      fc.property(verifiedProfileArb, money(500_000), (profile, extra) => {
        const income = profile.features.operating_income_monthly.value
        fc.pre(income !== null)
        const more = withFeatures(profile, [{ feature: 'operating_income_monthly', value: Math.round((income + extra) * 100) / 100 }])
        const a = evaluate(BASE, profile, { counterfactuals: false })
        const b = evaluate(BASE, more, { counterfactuals: false })
        expect(b.score ?? 0).toBeGreaterThanOrEqual((a.score ?? 0) - 1e-9)
        expect(DECISION_STATUS_RANK[b.status]).toBeGreaterThanOrEqual(DECISION_STATUS_RANK[a.status])
      }),
      RUNS,
    )
  })

  it('simular la política vigente contra sí misma no cambia nada', () => {
    fc.assert(
      fc.property(fc.array(profileArb, { minLength: 1, maxLength: 8 }), (profiles) => {
        const cases = profiles.map((profile, i) => ({ id: `c${String(i)}`, profile, outcome: null }))
        const r = simulatePolicy({ id: 'base', policy: BASE }, cases, { id: 'base', policy: BASE })
        expect(r.transitions).toEqual({ upgraded: 0, downgraded: 0, unchanged: profiles.length, limit_increased: 0, limit_decreased: 0 })
        expect(Object.values(r.by_status).reduce((a, b) => a + b, 0)).toBe(profiles.length)
      }),
      { numRuns: 50 },
    )
  })
})
