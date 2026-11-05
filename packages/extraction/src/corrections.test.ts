import { sampleStatement } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { applyCorrections, CorrectionError, readValue } from './corrections.ts'

const tx = (id: string, field: 'amount' | 'type' | 'date') => ({ kind: 'transaction' as const, transaction_id: id, field })

describe('applyCorrections: la corrección de un analista sobre la extracción', () => {
  it('no cambia la extracción original y marca el valor como confirmado por el analista', () => {
    const x = sampleStatement()
    const before = JSON.stringify(x)
    const fixed = applyCorrections(x, [{ target: { kind: 'holder', field: 'name' }, value: 'PROVEEDOR REAL SA DE CV' }])
    expect(JSON.stringify(x)).toBe(before)
    expect(fixed.holder.name).toMatchObject({ value: 'PROVEEDOR REAL SA DE CV', verification: 'verified', provenance: 'analyst_answer', confidence: 1 })
  })

  it('corregir un monto recalcula el cuadre del periodo y quita las alertas de cuadre resueltas', () => {
    const x = sampleStatement()
    // El modelo leyó mal un cargo: el periodo deja de cuadrar contra el saldo final impreso.
    const p1 = x.accounts[0]?.periods[0]
    if (!p1) throw new Error('fixture')
    const wrong = structuredClone(x)
    const wp = wrong.accounts[0]?.periods[0]
    if (!wp) throw new Error('fixture')
    const t2 = wp.transactions[1]
    if (!t2) throw new Error('fixture')
    t2.amount = 9999
    wrong.issues.push({ id: 'i1', code: 'reconciliation_mismatch', severity: 'error', message: 'no cuadra', page: 1, path: null, account_id: 'a1', period_id: 'a1.p1', transaction_id: null, details: {} })
    wrong.flags.push('reconciliation_failed')
    const broken = applyCorrections(wrong, [{ target: tx('a1.p1.t1', 'amount'), value: 5000 }])
    expect(broken.accounts[0]?.periods[0]?.reconciliation?.status).toBe('not_reconciled')

    const fixed = applyCorrections(wrong, [{ target: tx('a1.p1.t2', 'amount'), value: 1250.5 }])
    expect(fixed.accounts[0]?.periods[0]?.reconciliation?.status).toBe('reconciled')
    expect(fixed.accounts[0]?.periods[0]?.transactions[1]).toMatchObject({ amount: 1250.5, verification: 'verified', provenance: 'analyst_answer' })
    expect(fixed.issues.some((i) => i.code === 'reconciliation_mismatch')).toBe(false)
    expect(fixed.flags).not.toContain('reconciliation_failed')
  })

  it('una cifra del resumen corregida queda verificada y entra al cuadre', () => {
    const fixed = applyCorrections(sampleStatement(), [{ target: { kind: 'period', period_id: 'a1.p1', field: 'closing_balance' }, value: 1 }])
    expect(fixed.accounts[0]?.periods[0]?.summary.closing_balance).toMatchObject({ value: 1, provenance: 'analyst_answer' })
    expect(fixed.accounts[0]?.periods[0]?.reconciliation?.status).toBe('not_reconciled')
  })

  it('lee el valor actual para guardarlo como "valor leído"', () => {
    const x = sampleStatement()
    expect(readValue(x, { kind: 'holder', field: 'rfc' })).toBe('XAXX010101000')
    expect(readValue(x, tx('a1.p1.t2', 'amount'))).toBe(1250.5)
    expect(readValue(x, { kind: 'period', period_id: 'a1.p1', field: 'opening_balance' })).toBe(10000)
  })

  it('rechaza valores del tipo equivocado y blancos que no existen', () => {
    const x = sampleStatement()
    expect(() => applyCorrections(x, [{ target: tx('a1.p1.t1', 'amount'), value: -5 }])).toThrow(CorrectionError)
    expect(() => applyCorrections(x, [{ target: tx('a1.p1.t1', 'date'), value: '5 de marzo' }])).toThrow(/AAAA-MM-DD/)
    expect(() => applyCorrections(x, [{ target: tx('no-existe', 'amount'), value: 10 }])).toThrow(/no existe/)
    expect(() => applyCorrections(x, [{ target: { kind: 'holder', field: 'rfc' }, value: 'ABC' }])).toThrow(/RFC/)
    expect(() => applyCorrections(x, [{ target: { kind: 'account', account_id: 'a1', field: 'clabe' }, value: '012345678901234567' }])).toThrow(/CLABE/)
  })

  it('sin correcciones devuelve la misma extracción', () => {
    const x = sampleStatement()
    expect(applyCorrections(x, [])).toBe(x)
  })
})
