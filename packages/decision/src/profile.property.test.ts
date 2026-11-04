/**
 * Propiedades del cálculo del perfil sobre estados sintéticos con flujos al azar.
 */
import type { StatementExtraction, SyntheticFlowKind } from '@gow/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildProfile } from './profile.ts'
import { syntheticStatement } from './testing/synthetic.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const KINDS: SyntheticFlowKind[] = ['customer_payment', 'sales_settlement', 'cash_deposit', 'unclassified_credit', 'loan_disbursement', 'refund', 'interest', 'supplier_payment', 'payroll', 'tax', 'fee', 'loan_payment', 'own_transfer_out', 'cash_withdrawal', 'card_purchase']

const flowArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  amount: fc.integer({ min: 100, max: 50_000_00 }).map((c) => c / 100),
  count: fc.integer({ min: 1, max: 5 }),
})
const specArb = fc.record({
  months: fc.integer({ min: 1, max: 4 }),
  monthly: fc.array(flowArb, { minLength: 1, maxLength: 8 }),
  opening_balance: fc.integer({ min: 0, max: 200_000 }),
  start: fc.constantFrom('2026-01-01', '2026-03-16', '2026-06-13'),
})

const at = (s: StatementExtraction) => `${s.accounts[0]?.periods.at(-1)?.period_end.value ?? '2026-12-31'}T12:00:00.000Z`
const profileOf = (s: StatementExtraction) => buildProfile({ statements: [s], request: null, supplier: null, computedAt: at(s) })

const MONTHLY = ['months_of_history', 'operating_income_monthly', 'operating_expenses_monthly', 'debt_service_monthly', 'free_cash_flow_monthly', 'payment_capacity_pct', 'debt_capacity', 'avg_daily_balance', 'low_balance_days', 'income_trend', 'new_debt_in_period'] as const

describe('propiedades del perfil', () => {
  it('ADR 0006: un periodo impreso o uno por mes dan las mismas features', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const single = profileOf(syntheticStatement({ ...spec, periods: 'single' }, holder, 'x'))
        const monthly = profileOf(syntheticStatement({ ...spec, periods: 'monthly' }, holder, 'x'))
        for (const f of MONTHLY) expect(single.features[f].value, f).toEqual(monthly.features[f].value)
        expect(single.features.months_of_history.value).toBe(spec.months)
      }),
      { numRuns: 100 },
    )
  })

  it('ADR 0009: agregar traspasos internos no cambia ingresos, gastos ni flujo', () => {
    fc.assert(
      fc.property(specArb, fc.integer({ min: 1, max: 1_000_000 }), (spec, amount) => {
        const s = syntheticStatement(spec, holder, 'x')
        const t = structuredClone(s)
        const p = t.accounts[0]?.periods[0]
        const t0 = p?.transactions[0]
        fc.pre(p !== undefined && t0 !== undefined)
        if (!p || !t0) return
        p.transactions.push({ ...t0, id: 'a1.p1.t9001', description: 'DEPÓSITO EN CAJITA', amount, type: 'debit', internal_transfer: true })
        p.transactions.push({ ...t0, id: 'a1.p1.t9002', description: 'RETIRO DE CAJITA', amount, type: 'credit', internal_transfer: true })
        const a = profileOf(s)
        const b = profileOf(t)
        for (const f of ['operating_income_monthly', 'operating_expenses_monthly', 'debt_service_monthly', 'free_cash_flow_monthly', 'activity_count'] as const) expect(b.features[f].value, f).toEqual(a.features[f].value)
      }),
      { numRuns: 100 },
    )
  })

  it('el orden de los movimientos dentro del periodo no cambia el perfil', () => {
    fc.assert(
      fc.property(specArb, fc.integer(), (spec, seed) => {
        const s = syntheticStatement(spec, holder, 'x')
        const shuffled = structuredClone(s)
        for (const p of shuffled.accounts[0]?.periods ?? []) {
          p.transactions = fc.sample(fc.shuffledSubarray(p.transactions, { minLength: p.transactions.length }), { numRuns: 1, seed })[0] ?? p.transactions
        }
        expect(profileOf(shuffled).features).toEqual(profileOf(s).features)
      }),
      { numRuns: 60 },
    )
  })

  it('el ingreso operativo nunca supera los abonos y el flujo libre cuadra con sus partes', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const s = syntheticStatement(spec, holder, 'x')
        const p = profileOf(s).features
        const credits = s.accounts.flatMap((a) => a.periods.flatMap((x) => x.transactions)).filter((t) => t.type === 'credit').reduce((a, t) => a + t.amount, 0)
        const days = (Date.parse(at(s).slice(0, 10)) - Date.parse(spec.start)) / 86_400_000 + 1
        const income = p.operating_income_monthly.value ?? 0
        expect(income * (days / 30.4375)).toBeLessThanOrEqual(credits + 0.05)
        const fcf = p.free_cash_flow_monthly.value
        if (fcf !== null) expect(Math.abs(fcf - (income - (p.operating_expenses_monthly.value ?? 0) - (p.debt_service_monthly.value ?? 0)))).toBeLessThanOrEqual(0.011)
        expect(p.debt_capacity.value).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 100 },
    )
  })
})
