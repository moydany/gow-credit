import type { FeatureName, Profile, Verification } from '@gow/contracts'
import { sampleProfile } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { basePolicyTemplate, clonePolicy } from '../template.ts'
import { withFeatures } from './counterfactuals.ts'
import { evaluate } from './evaluate.ts'

type Values = Parameters<typeof sampleProfile>[0]

/** Healthy profile for the base policy (score 100, no caps). */
const HEALTHY: Values = {
  document_age_days: 10,
  identity_match: 'match',
  integrity_ok: true,
  red_flags: [],
  existing_exposure_days_past_due: 0,
  existing_exposure_balance: 0,
  operating_income_monthly: 300000,
  requested_amount: 100000,
  buyer_payments_count: 4,
  payment_capacity_pct: 0.5,
  debt_service_monthly: 15000,
  recurring_income_share: 0.6,
  months_of_history: 6,
  debt_capacity: 450000,
}

function profile(values: Values = {}, meta: Partial<Record<FeatureName, { verification?: Verification; confidence?: number }>> = {}): Profile {
  const p = sampleProfile({ ...HEALTHY, ...values })
  for (const [name, m] of Object.entries(meta) as [FeatureName, { verification?: Verification; confidence?: number }][]) Object.assign(p.features[name], m)
  return p
}

/** A step that changes nothing for the supplier: same status and the line does not go up. */
const changesNothing = (s: { from: { status: string; limit: number | null }; to: { status: string; limit: number | null } }) => s.from.status === s.to.status && (s.to.limit ?? 0) <= (s.from.limit ?? 0)

describe('contrafactuales: cuentan solo si cambian el estado o suben la línea', () => {
  const base = basePolicyTemplate()
  // The base no longer caps by history: these cases use a policy that does.
  const monthsCap = (() => {
    const raw = structuredClone(base)
    raw.decision.caps = [{ when: { feature: 'months_of_history', op: '<', value: 3 }, maxStatus: 'qualified_with_limit' }, ...raw.decision.caps]
    return clonePolicy(raw, { version: 2 })
  })()

  // One month of history (cap at "califica con límite") and a score of 66.5, in the 25% band.
  // Improving buyer payments lifts the score to the "califica" band, but the cap leaves status and
  // line exactly the same: it used to be proposed anyway ("de califica con límite a califica con límite").
  const capped = profile({ months_of_history: 1, operating_income_monthly: 150000, buyer_payments_count: 1 })

  it('un puntaje que cambia de banda con un tope que deja estado y línea iguales no es un paso', () => {
    const d = evaluate(monthsCap, capped)
    expect([d.status, d.score, d.band?.index, d.limit]).toEqual(['qualified_with_limit', 66.5, 1, 37500])
    expect(d.next_steps.filter(changesNothing)).toEqual([])
    expect(d.next_steps.map((s) => s.feature)).not.toContain('buyer_payments_count')
    // What used to be proposed does raise the score band and changes nothing for the supplier.
    const buyer2 = evaluate(monthsCap, withFeatures(capped, [{ feature: 'buyer_payments_count', value: 2 }]), { counterfactuals: false })
    expect([buyer2.band?.index, buyer2.status, buyer2.limit]).toEqual([0, 'qualified_with_limit', 37500])
  })

  it('el tope que sí cambia el estado sigue siendo un paso, con la línea de antes y de después', () => {
    const d = evaluate(monthsCap, profile({ months_of_history: 1 }))
    expect(d.next_steps[0]).toMatchObject({ code: 'cap_months_of_history', from: { status: 'qualified_with_limit', limit: 75000 }, to: { status: 'qualified', limit: 150000 } })
  })

  it('un estado que no califica lleva línea null en from; el paso que lo hace calificar, la línea del motor en to', () => {
    const d = evaluate(base, profile({ document_age_days: 120 }))
    expect(d.next_steps[0]).toMatchObject({ code: 'pass_gates', from: { status: 'needs_clarification', limit: null }, to: { status: 'qualified', limit: 150000 } })
  })

  it('el mismo estado con más línea sí cuenta', () => {
    // Two qualifying bands: the upper gives 50% and the lower 20%. Raising income moves the score
    // to the upper band and the line goes up without changing status.
    const raw = structuredClone(base)
    raw.decision.caps = []
    raw.decision.bands = [
      { min: 85, status: 'qualified', limit: { pctOf: 'operating_income_monthly', pct: 50 } },
      { min: 50, status: 'qualified', limit: { pctOf: 'operating_income_monthly', pct: 20 } },
      { min: 0, status: 'not_qualified' },
    ]
    const policy = clonePolicy(raw, { version: 2 })
    const p = profile({ operating_income_monthly: 150000, buyer_payments_count: 1 })
    const d = evaluate(policy, p)
    expect([d.status, d.score, d.limit]).toEqual(['qualified', 66.5, 30000])
    const step = d.next_steps.find((s) => s.code === 'improve_capacity')
    if (!step) throw new Error('sin paso improve_capacity')
    expect(step).toMatchObject({ from: { status: 'qualified', limit: 30000 }, to: { status: 'qualified' } })
    expect(step.to.limit).toBeGreaterThan(30000)
    // What it announces is what the engine gives.
    const to = evaluate(policy, withFeatures(p, [{ feature: step.feature, value: step.target_value }, ...step.related.map((r) => ({ feature: r.feature, value: r.target_value }))]), { counterfactuals: false })
    expect({ status: to.status, score: to.score, limit: to.limit }).toEqual(step.to)
  })
})
