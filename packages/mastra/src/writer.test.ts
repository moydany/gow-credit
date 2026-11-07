import { emptyExternalSnapshot, FEATURE_NAMES, type ApplicationRequest, type ExternalSnapshot, type NextStep, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate, decide } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { ZERO_USAGE, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { checkFigures } from './figures.ts'
import { buildQuestions } from './questions.ts'
import { nextStepFacts, nextStepTemplate, Writer } from './writer.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const request: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }
const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
const statement = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
  holder,
  'w1',
)

function decision(computedAt = '2026-10-05T12:00:00.000Z', sup: SupplierIdentity | null = supplier) {
  return decide({ policy: basePolicyTemplate(), statements: [statement], request, supplier: sup, external: noCredits, computedAt }).decision
}

/** Devuelve, por llamada, los textos que se le den; registra cuántas veces la llamaron. */
class ScriptedLlm implements StructuredLlm {
  calls = 0
  constructor(readonly script: ((ids: string[]) => { id: string; text: string }[])[]) {}
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const ids = [...req.instruction.matchAll(/"id": "([a-z0-9]+)"/g)].map((m) => m[1] ?? '')
    const step = this.script[this.calls] ?? (() => [])
    this.calls++
    return Promise.resolve({ object: req.schema.parse({ texts: step(ids) }), usage: ZERO_USAGE, costUsd: 0.0001, latencyMs: 1, model: req.model, finishReason: 'stop', responseCacheHit: false })
  }
}

describe('preguntas', () => {
  it('una pregunta por abono incierto, con hechos y opciones; la plantilla pasa el filtro', () => {
    const d = decision()
    expect(d.status).toBe('needs_clarification')
    const qs = buildQuestions(d, [statement])
    expect(qs.map((q) => [q.id, q.kind, q.topic])).toEqual([['q1', 'deposit', 'deposit_classification']])
    expect(qs[0]?.options.map((o) => o.value)).toContain('customer_payment')
    for (const q of qs) expect(checkFigures(q.text, q.facts)).toEqual({ ok: true, unsupported: [] })
  })

  it('documento viejo y sin proveedor registrado: pide estado reciente, no la identidad (ADR 0052)', () => {
    const d = decision('2027-06-01T12:00:00.000Z', null)
    const qs = buildQuestions(d, [statement])
    expect(qs.map((q) => q.topic)).toContain('recent_statement')
    expect(qs.map((q) => q.topic)).not.toContain('identity_fields')
    for (const q of qs) expect(checkFigures(q.text, q.facts).ok).toBe(true)
    expect(qs.find((q) => q.topic === 'recent_statement')?.facts.map((f) => f.name)).toEqual(['fecha_de_corte_mas_reciente', 'dias_desde_el_corte', 'dias_maximos'])
  })

  it('sin aclaración pendiente no hay preguntas', () => {
    const d = decide({ policy: basePolicyTemplate(), statements: [statement], request, supplier, external: noCredits, computedAt: '2026-10-05T12:00:00.000Z', clarificationRoundsUsed: 2 }).decision
    expect(buildQuestions(d, [statement])).toEqual([])
  })
})

describe('redacción con filtro de cifras', () => {
  const qs = buildQuestions(decision(), [statement])

  it('usa el texto del modelo si pasa el filtro', async () => {
    const llm = new ScriptedLlm([(ids) => ids.map((id) => ({ id, text: '¿Ese abono fue un pago de cliente, un préstamo, un traspaso tuyo, intereses u otra cosa?' }))])
    const r = await new Writer(llm).questions(qs)
    expect(r.questions[0]?.text_source).toBe('writer')
    expect(llm.calls).toBe(1)
  })

  it('una cifra inventada se regenera una vez y, si persiste, queda la plantilla', async () => {
    const llm = new ScriptedLlm([(ids) => ids.map((id) => ({ id, text: 'El abono de $999,999.00 ¿qué fue?' })), (ids) => ids.map((id) => ({ id, text: 'Sigue: $1.00' }))])
    const r = await new Writer(llm).questions(qs)
    expect(llm.calls).toBe(2)
    expect(r.questions[0]).toEqual(qs[0])
  })

  it('la segunda vuelta corrige y se usa', async () => {
    const llm = new ScriptedLlm([(ids) => ids.map((id) => ({ id, text: 'El abono de $999,999.00 ¿qué fue?' })), (ids) => ids.map((id) => ({ id, text: '¿Qué fue ese abono?' }))])
    const r = await new Writer(llm).questions(qs)
    expect(r.questions[0]?.text).toBe('¿Qué fue ese abono?')
  })

  it('sin modelo, plantillas; si el modelo falla, también', async () => {
    expect((await new Writer(null).questions(qs)).questions).toEqual(qs)
    const failing: StructuredLlm = { call: () => Promise.reject(new Error('sin red')) }
    const r = await new Writer(failing).questions(qs)
    expect([r.questions, r.errors]).toEqual([qs, ['sin red']])
  })

  it('cada next_step tiene texto y la plantilla pasa el filtro', async () => {
    const d = decision()
    expect(d.next_steps.length).toBeGreaterThan(0)
    const r = await new Writer(null).nextSteps(d.next_steps)
    for (const s of r.next_steps) {
      expect(s.message).not.toBeNull()
      expect(checkFigures(s.message ?? '', nextStepFacts(s))).toEqual({ ok: true, unsupported: [] })
    }
  })

  it('la plantilla de next_steps pasa el filtro para cualquier feature numérica', () => {
    for (const feature of FEATURE_NAMES) {
      const step: NextStep = { code: 'improve_x', feature, current_value: 0.35, target_value: 12345.67, related: [], from: { status: 'not_qualified', score: 41.5, limit: null }, to: { status: 'qualified_with_limit', score: 55, limit: 45000.5 }, message: null }
      expect(checkFigures(nextStepTemplate(step), nextStepFacts(step)).unsupported, feature).toEqual([])
    }
  })
})
