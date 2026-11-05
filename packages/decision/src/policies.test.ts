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

  it('evaluación standalone: es la base salvo la compuerta de identidad', () => {
    const policy = load('standalone-evaluation.v1.json')
    const base = basePolicyTemplate()
    expect({ ...policy, name: base.name, description: base.description, gates: base.gates }).toEqual(base)
    expect(policy.gates.find((g) => g.id === 'identity')?.onUnknown).toBe('pass')
    expect(policy.gates.filter((g) => g.id !== 'identity')).toEqual(base.gates.filter((g) => g.id !== 'identity'))
  })

  it('sin proveedor registrado, la base pregunta y la de evaluación decide', () => {
    const input = { statements: [statement], request, supplier: null, external: noCredits, computedAt: AT }
    expect(decide({ ...input, policy: basePolicyTemplate() }).decision.clarification?.topics).toContain('identity_fields')
    const d = decide({ ...input, policy: load('standalone-evaluation.v1.json') }).decision
    expect(d.evaluation.gates.find((g) => g.id === 'identity')).toMatchObject({ outcome: 'unknown', effect: 'none' })
    expect(d.status).toBe('qualified_with_limit')
  })

  it('una identidad que se compara y no coincide sigue pidiendo aclaración', () => {
    const other = { legal_name: 'Otra Empresa SA de CV', rfc: 'OEM900101AB1', clabes: [] }
    const d = decide({ statements: [statement], request, supplier: other, external: noCredits, computedAt: AT, policy: load('standalone-evaluation.v1.json') }).decision
    expect(d.status).toBe('needs_clarification')
    expect(d.clarification?.topics).toContain('identity_fields')
  })
})
