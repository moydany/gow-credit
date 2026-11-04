import { describe, expect, it } from 'vitest'
import { StatementExtraction } from './statement.ts'
import { sampleStatement, tx } from './testing/fixtures.ts'

function issues(input: unknown) {
  const res = StatementExtraction.safeParse(input)
  if (res.success) throw new Error('se esperaba una extracción inválida')
  return res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

describe('StatementExtraction', () => {
  it('acepta varias cuentas y varios periodos (Santander, Mercado Pago)', () => {
    const doc = StatementExtraction.parse(sampleStatement())
    expect(doc.accounts).toHaveLength(2)
    expect(doc.accounts[0]?.periods).toHaveLength(2)
  })

  it('acepta valores nulos cuando el dato no está en el documento', () => {
    const doc = sampleStatement()
    doc.holder.rfc = { value: null, source: null, verification: 'unverified', confidence: 0, provenance: 'extracted' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza montos negativos: el sentido va en type', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', -10, 'debit', null))
    expect(issues(doc)).toContainEqual({ path: 'accounts.0.periods.0.transactions.2.amount', message: 'el monto no puede ser negativo; el sentido va en `type`' })
  })

  it('rechaza montos con más de dos decimales', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 10.005, 'debit', null))
    expect(issues(doc)[0]?.message).toBe('el monto debe tener a lo más dos decimales')
  })

  it('permite saldos negativos (sobregiro)', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 20000, 'debit', -6250.5))
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza fechas que no son ISO 8601', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '20/03/2026', 10, 'debit', null))
    expect(issues(doc)[0]?.path).toBe('accounts.0.periods.0.transactions.2.date')
  })

  it('exige fuente para todo valor extraído no nulo', () => {
    const doc = sampleStatement()
    doc.bank_name = { value: 'BANCO FICTICIO', source: null, verification: 'verified', confidence: 1, provenance: 'extracted' }
    expect(issues(doc)).toEqual([{ path: 'bank_name.source', message: 'un valor extraído debe citar su fuente (página y texto)' }])
  })

  it('no exige fuente a un valor aportado por el proveedor', () => {
    const doc = sampleStatement()
    doc.holder.rfc = { value: 'XAXX010101000', source: null, verification: 'unverified', confidence: 0.5, provenance: 'owner_answer' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza ids repetidos', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t1', '2026-03-20', 10, 'debit', null))
    expect(issues(doc)[0]?.message).toContain('id repetido "a1.p1.t1"')
  })

  it('rechaza una cita a una página que no existe', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 10, 'debit', null, 9))
    expect(issues(doc)[0]).toEqual({ path: 'accounts.0.periods.0.transactions.2.source.page', message: 'la página 9 no existe; el documento tiene 3' })
  })

  it('rechaza llaves que no están en el contrato', () => {
    const doc = { ...sampleStatement(), confidence_overall: 0.9 }
    expect(issues(doc)[0]?.message).toContain('confidence_overall')
  })
})
