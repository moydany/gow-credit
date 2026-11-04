import { describe, expect, it } from 'vitest'
import { assembleSummary, materialize, placeRows } from './assemble.ts'
import { IssueSink } from './issues.ts'
import type { SummaryOut, TransactionOut } from './llm-schema.ts'
import { PageText } from './page-text.ts'

const text = new PageText({
  pageTexts: ['BANCO FICTICIO S.A.\nSaldo inicial 10,000.00 Saldo final 13,749.50\nPeriodo del 01/03/2026 al 31/03/2026', '05/03 SPEI RECIBIDO 5,000.00 15,000.00\n12/03 PAGO PROVEEDOR 1,250.50 13,749.50', 'CFDI'],
  textLayer: 'ok',
  textRepaired: false,
})

const summary: SummaryOut = {
  document_kind: 'bank_statement',
  holder_type: 'legal_entity',
  values: [{ field: 'bank_name', value: 'BANCO FICTICIO S.A.', page: 1, snippet: 'BANCO FICTICIO S.A.' }],
  accounts: [
    {
      ref: 'A1',
      account_type: 'checking',
      currency: 'MXN',
      values: [],
      periods: [
        {
          ref: 'A1-P1',
          values: [
            { field: 'period_start', value: '2026-03-01', page: 1, snippet: 'Periodo del 01/03/2026' },
            { field: 'period_end', value: '2026-03-31', page: 1, snippet: 'al 31/03/2026' },
            { field: 'opening_balance', value: '10,000.00', page: 1, snippet: 'Saldo inicial 10,000.00' },
            { field: 'closing_balance', value: '13,749.50', page: 0, snippet: '' },
          ],
          movement_pages: [2],
          prints_running_balance: true,
        },
      ],
    },
  ],
  fiscal_documents: [],
  suspicious_instructions: [],
}

const row = (o: Partial<TransactionOut>): TransactionOut => ({
  account_ref: 'A1',
  period_ref: 'A1-P1',
  page: 2,
  date: '2026-03-05',
  settlement_date: '',
  description: 'SPEI RECIBIDO',
  reference: '',
  amount: '5,000.00',
  type: 'credit',
  balance: '15,000.00',
  snippet: '05/03 SPEI RECIBIDO 5,000.00 15,000.00',
  ...o,
})

describe('assembleSummary', () => {
  const s = assembleSummary(summary, text)

  it('verifica contra la página citada y ubica en el texto lo que no trae cita', () => {
    const p = s.accounts[0]?.periods[0]
    expect(p?.summary.opening_balance).toMatchObject({ value: 10000, verification: 'verified', source: { page: 1 } })
    expect(p?.summary.closing_balance).toMatchObject({ value: 13749.5, verification: 'verified', source: { page: 1 } })
    expect(p?.summary.total_credits.value).toBeNull()
  })

  it('el tipo de cuenta es una lectura del modelo: no verificada', () => {
    expect(s.accounts[0]?.account_type).toMatchObject({ value: 'checking', verification: 'unverified' })
  })
})

describe('placeRows', () => {
  const s = assembleSummary(summary, text)

  it('descarta filas de páginas fuera del bloque y duplicados exactos con saldo', () => {
    const issues = new IssueSink()
    const placed = placeRows([row({}), row({}), row({ page: 3 }), row({ date: '12/03', amount: '1,250.50', type: 'debit', balance: '13,749.50', description: 'PAGO PROVEEDOR' })], [2], s, 0, issues)
    expect(placed.map((p) => p.tx.amount)).toEqual([5000, 1250.5])
    expect(placed[1]?.tx.date).toBe('2026-03-12')
    expect(issues.count('duplicate_transaction_removed')).toBe(2)
  })

  it('un monto ilegible se descarta con issue, no tumba el bloque', () => {
    const issues = new IssueSink()
    const placed = placeRows([row({ amount: 'ilegible' }), row({ date: '2026-03-12', amount: '1,250.50', type: 'debit', balance: '13,749.50' })], [2], s, 0, issues)
    expect(placed).toHaveLength(1)
    expect(issues.issues[0]).toMatchObject({ code: 'missing_required_field', severity: 'error' })
  })

  it('una referencia de periodo mal copiada se resuelve si solo hay un periodo posible', () => {
    const placed = placeRows([row({ period_ref: 'P1' })], [2], s, 0, new IssueSink())
    expect(placed[0]?.periodId).toBe('a1.p1')
  })

  it('materialize asigna ids estables en orden de página y lectura', () => {
    const placed = placeRows([row({}), row({ date: '2026-03-12', amount: '1,250.50', type: 'debit', balance: '13,749.50' })], [2], s, 0, new IssueSink())
    expect(materialize(placed).get('a1.p1')?.map((t) => t.id)).toEqual(['a1.p1.t0001', 'a1.p1.t0002'])
  })
})

describe('signos del banco', () => {
  it('los totales del resumen son magnitudes aunque el banco imprima los cargos negativos', () => {
    const neg: SummaryOut = structuredClone(summary)
    neg.accounts[0]?.periods[0]?.values.push({ field: 'total_debits', value: '-$1,250.50', page: 2, snippet: 'Total cargos -$1,250.50' })
    const s = assembleSummary(neg, text)
    expect(s.accounts[0]?.periods[0]?.summary.total_debits.value).toBe(1250.5)
  })
})
