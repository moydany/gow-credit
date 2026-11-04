import { describe, expect, it } from 'vitest'
import { isAmount, parseAmountText, type Line } from './layout.ts'
import { checkChain, type ParsedRow } from './parse-table.ts'
import { columnAmounts, groupRows } from './table.ts'

const line = (page: number, y: number, segs: [number, number, string][]): Line => ({ page, y, segments: segs.map(([x, x2, str]) => ({ x, x2, str })), text: segs.map((s) => s[2]).join(' | ') })

describe('montos impresos', () => {
  it('reconoce y convierte las formas de los bancos', () => {
    expect(['1,250.50', '-$865.12', '+$65.00', '$ -2,200.00', '(1,234.00)'].every(isAmount)).toBe(true)
    expect(isAmount('3108250Pago')).toBe(false)
    expect(parseAmountText('$ -2,200.00')).toBe(-2200)
    expect(parseAmountText('+$65.00')).toBe(65)
    expect(parseAmountText('(1,234.00)')).toBe(-1234)
  })
})

describe('tablas', () => {
  it('asigna el monto a la columna por su borde derecho', () => {
    const l = line(1, 100, [[10, 30, '01'], [400, 417, '4.61'], [540, 572, '13,426.01']])
    expect(columnAmounts(l, { debit: 417, credit: 497, balance: 572 }).map((a) => a.column)).toEqual(['debit', 'balance'])
  })
  it('agrupa una descripción centrada en vertical con su fecha (Mercado Pago)', () => {
    const lines = [line(1, 104, [[94, 190, 'Transferencia enviada']]), line(1, 111, [[42, 82, '25-06-2026'], [305, 338, '$ -2,200.00']]), line(1, 116, [[94, 116, 'Ramos']]), line(1, 143, [[42, 82, '25-06-2026'], [305, 338, '$ -1.00']])]
    const groups = groupRows(lines, { isAnchor: (l) => /^\d{2}-/.test(l.segments[0]?.str ?? ''), attach: 'nearest', band: 14, orphan: 'next' })
    expect(groups.map((g) => g.lines.length)).toEqual([3, 1])
  })
  it('el saldo corrido detecta una fila que no cuadra', () => {
    const row = (amount: number, type: 'credit' | 'debit', balance: number): ParsedRow => ({ section: 'main', page: 1, date: '2025-01-01', description: 'x', description_head: 'x', reference: null, amount, type, balance, balance2: null, internal_transfer: false, problems: [] })
    expect(checkChain([row(10, 'credit', 110), row(5, 'debit', 105)], 100).breaks).toHaveLength(0)
    expect(checkChain([row(10, 'credit', 110), row(5, 'debit', 104)], 100).breaks).toHaveLength(1)
  })
})
