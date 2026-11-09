/**
 * Synthetic portfolio for simulating policies without real data: suppliers with random flows
 * (fixed seed, reproducible) and an invented outcome that worsens with payment capacity. For
 * seeing the diff between two policies, not for calibrating anything.
 */
import { emptyExternalSnapshot, type SimulationCase } from '@gow/contracts'
import { buildProfile } from '../profile.ts'
import { syntheticStatement } from './synthetic.ts'

/** mulberry32 PRNG: deterministic and good enough for demo data. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function computeSyntheticOutcome(pcp: number | null, rnd: () => number): SimulationCase['outcome'] {
  if (rnd() < 0.5) return null
  const val = pcp ?? -1
  const pBad = val < 0 ? 0.6 : val < 0.15 ? 0.3 : 0.08
  if (rnd() < pBad) return rnd() < 0.7 ? 'late' : 'default'
  return 'paid'
}

function buildSyntheticMonthly(income: number, expenses: number, debt: number, buyerShare: number, rnd: () => number, between: (min: number, max: number) => number) {
  return [
    ...(buyerShare > 0 ? [{ kind: 'customer_payment' as const, amount: Math.round(income * buyerShare), count: 2, counterparty: 'Cadena Norte SA de CV' }] : []),
    { kind: 'customer_payment' as const, amount: Math.round(income * (1 - buyerShare)), count: 4 },
    { kind: 'supplier_payment' as const, amount: Math.round(expenses * 0.7), count: 3 },
    { kind: 'payroll' as const, amount: Math.round(expenses * 0.3), count: 2 },
    ...(debt > 0 ? [{ kind: 'loan_payment' as const, amount: Math.round(debt) }] : []),
    ...(rnd() < 0.3 ? [{ kind: 'cash_deposit' as const, amount: Math.round(income * between(0.1, 0.6)) }] : []),
  ]
}

function generateSyntheticCase(i: number, seed: number, rnd: () => number, between: (min: number, max: number) => number): SimulationCase {
  const income = between(40_000, 600_000)
  const buyerShare = rnd() < 0.25 ? 0 : between(0.1, 0.6)
  const months = 1 + Math.floor(rnd() * 4)
  const expenses = income * between(0.4, 1.05)
  const debt = rnd() < 0.4 ? income * between(0.05, 0.35) : 0
  const monthly = buildSyntheticMonthly(income, expenses, debt, buyerShare, rnd, between)
  const start = ['2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01'][months - 1] ?? '2026-09-01'
  const holder = { name: `Proveedor Sintético ${String(i + 1)}`, rfc: `PSA8501${String((i % 28) + 1).padStart(2, '0')}AB1`, clabe: null }
  const s = syntheticStatement({ start, months, opening_balance: between(0, 150_000), monthly }, holder, `portfolio-${String(seed)}-${String(i)}`)
  const credits = rnd() < 0.15 ? [{ product: 'linea', balance: Math.round(income * 0.3), monthly_payment: Math.round(income * 0.05), days_past_due: rnd() < 0.4 ? 30 : 0, past_due_amount: null }] : []
  const external = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits } }
  const profile = buildProfile({
    statements: [s],
    request: { amount: Math.round(between(30_000, 300_000)), maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } },
    supplier: { legal_name: holder.name, rfc: holder.rfc, clabes: [] },
    external,
    computedAt: '2026-10-05T12:00:00.000Z',
  })
  const outcome = computeSyntheticOutcome(profile.features.payment_capacity_pct.value, rnd)
  return { id: `p${String(i + 1).padStart(3, '0')}`, profile, outcome }
}

export function syntheticPortfolio(n: number, seed = 42): SimulationCase[] {
  const rnd = prng(seed)
  const between = (min: number, max: number) => Math.round((min + rnd() * (max - min)) * 100) / 100
  const cases: SimulationCase[] = []
  for (let i = 0; i < n; i++) {
    cases.push(generateSyntheticCase(i, seed, rnd, between))
  }
  return cases
}
