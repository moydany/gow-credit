import { describe, expect, it } from 'vitest'
import { Decision } from './decision.ts'
import { sampleProfile } from './testing/fixtures.ts'

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    status: 'qualified_with_limit',
    limit: 90000,
    score: 62.5,
    band: { index: 1, min: 50, status: 'qualified_with_limit' },
    policy: { id: 'gow-base', version: 1 },
    profile: sampleProfile({ operating_income_monthly: 360000, months_of_history: 1 }),
    evaluation: {
      gates: [{ id: 'no_arrears', feature: 'existing_exposure_days_past_due', op: '<=', threshold: 0, value: 0, outcome: 'pass', effect: 'none', ask: null }],
      dimensions: [{ id: 'capacity', feature: 'operating_income_monthly', relative_to: 'requested_amount', value: 2, normalized: 0.6, weight: 35, points: 21, used: true, excluded_reason: null }],
      caps: [{ index: 0, feature: 'months_of_history', applied: true, max_status: 'qualified_with_limit' }],
      limit: { formula: 'min(band, debt_capacity - existing_exposure_balance)', terms: [{ term: 'band', value: 90000 }, { term: 'debt_capacity - existing_exposure_balance', value: 150000 }], value: 90000 },
    },
    reasons: [{ code: 'existing_exposure', message: 'La línea se reduce por el crédito vigente.', features: ['existing_exposure_balance'] }],
    next_steps: [
      {
        code: 'more_history',
        feature: 'months_of_history',
        current_value: 1,
        target_value: 3,
        from: { status: 'qualified_with_limit', score: 62.5 },
        to: { status: 'qualified', score: 62.5 },
        message: null,
      },
    ],
    clarification: null,
    engine_version: '0.1.0',
    decided_at: '2026-11-04T12:00:00.000Z',
    ...overrides,
  }
}

describe('Decision', () => {
  it('acepta un veredicto completo con diagnóstico y contrafactuales', () => {
    expect(Decision.safeParse(decision()).success).toBe(true)
  })

  it('needs_clarification exige decir qué se pregunta', () => {
    const res = Decision.safeParse(decision({ status: 'needs_clarification', limit: null, clarification: null }))
    expect(res.error?.issues.map((i) => i.message)).toEqual(['needs_clarification exige decir qué se pregunta'])
  })

  it('un estado que califica exige línea', () => {
    const res = Decision.safeParse(decision({ status: 'qualified', limit: null }))
    expect(res.error?.issues[0]?.path).toEqual(['limit'])
  })
})
