/**
 * The example policies in policies/examples/ are valid, and the standalone evaluation one only
 * changes what it says: an identity that cannot be compared does not block; one that mismatches does.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { emptyExternalSnapshot, parsePolicy, type ApplicationRequest, type DocumentFlag, type ExternalSnapshot, type Issue, type Policy, type StatementExtraction } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import { decide } from './decide.ts'
import { basePolicyTemplate } from './template.ts'
import { syntheticStatement } from './testing/synthetic.ts'

const EXAMPLES = new URL('../../../policies/examples/', import.meta.url)

function load(file: string): Policy {
  const r = parsePolicy(JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8')))
  if (!r.ok) throw new Error(r.message)
  return r.policy
}

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const request: ApplicationRequest = { amount: 50000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }
const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
const statement = syntheticStatement({ start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 90000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 40000 }] }, holder, 'pol1')
const AT = '2026-10-05T12:00:00.000Z'

describe('políticas de ejemplo', () => {
  it.each(readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')))('%s es válida', (file) => {
    expect(load(file).version).toBeGreaterThan(0)
  })

  it('evaluación standalone: es la base sin la compuerta de antigüedad (ninguna compara identidad; la antigüedad no decide)', () => {
    const policy = load('standalone-evaluation.v1.json')
    const base = basePolicyTemplate()
    expect({ ...policy, name: base.name, description: base.description }).toEqual({ ...base, gates: base.gates.filter((g) => g.id !== 'doc_recent') })
    expect(base.gates.some((g) => g.id === 'doc_recent')).toBe(true)
    expect(policy.gates.some((g) => g.when.feature === 'document_age_days')).toBe(false)
    for (const p of [policy, base, load('fiscal-anchors.v1.json')]) expect(p.gates.some((g) => g.when.feature === 'identity_match')).toBe(false)
  })

  it('sin proveedor registrado no se pregunta la identidad', () => {
    const input = { statements: [statement], request, supplier: null, external: noCredits, computedAt: AT }
    const d = decide({ ...input, policy: basePolicyTemplate() }).decision
    expect(d.clarification?.topics ?? []).not.toContain('identity_fields')
    expect(d.status).toBe('qualified_with_limit')
  })

  it('una identidad que no coincide se informa pero no cambia la decisión', () => {
    const other = { legal_name: 'Otra Empresa SA de CV', rfc: 'OEM900101AB1', clabes: [] }
    const d = decide({ statements: [statement], request, supplier: other, external: noCredits, computedAt: AT, policy: basePolicyTemplate() }).decision
    expect(d.profile.features.identity_match.value).toBe('mismatch')
    expect(d.status).toBe('qualified_with_limit')
    expect(d.clarification?.topics ?? []).not.toContain('identity_fields')
  })
})

describe('robustez documental en las políticas', () => {
  const policies: [string, Policy][] = [
    ['plantilla base', basePolicyTemplate()],
    ['evaluación standalone', load('standalone-evaluation.v1.json')],
    ['anclas fiscales', load('fiscal-anchors.v1.json')],
  ]

  const spec = { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment' as const, amount: 90000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment' as const, amount: 40000 }] }
  const issue = (code: Issue['code'], extra: Partial<Issue> = {}): Issue => ({ id: 'i1', code, severity: 'warning', message: 'problema de prueba', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: {}, ...extra })

  /** A statement with what extraction would leave: flags and issues set by hand. */
  function withSignals(flags: DocumentFlag[], issues: Issue[], reconciled = true): StatementExtraction {
    const s = syntheticStatement({ ...spec, reconciled }, holder, `sig-${flags.join('-')}-${String(reconciled)}`)
    return { ...s, flags: [...s.flags, ...flags], issues }
  }

  const run = (policy: Policy, s: StatementExtraction) => decide({ policy, statements: [s], request, supplier: null, external: noCredits, computedAt: AT }).decision

  it.each(policies)('%s tiene las dos compuertas: páginas completas y sin señales de manipulación', (_, policy) => {
    expect(policy.gates.find((g) => g.id === 'pages_complete')).toMatchObject({
      when: { feature: 'document_pages_missing', op: '==', value: false },
      onFail: { status: 'needs_clarification', ask: 'missing_pages' },
      onUnknown: 'pass',
    })
    expect(policy.gates.find((g) => g.id === 'no_tamper_signals')).toMatchObject({
      when: { feature: 'document_tamper_signals', op: 'empty' },
      onFail: { status: 'human_review' },
      onUnknown: 'pass',
    })
  })

  it.each(policies)('%s: un documento sin señales sigue calificando', (_, policy) => {
    const d = run(policy, withSignals([], []))
    expect(d.status).toBe('qualified_with_limit')
    expect(d.profile.features.document_pages_missing.value).toBe(false)
    expect(d.profile.features.document_tamper_signals.value).toEqual([])
  })

  it.each(policies)('%s: páginas faltantes con el descuadre que causan → pide el PDF completo, no revisión humana', (_, policy) => {
    const d = run(policy, withSignals(['pages_missing'], [issue('page_missing', { severity: 'warning', details: { missing: [2], total: 3 } })], false))
    expect(d.profile.features.integrity_ok.value).toBe(false)
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['missing_pages'])
  })

  it.each(policies)('%s: texto dirigido al sistema → revisión humana', (_, policy) => {
    const d = run(policy, withSignals(['possible_prompt_injection'], [issue('possible_prompt_injection')]))
    expect(d.profile.features.document_tamper_signals.value).toEqual(['prompt_injection'])
    expect(d.status).toBe('human_review')
    expect(d.reasons.map((r) => r.code)).toContain('gate_no_tamper_signals')
  })

  it.each(policies)('%s: una página repetida → revisión humana aunque ya cuadre', (_, policy) => {
    const d = run(policy, withSignals(['pages_duplicated'], [issue('duplicate_page_removed', { page: 2, details: { same_as: 1 } })]))
    expect(d.profile.features.integrity_ok.value).toBe(true)
    expect(d.status).toBe('human_review')
  })
})

describe('estado de cuenta con domicilio', () => {
  const spec = { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment' as const, amount: 90000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment' as const, amount: 40000 }] }
  const statement = (address: string | null) => syntheticStatement(spec, { ...holder, address }, `dom-${String(address)}`)
  const run = (policy: Policy, s: StatementExtraction) => decide({ policy, statements: [s], request, supplier: null, external: noCredits, computedAt: AT }).decision
  const base = basePolicyTemplate()
  const requiring: Policy = { ...base, gates: [...base.gates, { id: 'holder_address', description: 'El estado de cuenta trae el domicilio del titular', when: { feature: 'holder_address_present', op: '==', value: true }, onFail: { status: 'needs_clarification', ask: 'statement_with_address' }, onUnknown: 'pass' }] }

  it('la plantilla base no lo exige: sin domicilio no se pregunta nada', () => {
    expect(base.gates.some((g) => g.when.feature === 'holder_address_present')).toBe(false)
    const d = run(base, statement(null))
    expect(d.clarification?.topics ?? []).not.toContain('statement_with_address')
    expect(d.status).toBe('qualified_with_limit')
  })

  it('con la compuerta activada y sin domicilio, pide un estado de cuenta que lo traiga', () => {
    expect(parsePolicy(requiring).ok).toBe(true)
    const d = run(requiring, statement(null))
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toEqual(['statement_with_address'])
  })

  it('con la compuerta activada y con domicilio, pasa', () => {
    const d = run(requiring, statement('CALLE 5 DE MAYO 12, CENTRO, PUEBLA, PUE., C.P. 72000'))
    expect(d.status).toBe('qualified_with_limit')
  })
})
