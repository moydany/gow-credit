import { DOCUMENT_AGE_WARNING, type Profile } from '@gow/contracts'
import { sampleProfile } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { maxLine } from '../max-line.ts'
import { simulatePolicy } from '../simulate.ts'
import { basePolicyTemplate } from '../template.ts'
import { withFeatures } from './counterfactuals.ts'
import { documentAgeWarning, evaluate, withoutDocumentAgeGates } from './evaluate.ts'

const policy = basePolicyTemplate()

/** Perfil sano para la política base (puntaje 100, sin topes), con la antigüedad que se pida. */
function profile(age: number | null): Profile {
  return sampleProfile({
    document_age_days: age,
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
  })
}

const warningOf = (d: ReturnType<typeof evaluate>) => d.reasons.filter((r) => r.code === DOCUMENT_AGE_WARNING)

describe('antigüedad del estado de cuenta como ajuste del tenant (ADR 0049)', () => {
  it('sin ajuste (standalone) la compuerta de la política sigue pidiendo un estado reciente', () => {
    const d = evaluate(policy, profile(120))
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['recent_statement'])
    expect(warningOf(d)).toEqual([])
  })

  it('con el ajuste, un documento más viejo se analiza normal y lleva la advertencia', () => {
    const d = evaluate(policy, profile(120), { statementAge: { max_months: 3 } })
    expect([d.status, d.score, d.limit]).toEqual(['qualified', 100, 150000])
    expect(d.clarification).toBeNull()
    expect(d.evaluation.gates.map((g) => g.id)).not.toContain('doc_recent')
    expect(d.next_steps.map((s) => s.feature)).not.toContain('document_age_days')
    const [w] = warningOf(d)
    expect(w?.features).toEqual(['document_age_days'])
    expect(w?.message).toBe('Advertencia: el estado de cuenta tiene 120 días desde su corte más reciente, más que la antigüedad máxima de 3 meses (90 días) que fija la configuración del prestamista. Se analizó igual, sin pedir uno más reciente.')
  })

  it('el umbral es el del tenant, no el de la política: meses de 30 días', () => {
    expect(warningOf(evaluate(policy, profile(90), { statementAge: { max_months: 3 } }))).toEqual([])
    expect(warningOf(evaluate(policy, profile(91), { statementAge: { max_months: 3 } }))).toHaveLength(1)
    expect(warningOf(evaluate(policy, profile(45), { statementAge: { max_months: 1 } }))).toHaveLength(1)
    expect(warningOf(evaluate(policy, profile(200), { statementAge: { max_months: 12 } }))).toEqual([])
    expect(warningOf(evaluate(policy, profile(400), { statementAge: { max_months: 12 } }))[0]?.message).toContain('12 meses (360 días)')
  })

  it('"sin límite" no advierte nunca, ni sin fecha de corte', () => {
    for (const age of [10, 400, null]) {
      const d = evaluate(policy, profile(age), { statementAge: { max_months: null } })
      expect(d.status, String(age)).toBe('qualified')
      expect(warningOf(d)).toEqual([])
    }
  })

  it('sin fecha de corte, con límite, se analiza y advierte que no se pudo calcular', () => {
    const d = evaluate(policy, profile(null), { statementAge: { max_months: 3 } })
    expect(d.status).toBe('qualified')
    expect(warningOf(d)[0]?.message).toMatch(/^Advertencia: no se pudo calcular la antigüedad/)
  })

  it('la advertencia no cambia el resultado de un perfil que no califica', () => {
    const p = withFeatures(profile(150), [{ feature: 'existing_exposure_days_past_due', value: 30 }])
    const d = evaluate(policy, p, { statementAge: { max_months: 2 } })
    expect(d.status).toBe('not_qualified')
    expect(warningOf(d)).toHaveLength(1)
  })

  it('solo quita las compuertas de antigüedad; sin ellas devuelve la misma política', () => {
    const relaxed = withoutDocumentAgeGates(policy)
    expect(relaxed.gates.map((g) => g.id)).toEqual(policy.gates.filter((g) => g.id !== 'doc_recent').map((g) => g.id))
    expect(withoutDocumentAgeGates(relaxed)).toBe(relaxed)
    expect(documentAgeWarning(profile(10), { max_months: 3 })).toBeNull()
  })

  it('la línea máxima ya no queda condicionada a un estado reciente', () => {
    const p = withFeatures(profile(120), [{ feature: 'requested_amount', value: null }])
    expect(maxLine(policy, p)?.conditional_on).toEqual(['doc_recent'])
    expect(maxLine(policy, p, { statementAge: { max_months: 3 } })?.conditional_on).toEqual([])
  })

  it('la simulación usa el mismo ajuste', () => {
    const cases = [{ id: 'a', profile: profile(120), outcome: null }]
    expect(simulatePolicy({ id: 'p', policy }, cases).by_status.needs_clarification).toBe(1)
    expect(simulatePolicy({ id: 'p', policy }, cases, null, { statementAge: { max_months: 3 } }).by_status.qualified).toBe(1)
  })
})
