import { emptyExternalSnapshot, ScenarioExternal, type ApplicationRequest, type ExternalSnapshot, type StatementExtraction, type SupplierIdentity, type SyntheticStatement } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { decide, type DecideInput } from './decide.ts'
import { gatherExternal } from './external/ports.ts'
import { simulatedPorts } from './external/simulated.ts'
import { basePolicyTemplate } from './template.ts'
import { syntheticStatement } from './testing/synthetic.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const request: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }
const AT = '2026-10-05T12:00:00.000Z'

const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }

function stmt(monthly: z.input<typeof SyntheticStatement>['monthly']): StatementExtraction {
  return syntheticStatement({ start: '2026-09-01', opening_balance: 20000, monthly }, holder, 'd1')
}

function input(statements: StatementExtraction[], patch: Partial<DecideInput> = {}): DecideInput {
  return { policy: basePolicyTemplate(), policyId: 'gow-base.v1', statements, request, supplier, external: noCredits, computedAt: AT, ...patch }
}

const WEAK = [
  { kind: 'customer_payment' as const, amount: 60000, counterparty: 'Cadena Norte SA de CV' },
  { kind: 'supplier_payment' as const, amount: 30000 },
]

describe('decide: abonos grandes inciertos (docs/03 §7)', () => {
  it('pregunta por un depósito en efectivo grande si puede cambiar la banda', () => {
    const r = decide(input([stmt([...WEAK, { kind: 'cash_deposit', amount: 150000 }])]))
    const d = r.decision
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['deposit_classification'])
    expect(d.clarification?.transactions).toEqual([{ document_sha256: r.ledger.documents[0]?.sha256, transaction_id: r.asked[0]?.tx.id }])
    expect(d.reasons.map((x) => x.code)).toContain('deposit_clarification')
    expect(d.next_steps[0]).toMatchObject({ code: 'classify_deposits', feature: 'operating_income_monthly', from: { status: 'not_qualified' }, to: { status: 'qualified_with_limit' } })
    expect(d.limit).toBeNull()
  })

  it('no pregunta si la respuesta no cambia la banda', () => {
    const strong = [{ kind: 'customer_payment' as const, amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment' as const, amount: 30000 }]
    const d = decide(input([stmt([...strong, { kind: 'cash_deposit', amount: 150000 }])])).decision
    expect(d.status).toBe('qualified_with_limit')
    expect(d.reasons.map((x) => x.code)).not.toContain('deposit_clarification')
  })

  it('no pregunta por abonos chicos', () => {
    const d = decide(input([stmt([...WEAK, { kind: 'cash_deposit', amount: 10000 }])])).decision
    expect(d.status).toBe('not_qualified')
  })

  it('un préstamo con confianza media también se pregunta', () => {
    const r = decide(input([stmt([...WEAK, { kind: 'loan_disbursement', amount: 150000 }])]))
    expect(r.decision.status).toBe('needs_clarification')
    expect(r.asked.map((x) => x.classification.category)).toEqual(['loan_disbursement'])
  })

  it('sin rondas disponibles va a revisión humana', () => {
    const d = decide(input([stmt([...WEAK, { kind: 'cash_deposit', amount: 150000 }])], { clarificationRoundsUsed: 1 })).decision
    expect(d.status).toBe('human_review')
    expect(d.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['deposit_clarification', 'clarification_rounds_exhausted']))
  })

  it('con atraso no hay pregunta que valga: no califica', () => {
    const atrasado: ExternalSnapshot = { ...noCredits, existing_credits: { available: true, simulated: true, credits: [{ product: 'linea', balance: 50000, monthly_payment: 5000, days_past_due: 30, past_due_amount: 10000 }] } }
    const d = decide(input([stmt([...WEAK, { kind: 'cash_deposit', amount: 150000 }])], { external: atrasado })).decision
    expect(d.status).toBe('not_qualified')
  })

  it('la respuesta del dueño entra con su procedencia y resuelve la pregunta', () => {
    const s = stmt([...WEAK, { kind: 'cash_deposit', amount: 150000 }])
    const asked = decide(input([s])).asked[0]
    const answered = structuredClone(s)
    for (const t of answered.accounts[0]?.periods[0]?.transactions ?? []) {
      if (t.id === asked?.tx.id) t.classification = { category: 'customer_payment', confidence: 1, counterparty: null, counterparty_rfc: null, classifier: 'owner_answer' }
    }
    const d = decide(input([answered], { clarificationRoundsUsed: 1 })).decision
    expect(d.status).toBe('qualified_with_limit')
    expect(d.profile.features.operating_income_monthly.provenance).toBe('owner_answer')
  })
})

describe('fuentes externas simuladas (docs/06 §2)', () => {
  const uuid = 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B'
  const external = ScenarioExternal.parse({
    existing_credits: { 'sup-1': [{ product: 'linea_pronto_pago', balance: 120000, monthly_payment: 30000, days_past_due: 0 }] },
    bureau: { 'sup-1': { score: 640, open_accounts: 3 } },
    sat: { 'sup-1': { rfc_valid: true, compliance_opinion: 'positive', list_status: 'clear' } },
    cfdi: { [uuid]: 'cancelled' },
    sat_lists: { CUN850101AB1: 'efos_definitive' },
    program: { 'CADENA NORTE SA DE CV': 250000 },
    history: { 'sup-1': { statement_reuse: [{ uuid, application_id: 'app-1' }], seen_elsewhere: [{ uuid, days_ago: 3 }] } },
  })

  it('arma el snapshot con todo marcado como simulado', async () => {
    const s = syntheticStatement(
      { start: '2026-09-01', opening_balance: 0, monthly: [{ kind: 'customer_payment', amount: 1000, counterparty: 'Cliente Uno', counterparty_rfc: 'CUN850101AB1' }], fiscal: { uuid, regime: '601' } },
      holder,
      'e1',
    )
    const snap = await gatherExternal(simulatedPorts(external, { asOf: '2026-10-05' }), { supplierId: 'sup-1', supplier, request, statements: [s] }, ['CUN850101AB1'])
    expect(Object.values(snap).every((x) => x.available && x.simulated)).toBe(true)
    expect(snap.existing_credits.credits[0]?.past_due_amount).toBeNull()
    expect(snap.tax_authority.cfdi).toEqual([{ uuid, status: 'cancelled' }])
    expect(snap.tax_authority.listed_counterparties).toEqual([{ rfc: 'CUN850101AB1', list_status: 'efos_definitive' }])
    expect(snap.program.available_limit).toBe(250000)
    expect(snap.internal.seen_elsewhere).toEqual([{ uuid, seen_on: '2026-10-02' }])
  })

  it('sin RFC del receptor el CFDI no se consulta: queda null, nunca not_found (docs/09 §6)', async () => {
    const s = syntheticStatement({ start: '2026-09-01', opening_balance: 0, monthly: [{ kind: 'fee', amount: 100 }], holder_redacted: true, fiscal: { uuid, regime: '601' } }, holder, 'e2')
    const snap = await gatherExternal(simulatedPorts(external, { asOf: '2026-10-05' }), { supplierId: 'sup-1', supplier: null, request: null, statements: [s] })
    expect(snap.tax_authority.cfdi).toEqual([])
  })

  it('un puerto que falla deja su fuente no disponible y la solicitud sigue', async () => {
    const ports = { ...simulatedPorts(external, { asOf: '2026-10-05' }), creditBureau: { simulated: false, reportOf: () => Promise.reject(new Error('caído')) } }
    const snap = await gatherExternal(ports, { supplierId: 'sup-1', supplier, request, statements: [] })
    expect(snap.credit_bureau).toEqual({ available: false, simulated: false, report: null })
    expect(snap.existing_credits.available).toBe(true)
  })
})
