/**
 * Piezas puras de la fase 5 (ADR 0015): etiquetas del modelo encima de las reglas, línea máxima
 * sin monto solicitado y respuestas del dueño. Datos sintéticos.
 */
import { emptyExternalSnapshot, type ApplicationRequest, type ExternalSnapshot, type Question, type StatementExtraction, type SupplierIdentity } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import { applyOwnerAnswers, withContradictions } from './answers.ts'
import { combineClassification, needsModel, transactionsForModel, withModelLabels, UNCALIBRATED_ALONE_CONFIDENCE } from './classify/combine.ts'
import { classifyByRules } from './classify/rules.ts'
import { decide } from './decide.ts'
import { evaluate } from './engine/evaluate.ts'
import { withFeatures } from './engine/counterfactuals.ts'
import { maxLine } from './max-line.ts'
import { buildProfile } from './profile.ts'
import { basePolicyTemplate } from './template.ts'
import { syntheticStatement } from './testing/synthetic.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const AT = '2026-10-05T12:00:00.000Z'
const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
const ctx = { holderName: null, holderRfc: null, bankTokens: [], buyer: null }

function rule(description: string, type: 'credit' | 'debit' = 'credit') {
  return classifyByRules({ description, reference: null, type, internal_transfer: false }, ctx)
}

describe('etiquetas del modelo encima de las reglas', () => {
  it('al modelo solo van los movimientos que las reglas no resuelven con confianza', () => {
    expect(needsModel(rule('COMISION MANEJO DE CUENTA', 'debit'))).toBe(false)
    expect(needsModel(rule('SPEI RECIBIDO OPERACION 1'))).toBe(true)
    expect(needsModel(rule('B123 45'))).toBe(true)
    expect(needsModel(classifyByRules({ description: 'X', reference: null, type: 'credit', internal_transfer: true }, ctx))).toBe(false)
  })

  it('Jev (calibrado): si coincide, la mayor confianza; si no, la suya', () => {
    const r = rule('SPEI RECIBIDO OPERACION 1')
    expect(combineClassification(r, { transaction_id: 't', category: 'customer_payment', confidence: 0.6 }, { model: 'jev-1.13.0', calibrated: true }).confidence).toBe(0.75)
    const loan = combineClassification(r, { transaction_id: 't', category: 'loan_disbursement', confidence: 0.83 }, { model: 'jev-1.13.0', calibrated: true })
    expect([loan.category, loan.confidence, loan.classifier]).toEqual(['loan_disbursement', 0.83, 'jev-1.13.0'])
  })

  it('Haiku (no calibrado): su confianza no cuenta; solo suma si coincide con una regla con palabra clave', () => {
    const info = { model: 'claude-haiku-5-5', calibrated: false }
    expect(combineClassification(rule('SPEI RECIBIDO OPERACION 1'), { transaction_id: 't', category: 'customer_payment', confidence: 0.99 }, info).confidence).toBe(0.8)
    expect(combineClassification(rule('B123 45'), { transaction_id: 't', category: 'customer_payment', confidence: 0.99 }, info).confidence).toBe(UNCALIBRATED_ALONE_CONFIDENCE)
    expect(combineClassification(rule('SPEI RECIBIDO OPERACION 1'), { transaction_id: 't', category: 'loan_disbursement', confidence: 0.99 }, info).confidence).toBe(UNCALIBRATED_ALONE_CONFIDENCE)
  })

  it('escribe solo en las filas candidatas y no toca lo ya clasificado', () => {
    const s = syntheticStatement({ start: '2026-09-01', opening_balance: 0, monthly: [{ kind: 'unclassified_credit', amount: 5000 }, { kind: 'fee', amount: 100 }] }, holder, 'c1')
    const candidates = transactionsForModel(s, null)
    expect(candidates.length).toBeGreaterThan(0)
    const labels = [...candidates.map((c) => ({ transaction_id: c.tx.id, category: 'customer_payment' as const, confidence: 0.92 })), { transaction_id: 'no-existe', category: 'other' as const, confidence: 1 }]
    const out = withModelLabels(s, null, labels, { model: 'jev-1.13.0', calibrated: true })
    const classified = out.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions)).filter((t) => t.classification !== null)
    expect(classified.map((t) => t.id).sort()).toEqual(candidates.map((c) => c.tx.id).sort())
    expect(transactionsForModel(out, null)).toEqual([])
    expect(s.accounts[0]?.periods[0]?.transactions.every((t) => t.classification === null)).toBe(true)
  })
})

describe('línea máxima sin monto solicitado', () => {
  const statements = [0, 1, 2].map((i) =>
    syntheticStatement({ start: `2026-0${String(6 + i)}-01`, opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 90000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 40000 }] }, holder, `m${String(i)}`),
  )
  const request: ApplicationRequest = { amount: null, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }
  const profile = buildProfile({ statements, request, supplier, external: noCredits, computedAt: AT })
  const policy = basePolicyTemplate()

  it('sin monto la capacidad no suma; la línea máxima sí sale', () => {
    expect(profile.features.requested_amount.value).toBeNull()
    const line = maxLine(policy, profile)
    expect(line).not.toBeNull()
    expect(line?.conditional_on).toEqual([])
    expect(line?.amount).toBeGreaterThan(0)
  })

  it('pedir la línea máxima califica; un peso más ya no alcanza', () => {
    const line = maxLine(policy, profile)
    if (!line) throw new Error('sin línea')
    const at = evaluate(policy, withFeatures(profile, [{ feature: 'requested_amount', value: line.amount }]), { counterfactuals: false })
    expect(['qualified', 'qualified_with_limit']).toContain(at.status)
    expect(at.limit ?? 0).toBeGreaterThanOrEqual(line.amount)
    const above = evaluate(policy, withFeatures(profile, [{ feature: 'requested_amount', value: line.amount + 1 }]), { counterfactuals: false })
    expect(above.limit === null || above.limit < line.amount + 1 || !['qualified', 'qualified_with_limit'].includes(above.status)).toBe(true)
  })

  it('una compuerta que pide aclaración queda como condición', () => {
    const old = buildProfile({ statements, request, supplier, external: noCredits, computedAt: '2027-06-01T12:00:00.000Z' })
    expect(maxLine(policy, old)?.conditional_on).toEqual(['doc_recent'])
  })

  it('una compuerta que rechaza la anula', () => {
    const late: ExternalSnapshot = { ...noCredits, existing_credits: { available: true, simulated: true, credits: [{ product: 'linea', balance: 1000, monthly_payment: 100, days_past_due: 15, past_due_amount: 100 }] } }
    expect(maxLine(policy, buildProfile({ statements, request, supplier, external: late, computedAt: AT }))).toBeNull()
  })
})

describe('respuestas del dueño', () => {
  const request: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }
  const s = syntheticStatement(
    { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
    holder,
    'a1',
  )
  const base = decide({ policy: basePolicyTemplate(), statements: [s], request, supplier, external: noCredits, computedAt: AT })
  const ref = base.decision.clarification?.transactions[0] ?? null
  const q = (id: string, kind: Question['kind'], transaction: Question['transaction'] = null): Question => ({ id, topic: kind === 'deposit' ? 'deposit_classification' : 'identity_fields', kind, transaction, facts: [], options: [], text: 'pregunta', text_source: 'template' })

  it('un abono respondido entra como owner_answer y la solicitud se resuelve', () => {
    expect(base.decision.status).toBe('needs_clarification')
    const r = applyOwnerAnswers({ statements: [s], supplier, request, questions: [q('q1', 'deposit', ref)], answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }] })
    expect(r.applied).toHaveLength(1)
    const d = decide({ policy: basePolicyTemplate(), statements: r.statements, request, supplier, external: noCredits, computedAt: AT, clarificationRoundsUsed: 1 }).decision
    expect(d.status).toBe('qualified_with_limit')
    expect(d.profile.features.operating_income_monthly.provenance).toBe('owner_answer')
  })

  it('rechaza ids desconocidos, tipos que no corresponden y respuestas repetidas', () => {
    const r = applyOwnerAnswers({
      statements: [s],
      supplier,
      request,
      questions: [q('q1', 'deposit', ref)],
      answers: [
        { question_id: 'q9', kind: 'decline', note: null },
        { question_id: 'q1', kind: 'identity', legal_name: 'X', rfc: null, clabe: null },
        { question_id: 'q1', kind: 'deposit', category: 'other', counterparty: null },
        { question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null },
      ],
    })
    expect(r.rejected.map((x) => x.question_id)).toEqual(['q9', 'q1', 'q1'])
    expect(r.applied).toHaveLength(1)
  })

  it('una respuesta que contradice una clasificación confiable no se mergea y manda a revisión', () => {
    const loan = syntheticStatement({ start: '2026-09-01', opening_balance: 0, monthly: [{ kind: 'loan_disbursement', amount: 150000 }] }, holder, 'a2')
    const tx = loan.accounts[0]?.periods[0]?.transactions.find((t) => t.type === 'credit')
    if (!tx) throw new Error('sin abono')
    const sure: StatementExtraction = structuredClone(loan)
    const t0 = sure.accounts[0]?.periods[0]?.transactions.find((t) => t.id === tx.id)
    if (t0) t0.classification = { category: 'loan_disbursement', confidence: 0.85, counterparty: null, counterparty_rfc: null, classifier: 'jev-1.13.0' }
    const r = applyOwnerAnswers({ statements: [sure], supplier, request, questions: [q('q1', 'deposit', { document_sha256: sure.document.sha256, transaction_id: tx.id })], answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }] })
    expect(r.contradictions).toHaveLength(1)
    expect(r.statements[0]).toBe(sure)
    const d = withContradictions(base.decision, r.contradictions)
    expect(d.status).toBe('human_review')
    expect(d.reasons.at(-1)?.code).toBe('owner_answer_contradicts_document')
  })

  it('la identidad declarada solo cuenta si no había una registrada', () => {
    const answer = { question_id: 'q2', kind: 'identity' as const, legal_name: 'Otra Empresa SA', rfc: 'OEM900101AB1', clabe: null }
    expect(applyOwnerAnswers({ statements: [s], supplier: null, request, questions: [q('q2', 'identity')], answers: [answer] }).supplier).toEqual({ legal_name: 'Otra Empresa SA', rfc: 'OEM900101AB1', clabes: [] })
    expect(applyOwnerAnswers({ statements: [s], supplier, request, questions: [q('q2', 'identity')], answers: [answer] }).supplier).toBe(supplier)
    const noName = applyOwnerAnswers({ statements: [s], supplier: null, request, questions: [q('q2', 'identity')], answers: [{ ...answer, legal_name: null }] })
    expect([noName.supplier, noName.rejected.length]).toEqual([null, 1])
  })
})
