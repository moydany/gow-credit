import { tx } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { amountForms, parseAmount, parseLooseDate } from './normalize.ts'
import { assessTextLayer } from './pdf.ts'
import { pagesWithBreaks, reconcilePeriod } from './reconcile.ts'
import { checkClabe, checkRfc } from './validators.ts'

const printed = (opening: number | null, closing: number | null, totalCredits: number | null = null, totalDebits: number | null = null) => ({
  opening,
  closing,
  totalCredits,
  totalDebits,
  creditsCount: null,
  debitsCount: null,
})

describe('reconcilePeriod', () => {
  const rows = [tx('t1', '2026-03-05', 5000, 'credit', 15000), tx('t2', '2026-03-12', 1250.5, 'debit', 13749.5), tx('t3', '2026-03-20', 749.5, 'debit', 13000, 2)]

  it('cuadra global, totales y saldo corrido', () => {
    const r = reconcilePeriod(rows, printed(10000, 13000, 5000, 2000)).reconciliation
    expect(r.status).toBe('reconciled')
    expect(r.global?.difference).toBe(0)
    expect(r.running_balance).toEqual({ rows_checked: 3, rows_without_balance: 0, breaks: [], ok: true })
  })

  it('localiza una fila omitida en su página', () => {
    const missing = [rows[0], rows[2]].filter((r) => r !== undefined)
    const r = reconcilePeriod(missing, printed(10000, 13000)).reconciliation
    expect(r.status).toBe('not_reconciled')
    expect(r.running_balance?.breaks).toEqual([{ transaction_id: 't3', page: 2, expected_balance: 14250.5, printed_balance: 13000, difference: -1250.5 }])
    expect(pagesWithBreaks(r)).toEqual([2])
  })

  it('detecta un sentido invertido', () => {
    const flipped = [rows[0], { ...tx('t2', '2026-03-12', 1250.5, 'credit', 13749.5) }, rows[2]].filter((r) => r !== undefined)
    expect(reconcilePeriod(flipped, printed(10000, 13000)).reconciliation.running_balance?.breaks.map((b) => b.transaction_id)).toEqual(['t2'])
  })

  it('verifica estados que listan del más reciente al más antiguo', () => {
    const r = reconcilePeriod([...rows].reverse(), printed(10000, 13000))
    expect(r.order).toBe('reversed')
    expect(r.reconciliation.running_balance?.ok).toBe(true)
  })

  it('acumula filas sin saldo impreso (saldos solo al cierre del día)', () => {
    const daily = [tx('t1', '2026-03-05', 100, 'debit', null), tx('t2', '2026-03-05', 50, 'debit', 9850), tx('t3', '2026-03-06', 850, 'credit', 10700)]
    const r = reconcilePeriod(daily, printed(10000, 10700)).reconciliation
    expect(r.running_balance).toMatchObject({ rows_checked: 2, rows_without_balance: 1, ok: true })
  })

  it('tolera que el banco aplique los movimientos de un día en otro orden que el impreso', () => {
    // Fondeadora: interés e ISR impresos al final del día, aplicados antes del depósito.
    const day = [
      tx('d1', '2025-10-31', 48573.02, 'credit', 167203.45),
      tx('d2', '2025-10-31', 160000, 'debit', 7203.45),
      tx('d3', '2025-10-31', 216.83, 'credit', 118666.57),
      tx('d4', '2025-10-31', 36.14, 'debit', 118630.43),
    ]
    const r = reconcilePeriod(day, printed(118449.74, 7203.45)).reconciliation
    expect(r.running_balance).toMatchObject({ rows_checked: 4, ok: true })
    expect(r.status).toBe('reconciled')
  })

  it('el cuadre global exacto manda sobre una diferencia de presentación en los totales', () => {
    const r = reconcilePeriod(rows, printed(10000, 13000, 5000, 1963.86)).reconciliation
    expect(r.totals.debits.ok).toBe(false)
    expect(r.status).toBe('reconciled')
  })

  it('resumen consolidado con apartados (Nu): cuadra sin traspasos internos y con rendimientos no detallados', () => {
    const rows = [
      tx('n1', '2025-07-02', 1000, 'credit', null),
      { ...tx('n2', '2025-07-02', 600, 'debit', null), internal_transfer: true },
      { ...tx('n3', '2025-07-05', 100, 'credit', null), internal_transfer: true },
      tx('n4', '2025-07-06', 300, 'debit', null),
    ]
    const r = reconcilePeriod(rows, { opening: 500, closing: 1218.24, totalCredits: 1000, totalDebits: 300, creditsCount: null, debitsCount: null, interestEarned: 18.24 }).reconciliation
    expect(r.global).toMatchObject({ ok: true, excludes_internal_transfers: true, adjustments: [{ item: 'interest_earned', amount: 18.24 }], difference: 0 })
    expect(r.totals.credits).toMatchObject({ extracted: 1000, ok: true })
    expect(r.status).toBe('reconciled')
  })

  it('una fórmula alternativa solo se acepta exacta al centavo', () => {
    const rows = [tx('a', '2025-07-02', 1000, 'credit', null)]
    const r = reconcilePeriod(rows, { opening: 0, closing: 1018.74, totalCredits: null, totalDebits: null, creditsCount: null, debitsCount: null, interestEarned: 18.24 }).reconciliation
    expect(r.global?.ok).toBe(false)
  })

  it('sin saldos ni totales impresos no se puede verificar', () => {
    const r = reconcilePeriod([tx('t1', '2026-03-05', 100, 'debit', null)], printed(null, null)).reconciliation
    expect(r.status).toBe('not_checkable')
  })
})

describe('validadores', () => {
  it('CLABE: dígito verificador, enmascarada, inválida', () => {
    expect(checkClabe('032180000118359719')).toBe('valid')
    expect(checkClabe('032180000118359718')).toBe('invalid')
    expect(checkClabe('0321 8000 0118 3597 19')).toBe('valid')
    expect(checkClabe('032180******359719')).toBe('masked')
    expect(checkClabe('12345')).toBe('invalid')
    expect(checkClabe(null)).toBe('absent')
  })

  it('RFC: estructura, fecha, genérico y enmascarado', () => {
    expect(checkRfc('GODE561231GR8')).toEqual({ result: 'valid', kind: 'individual', checkDigitOk: true })
    expect(checkRfc('XAXX010101000').kind).toBe('generic')
    expect(checkRfc('GODE561331GR8').result).toBe('invalid')
    expect(checkRfc('GOD***1231GR8').result).toBe('masked')
    expect(checkRfc('AXE850101AB1').kind).toBe('legal_entity')
  })
})

describe('normalización', () => {
  it.each([
    ['2025-01-16', '2025-01-31', '2025-01-16'],
    ['16/01/2025', '2025-01-31', '2025-01-16'],
    ['ENE. 16', '2025-01-31', '2025-01-16'],
    ['01/SEP', '2025-09-30', '2025-09-01'],
    ['31 JUL 2025', '2025-07-31', '2025-07-31'],
    ['13 de June', '2026-09-11', '2026-06-13'],
    ['28 DIC', '2026-01-15', '2025-12-28'],
    ['01-ABR-2025', null, '2025-04-01'],
    ['DEL 01-ABR-2025 AL 30-ABR-2025', null, '2025-04-01'],
    ['Del 01 Ene. 2025', null, '2025-01-01'],
    ['30-ABR-2025', '2025-04-30', '2025-04-30'],
    ['DEL 01/09/2025 AL 30/09/2025', null, '2025-09-01'],
    ['Periodo 2025-10-01 a 2025-10-31', null, '2025-10-01'],
  ])('%s con fin de periodo %s → %s', (raw, end: string | null, expected) => {
    expect(parseLooseDate(raw, end)).toBe(expected)
  })

  it.each([
    ['1,250.50', 1250.5],
    ['$ 1,620.67', 1620.67],
    ['-$865.12', -865.12],
    ['+$100.00', 100],
    ['(1,234.00)', -1234],
    ['1,234.00-', -1234],
    ['1.250,50', 1250.5],
    ['98.52', 98.52],
    ['', null],
    ['N/A', null],
  ])('parseAmount(%j) → %j', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected)
  })

  it('formas impresas de un monto', () => {
    expect(amountForms(1250.5)).toEqual(['1,250.50', '1250.50'])
    expect(amountForms(98.52)).toEqual(['98.52'])
  })
})

describe('capa de texto', () => {
  /** Codifica texto ASCII en cp037 y lo lee como Latin-1, como sale del PDF de HSBC. */
  function asCorruptLayer(text: string): string {
    const code = (c: string): number => {
      if (c === ' ') return 0x40
      if (c === '.') return 0x4b
      if (c === ',') return 0x6b
      if (c >= '0' && c <= '9') return 0xf0 + Number(c)
      const i = c.charCodeAt(0) - 65
      return i < 9 ? 0xc1 + i : i < 18 ? 0xd1 + (i - 9) : 0xe2 + (i - 18)
    }
    return Buffer.from(Array.from({ length: text.length }, (_, i) => code(text.charAt(i)))).toString('latin1')
  }

  it('decodifica EBCDIC leído como Latin-1', () => {
    const page = ['CUENTA MAESTRA', ...Array.from({ length: 6 }, (_, i) => `SALDO DE LA CUENTA PERIODO FECHA TOTAL ${String(i + 1)},234.56`)].map(asCorruptLayer).join('\n')
    expect(page.startsWith('ÃäÅÕãÁ@ÔÁÅâãÙÁ')).toBe(true)
    const res = assessTextLayer([page])
    expect(res).toMatchObject({ layer: 'corrupt', repaired: true })
    expect(res.texts[0]?.split('\n')[1]).toBe('SALDO DE LA CUENTA PERIODO FECHA TOTAL 1,234.56')
  })
})
