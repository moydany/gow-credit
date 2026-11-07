import { emptyExternalSnapshot, type ApplicationRequest, type Decision, type ExternalSnapshot, type StatementExtraction } from '@gow/contracts'
import { basePolicyTemplate, decide } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { describe, expect, it } from 'vitest'
import { renderMessage } from './channels.ts'
import { checkFigures } from './figures.ts'
import { ACCOUNT_USE_OPTIONS, buildQuestions, CHARGE_OPTIONS, identityQuestion } from './questions.ts'

const base = { id: 'q1', topic: 'identity_fields' as const, transaction: null, options: [], text_source: 'template' as const }
const withEvidence = (evidence: string[]) => ({ profile: { features: { identity_match: { evidence } } } }) as unknown as Decision
const fact = (q: ReturnType<typeof identityQuestion>, name: string) => q.facts.find((f) => f.name === name)?.value

describe('pregunta de identidad (ADR 0043 y 0044)', () => {
  it('dice qué coincidió y qué no se pudo comparar, y pide solo lo que falta', () => {
    const q = identityQuestion(base, withEvidence(['D1:holder.name=match']))
    expect(q.text).toBe('Revisamos a quién pertenece la cuenta de tu estado de cuenta: el nombre del titular coincide con tus datos registrados; el RFC no se pudo comparar (en el estado de cuenta viene oculto o incompleto, o no lo tenemos registrado). ¿Nos confirmas el RFC del titular de la cuenta?')
    expect(fact(q, 'pedir')).toBe('rfc')
  })

  it('un campo que no coincide se nombra y se pide', () => {
    const q = identityQuestion(base, withEvidence(['D1:holder.name=match', 'D1:F1.receiver.rfc=mismatch']))
    expect(q.text).toMatch(/el nombre del titular coincide con tus datos registrados; el RFC no coincide\. ¿Nos confirmas el RFC del titular de la cuenta\?$/)
    expect(fact(q, 'pedir')).toBe('rfc')
  })

  it('la CLABE no se pregunta aunque venga en la evidencia', () => {
    const q = identityQuestion(base, withEvidence(['D1:holder.name=match', 'D1:A1.clabe=mismatch', 'D1:holder.rfc=root']))
    expect(q.text).not.toMatch(/CLABE/)
    expect(fact(q, 'pedir')).toBeNull()
  })

  it('sin evidencia (no hay proveedor registrado) pide nombre y RFC', () => {
    const q = identityQuestion(base, withEvidence([]))
    expect(q.text).toBe('No tenemos datos registrados para confirmar a quién pertenece la cuenta de tu estado de cuenta. ¿Nos confirmas la razón social o el nombre del titular y el RFC?')
    expect(fact(q, 'pedir')).toBe('name,rfc')
  })
})

describe('preguntas nuevas al proveedor (ADR 0050)', () => {
  const AT = '2026-10-05T12:00:00.000Z'
  const external: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
  const moral = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
  const run = (s: StatementExtraction, request: ApplicationRequest) =>
    decide({ policy: basePolicyTemplate(), statements: [s], request, supplier: { legal_name: s.holder.name.value ?? 'X', rfc: s.holder.rfc.value, clabes: [] }, external, computedAt: AT }).decision
  const synth = (monthly: Parameters<typeof syntheticStatement>[0]['monthly'], who = moral) => syntheticStatement({ start: '2026-07-01', months: 3, opening_balance: 400000, monthly }, who, 'qx')
  const buyer: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }

  it('un cargo dudoso se pregunta con monto, fecha, concepto y las cinco opciones', () => {
    const s = structuredClone(synth([{ kind: 'customer_payment', amount: 300000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 50000 }, { kind: 'supplier_payment', amount: 280000, description: 'SPEI ENVIADO OPERADORA DEL VALLE' }]))
    for (const p of s.accounts[0]?.periods ?? []) for (const t of p.transactions) if (t.amount === 280000) t.classification = { category: 'loan_payment', confidence: 0.6, counterparty: null, counterparty_rfc: null, classifier: 'claude-haiku-5-5' }
    const qs = buildQuestions(run(s, buyer), [s])
    expect(qs.map((q) => q.kind)).toEqual(['charge', 'charge', 'charge'])
    const q = qs[0]
    expect(q?.options).toEqual(CHARGE_OPTIONS)
    expect(q?.text).toMatch(/^Tu estado de cuenta muestra un cargo de \$280,000\.00 el .+ con el concepto "SPEI ENVIADO OPERADORA DEL VALLE"\. ¿Qué fue\?/)
    expect(q?.facts.map((f) => f.name)).toEqual(['fecha', 'monto', 'concepto'])
  })

  it('sin comprador, el cliente principal se pregunta en texto libre; a una persona física, el uso de la cuenta', () => {
    const fisica = { name: 'Juana Pérez Ficticia', rfc: 'PEFJ800101AB1', clabe: null }
    const s = synth([{ kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'customer_payment', amount: 240000, count: 6 }, { kind: 'supplier_payment', amount: 90000 }], fisica)
    const qs = buildQuestions(run(s, { ...buyer, buyer: null }), [s])
    expect(qs.map((q) => [q.id, q.topic, q.kind])).toEqual([
      ['q1', 'main_buyer', 'buyer'],
      ['q2', 'account_use', 'account_use'],
    ])
    expect(qs[0]?.options).toEqual([])
    expect(qs[0]?.text).toMatch(/cliente principal/)
    expect(qs[1]?.options).toEqual(ACCOUNT_USE_OPTIONS)
    expect(qs[1]?.text).toBe('¿Usas esta cuenta solo para tu negocio o también para gastos personales?')
  })
})

describe('páginas faltantes: la pregunta pide el PDF completo (robustez documental, sección W)', () => {
  // El motor pide el tema `missing_pages`; aquí solo importa a qué se parece la pregunta.
  const asking = { status: 'needs_clarification', clarification: { topics: ['missing_pages'], transactions: [] }, evaluation: { gates: [] } } as unknown as Decision
  const withIssue = (details: Record<string, unknown> | null): StatementExtraction => {
    const s = syntheticStatement({ start: '2026-07-01', opening_balance: 400000, monthly: [{ kind: 'customer_payment', amount: 60000 }] }, { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }, 'mp1')
    const issue = { id: 'pm1', code: 'page_missing', severity: 'warning', message: 'Faltan páginas', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: details ?? {} } as StatementExtraction['issues'][number]
    return { ...s, flags: ['pages_missing'], issues: details ? [issue] : [] }
  }

  it('dice qué página falta con un ejemplo cuando la extracción la conoce', () => {
    const [q, ...rest] = buildQuestions(asking, [withIssue({ missing: [2], total: 3 })])
    expect(rest).toEqual([])
    expect(q).toMatchObject({ id: 'q1', topic: 'missing_pages', kind: 'documents', transaction: null, options: [], text_source: 'template' })
    expect(q?.text).toBe('Al estado de cuenta que mandaste le faltan páginas (por ejemplo la 2 de 3). ¿Nos mandas el PDF completo?')
    expect(q?.facts).toEqual([{ name: 'pagina_faltante', value: 2 }, { name: 'paginas_del_documento', value: 3 }])
    // La plantilla pasa el filtro de cifras que el redactor aplica después.
    expect(checkFigures(q?.text ?? '', q?.facts ?? [])).toEqual({ ok: true, unsupported: [] })
  })

  it('con varias páginas faltantes cita la primera; sin el dato, solo dice que faltan', () => {
    expect(buildQuestions(asking, [withIssue({ missing: [5, 2, 4], total: 9 })])[0]?.text).toMatch(/\(por ejemplo la 2 de 9\)/)
    for (const details of [null, { missing: 'la 2', total: 3 }, { missing: [], total: 3 }]) {
      const q = buildQuestions(asking, [withIssue(details)])[0]
      expect(q?.text).toBe('Al estado de cuenta que mandaste le faltan páginas. ¿Nos mandas el PDF completo?')
      expect(q?.facts).toEqual([])
    }
  })

  it('en standalone el mensaje al proveedor lleva la pregunta (el <id>.ronda-N.txt)', () => {
    const qs = buildQuestions(asking, [withIssue({ missing: [2], total: 3 })])
    expect(renderMessage(qs)).toContain('1. Al estado de cuenta que mandaste le faltan páginas (por ejemplo la 2 de 3). ¿Nos mandas el PDF completo?')
  })
})
