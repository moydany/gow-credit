/**
 * Preguntas nuevas al proveedor (ADR 0050): cargos dudosos, cliente principal, uso de la cuenta de
 * una persona física y cuentas en otra moneda.
 */
import { emptyExternalSnapshot, type ApplicationRequest, type ExternalSnapshot, type OwnerDeclarations, type Question, type StatementExtraction, type SupplierIdentity, type SyntheticStatement, type TransactionClassification } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { applyOwnerAnswers } from './answers.ts'
import { decide, type DecideInput } from './decide.ts'
import { basePolicyTemplate } from './template.ts'
import { syntheticStatement } from './testing/synthetic.ts'

const AT = '2026-10-05T12:00:00.000Z'
const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
const moral = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const fisica = { name: 'Juana Pérez Ficticia', rfc: 'PEFJ800101AB1', clabe: null }
const buyer = { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] }
const withBuyer: ApplicationRequest = { amount: 100000, maturity: null, buyer }
const noBuyer: ApplicationRequest = { amount: 100000, maturity: null, buyer: null }
const declared = (d: Partial<OwnerDeclarations>): OwnerDeclarations => ({ buyer: null, account_use: null, answered: [], ...d })

/** Tres meses, para que el tope por poca historia no tape lo que se prueba. */
function stmt(monthly: z.input<typeof SyntheticStatement>['monthly'], who = moral, seed = 'q1'): StatementExtraction {
  return syntheticStatement({ start: '2026-07-01', months: 3, opening_balance: 400000, monthly }, who, seed)
}

function input(statements: StatementExtraction[], patch: Partial<DecideInput> = {}): DecideInput {
  const who = statements[0]?.holder
  const supplier: SupplierIdentity = { legal_name: who?.name.value ?? moral.name, rfc: who?.rfc.value ?? null, clabes: [] }
  return { policy: basePolicyTemplate(), policyId: 'gow-base.v1', statements, request: withBuyer, supplier, external: noCredits, computedAt: AT, ...patch }
}

/** La clasificación que dejaría el modelo de movimientos sobre los cargos con este monto. */
function classify(s: StatementExtraction, amount: number, c: Omit<TransactionClassification, 'counterparty' | 'counterparty_rfc'>): StatementExtraction {
  const out = structuredClone(s)
  for (const p of out.accounts[0]?.periods ?? []) for (const t of p.transactions) if (t.type === 'debit' && t.amount === amount) t.classification = { ...c, counterparty: null, counterparty_rfc: null }
  return out
}

/** Contesta lo mismo a todos los cargos que pregunta `decide`. */
function answerCharges(s: StatementExtraction, category: 'own_transfer' | 'personal_expense') {
  const refs = decide(input([s])).decision.clarification?.transactions ?? []
  const questions: Question[] = refs.map((ref, i) => ({ id: `q${String(i + 1)}`, topic: 'charge_classification', kind: 'charge', transaction: ref, facts: [], options: [], text: 'x', text_source: 'template' }))
  return applyOwnerAnswers({ statements: [s], supplier: null, request: withBuyer, questions, answers: questions.map((q) => ({ question_id: q.id, kind: 'charge' as const, category, counterparty: null })) })
}

const INCOME = [
  { kind: 'customer_payment' as const, amount: 300000, count: 2, counterparty: 'Cadena Norte SA de CV' },
  { kind: 'supplier_payment' as const, amount: 50000 },
]

describe('cargos dudosos (ADR 0050)', () => {
  // El caso real: lo tomado como pagos a créditos se come el ingreso y no hay línea.
  const heavy = classify(stmt([...INCOME, { kind: 'supplier_payment', amount: 280000, description: 'SPEI ENVIADO OPERADORA DEL VALLE' }]), 280000, { category: 'loan_payment', confidence: 0.6, classifier: 'claude-haiku-5-5' })

  it('pregunta por un cargo grande tomado como pago de crédito con confianza baja si puede cambiar el resultado', () => {
    const r = decide(input([heavy]))
    const d = r.decision
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['charge_classification'])
    expect(r.asked.map((x) => x.type)).toEqual(['debit', 'debit', 'debit'])
    expect(d.reasons.map((x) => x.code)).toContain('charge_clarification')
    expect(d.next_steps[0]).toMatchObject({ code: 'classify_charges', feature: 'free_cash_flow_monthly', from: { status: 'not_qualified' } })
  })

  it('no pregunta por un pago de crédito que la regla reconoce con confianza (una respuesta distinta lo contradiría)', () => {
    const d = decide(input([stmt([...INCOME, { kind: 'loan_payment', amount: 280000 }])])).decision
    expect(d.status).toBe('not_qualified')
    expect(d.reasons.map((x) => x.code)).not.toContain('charge_clarification')
  })

  it('no pregunta por cargos dudosos que no cambian la banda', () => {
    const small = classify(stmt([...INCOME, { kind: 'supplier_payment', amount: 20000, description: 'SPEI ENVIADO OPERADORA DEL VALLE' }]), 20000, { category: 'loan_payment', confidence: 0.6, classifier: 'claude-haiku-5-5' })
    const d = decide(input([small])).decision
    expect(d.reasons.map((x) => x.code)).not.toContain('charge_clarification')
  })

  it('sin rondas disponibles va a revisión humana', () => {
    // La plantilla permite dos rondas (ADR 0051): con las dos usadas ya no se pregunta.
    const d = decide(input([heavy], { clarificationRoundsUsed: 2 })).decision
    expect(d.status).toBe('human_review')
    expect(d.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['charge_clarification', 'clarification_rounds_exhausted']))
  })

  it('la respuesta reclasifica el cargo y se recalcula el flujo', () => {
    const applied = answerCharges(heavy, 'own_transfer')
    expect(applied.contradictions).toEqual([])
    const after = decide(input(applied.statements, { clarificationRoundsUsed: 1 })).decision
    expect(after.profile.features.debt_service_monthly.value).toBe(0)
    expect(['qualified', 'qualified_with_limit']).toContain(after.status)
  })

  it('"gasto personal" queda como salida de dinero, no como deuda', () => {
    const applied = answerCharges(heavy, 'personal_expense')
    const after = decide(input(applied.statements, { clarificationRoundsUsed: 1 })).decision
    expect(after.profile.features.debt_service_monthly.value).toBe(0)
    const before = decide(input([heavy])).decision.profile.features
    expect(after.profile.features.operating_expenses_monthly.value).toBeGreaterThan(before.operating_expenses_monthly.value as number)
    expect(after.profile.features.free_cash_flow_monthly.value).toBe(before.free_cash_flow_monthly.value)
  })

  it('contradice al documento si cambia de grupo contra una clasificación confiable', () => {
    const sure = classify(heavy, 280000, { category: 'loan_payment', confidence: 0.9, classifier: 'jev-1.13.0' })
    const tx = sure.accounts[0]?.periods[0]?.transactions.find((t) => t.type === 'debit' && t.amount === 280000)
    if (!tx) throw new Error('sin cargo')
    const q: Question = { id: 'q1', topic: 'charge_classification', kind: 'charge', transaction: { document_sha256: sure.document.sha256, transaction_id: tx.id }, facts: [], options: [], text: 'x', text_source: 'template' }
    const own = applyOwnerAnswers({ statements: [sure], supplier: null, request: withBuyer, questions: [q], answers: [{ question_id: 'q1', kind: 'charge', category: 'own_transfer', counterparty: null }] })
    expect(own.contradictions).toHaveLength(1)
    // Entre gastos (proveedor u otra cosa) no hay contradicción: el flujo no cambia.
    const fee = classify(heavy, 280000, { category: 'fee', confidence: 0.95, classifier: 'jev-1.13.0' })
    const q2 = { ...q, transaction: { document_sha256: fee.document.sha256, transaction_id: tx.id } }
    expect(applyOwnerAnswers({ statements: [fee], supplier: null, request: withBuyer, questions: [q2], answers: [{ question_id: 'q1', kind: 'charge', category: 'supplier_payment', counterparty: null }] }).contradictions).toEqual([])
  })
})

describe('cliente principal (ADR 0050)', () => {
  const healthy = stmt([
    { kind: 'customer_payment', amount: 300000, count: 2, counterparty: 'Cadena Norte SA de CV' },
    { kind: 'supplier_payment', amount: 120000 },
  ])

  it('sin comprador en la solicitud pregunta por el cliente principal si sus pagos moverían la banda', () => {
    const d = decide(input([healthy], { request: noBuyer })).decision
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['main_buyer'])
    expect(d.reasons.map((x) => x.code)).toContain('main_buyer_clarification')
  })

  it('sin solicitud (línea máxima) no pregunta: el comprador no se evalúa por diseño', () => {
    const d = decide(input([healthy], { request: null })).decision
    expect(d.clarification?.topics ?? []).not.toContain('main_buyer')
  })

  it('con comprador en la solicitud no pregunta', () => {
    const d = decide(input([healthy])).decision
    expect(d.clarification?.topics ?? []).not.toContain('main_buyer')
  })

  it('el nombre que da el dueño es el comprador del análisis, con su procedencia', () => {
    const q: Question = { id: 'q1', topic: 'main_buyer', kind: 'buyer', transaction: null, facts: [], options: [], text: 'x', text_source: 'template' }
    const applied = applyOwnerAnswers({ statements: [healthy], supplier: null, request: noBuyer, questions: [q], answers: [{ question_id: 'q1', kind: 'buyer', name: 'Cadena Norte SA de CV' }] })
    expect(applied.declarations).toEqual(declared({ buyer: 'Cadena Norte SA de CV', answered: ['main_buyer'] }))
    const d = decide(input([healthy], { request: noBuyer, declarations: applied.declarations, clarificationRoundsUsed: 1 })).decision
    expect(d.profile.features.buyer_payments_count).toMatchObject({ value: 6, provenance: 'owner_answer' })
    expect(d.profile.inputs.request?.buyer?.name).toBe('Cadena Norte SA de CV')
    expect(d.profile.inputs.declarations.buyer).toBe('Cadena Norte SA de CV')
    expect(d.status).toBe('qualified')
  })

  it('tras un "no sé" no se vuelve a preguntar', () => {
    const d = decide(input([healthy], { request: noBuyer, declarations: declared({ answered: ['main_buyer'] }) })).decision
    expect(d.clarification?.topics ?? []).not.toContain('main_buyer')
  })

  it('sin rondas disponibles se decide sin el comprador (no va a revisión)', () => {
    const d = decide(input([healthy], { request: noBuyer, clarificationRoundsUsed: 2 })).decision
    expect(d.status).toBe('qualified_with_limit')
  })
})

describe('uso de la cuenta de una persona física (ADR 0050)', () => {
  // Transferencias de terceros sin RFC ni comprador: se presumen pago de cliente (0.75).
  const pf = stmt(
    [
      { kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' },
      { kind: 'customer_payment', amount: 240000, count: 6 },
      { kind: 'supplier_payment', amount: 90000 },
    ],
    fisica,
    'pf',
  )

  it('pregunta si la cuenta también es personal cuando eso cambia el resultado', () => {
    const d = decide(input([pf])).decision
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['account_use'])
    expect(d.reasons.map((x) => x.code)).toContain('account_use_clarification')
  })

  it('a una persona moral no se le pregunta', () => {
    const pm = stmt(
      [
        { kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' },
        { kind: 'customer_payment', amount: 240000, count: 6 },
        { kind: 'supplier_payment', amount: 90000 },
      ],
      moral,
      'pm',
    )
    expect(decide(input([pm])).decision.clarification?.topics ?? []).not.toContain('account_use')
  })

  it('"solo negocio" deja el análisis como está; "mixta" deja fuera las transferencias presumidas', () => {
    const business = decide(input([pf], { declarations: declared({ account_use: 'business_only', answered: ['account_use'] }), clarificationRoundsUsed: 1 })).decision
    const mixed = decide(input([pf], { declarations: declared({ account_use: 'mixed', answered: ['account_use'] }), clarificationRoundsUsed: 1 })).decision
    const income = (d: typeof business) => d.profile.features.operating_income_monthly.value as number
    expect(income(mixed) / income(business)).toBeCloseTo(0.2, 3)
    expect(mixed.profile.inputs.declarations.account_use).toBe('mixed')
    expect(business.clarification).toBeNull()
  })
})

describe('otra moneda (ADR 0050)', () => {
  it('una cuenta en dólares no se mezcla con pesos: revisión humana con motivo', () => {
    const usd = structuredClone(stmt(INCOME))
    const account = usd.accounts[0]
    if (!account) throw new Error('sin cuenta')
    account.currency = { ...account.currency, value: 'USD' }
    const d = decide(input([usd])).decision
    expect(d.status).toBe('human_review')
    expect(d.reasons.at(-1)?.code).toBe('foreign_currency_statement')
    expect(d.reasons.at(-1)?.message).toMatch(/USD/)
  })
})
