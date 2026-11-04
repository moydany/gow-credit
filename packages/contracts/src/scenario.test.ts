import { describe, expect, it } from 'vitest'
import { emptyExternalSnapshot, ExternalSnapshot } from './external.ts'
import { Scenario } from './scenario.ts'

const minimal = {
  id: 'proveedor-nuevo-un-mes',
  catalog: 3,
  title: 'Proveedor nuevo con un mes',
  modes: ['unit'],
  as_of: '2026-10-05',
  tenant: { name: 'Fintech Demo' },
  suppliers: [
    {
      id: 'sup-1',
      name: 'Distribuidora Ficticia SA de CV',
      statements: [{ start: '2026-09-01', opening_balance: 50000, monthly: [{ kind: 'customer_payment', amount: 120000, count: 4 }] }],
      request: { amount: 50000, buyer: 'Cadena Norte' },
    },
  ],
  expect: { status: 'qualified_with_limit' },
}

describe('Scenario', () => {
  it('acepta el formato de docs/06 §3 con defaults', () => {
    const s = Scenario.parse(minimal)
    expect(s.tenant.policy).toBe('base')
    expect(s.suppliers[0]?.request).toEqual({ amount: 50000, maturity: null, buyer: { name: 'Cadena Norte', rfc: null, aliases: [] } })
    expect(s.suppliers[0]?.statements[0]).toMatchObject({ bank: 'BANCO FICTICIO', months: 1, periods: 'monthly', growth: 0, fiscal: null, reconciled: true })
    expect(s.external.existing_credits).toEqual({})
  })

  it('el modo unit exige estados sintéticos y el modo full exige PDFs', () => {
    const noStatements = { ...minimal, modes: ['unit', 'full'], suppliers: [{ ...minimal.suppliers[0], statements: [] }] }
    const res = Scenario.safeParse(noStatements)
    expect(res.error?.issues.map((i) => i.path.join('.'))).toEqual(['suppliers.0.statements', 'suppliers.0.documents'])
  })

  it('rechaza un expect sobre un proveedor que no existe', () => {
    const res = Scenario.safeParse({ ...minimal, expect: { status: 'qualified', supplier: 'sup-9' } })
    expect(res.error?.issues[0]?.message).toBe('proveedor desconocido "sup-9"')
  })

  it('valida las features esperadas contra el catálogo', () => {
    expect(Scenario.safeParse({ ...minimal, expect: { status: 'qualified', features: { months_of_history: 1 } } }).success).toBe(true)
    expect(Scenario.safeParse({ ...minimal, expect: { status: 'qualified', features: { ventas: 1 } } }).success).toBe(false)
  })
})

describe('ExternalSnapshot', () => {
  it('sin adaptadores todas las fuentes quedan no disponibles', () => {
    const snap = ExternalSnapshot.parse(emptyExternalSnapshot())
    expect(Object.values(snap).every((s) => !s.available)).toBe(true)
  })

  it('el monto vencido de un crédito vigente es opcional', () => {
    const snap = emptyExternalSnapshot()
    const parsed = ExternalSnapshot.parse({
      ...snap,
      existing_credits: { available: true, simulated: true, credits: [{ product: 'linea_pronto_pago', balance: 120000, monthly_payment: 30000, days_past_due: 0 }] },
    })
    expect(parsed.existing_credits.credits[0]?.past_due_amount).toBeNull()
  })
})
