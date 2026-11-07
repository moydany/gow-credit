/**
 * Las políticas de ejemplo de policies/examples/ son válidas, y la de evaluación standalone solo
 * cambia lo que dice: identidad que no se puede comparar no bloquea; una que no coincide, sí.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { emptyExternalSnapshot, parsePolicy, type ApplicationRequest, type ExternalSnapshot, type Policy } from '@gow/contracts'
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

  it('evaluación standalone: es la base sin la compuerta de antigüedad (ADR 0052: ninguna compara identidad; ADR 0054: la antigüedad no decide)', () => {
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
