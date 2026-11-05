/**
 * Verificación aritmética de un periodo (docs/04 §3, puntos 1 a 3). Código puro: no sabe de
 * modelos ni de PDFs. Un estado de cuenta se auto-verifica: una fila inventada, omitida o
 * con el sentido invertido rompe el saldo corrido exactamente donde ocurrió.
 */
import type { Period, Reconciliation, Transaction } from '@gow/contracts'
import { round2 } from './normalize.ts'

export const GLOBAL_TOLERANCE = 1
/** Fila por fila la aritmética es exacta salvo redondeo. */
export const ROW_TOLERANCE = 0.011
/** Una fórmula de cuadre alternativa (sin traspasos internos o con conceptos no detallados) solo se acepta exacta. */
export const EXACT_TOLERANCE = 0.011

export interface PrintedSummary {
  opening: number | null
  closing: number | null
  totalCredits: number | null
  totalDebits: number | null
  creditsCount: number | null
  debitsCount: number | null
  /** Conceptos que el banco puede imprimir en el resumen sin detallarlos como movimiento. */
  interestEarned?: number | null
  feesCharged?: number | null
  taxWithheld?: number | null
}

export interface RowCheck {
  transactionId: string
  /** null si la fila no trae saldo impreso. */
  ok: boolean | null
}

export interface PeriodReconciliation {
  reconciliation: Reconciliation
  rows: RowCheck[]
  /** Orden en que se verificó el saldo corrido. */
  order: 'printed' | 'reversed' | null
}

const signed = (t: Pick<Transaction, 'amount' | 'type'>) => (t.type === 'credit' ? t.amount : -t.amount)

interface Break {
  transaction_id: string
  page: number
  expected_balance: number
  printed_balance: number
  difference: number
}

interface ChainResult {
  rows: RowCheck[]
  breaks: Break[]
  checked: number
  withoutBalance: number
}

/**
 * Saldo corrido con tolerancia al orden dentro del mismo día: algunos bancos aplican los
 * movimientos de un día en un orden distinto al impreso (Fondeadora lista intereses e ISR al
 * final con saldos de antes del último depósito). Dentro de cada fecha se aplica primero la
 * fila que encadena con el saldo anterior; si ninguna encadena, la primera impresa rompe.
 */
function runChain(txs: readonly Transaction[], opening: number | null): ChainResult {
  const result = new Map<string, boolean | null>()
  const breaks: Break[] = []
  let prev: number | null = opening
  let checked = 0
  let withoutBalance = 0

  const apply = (t: Transaction): void => {
    if (t.balance === null) {
      withoutBalance += 1
      result.set(t.id, null)
      if (prev !== null) prev = round2(prev + signed(t))
      return
    }
    if (prev === null) {
      // Sin saldo inicial: la primera fila con saldo fija el punto de partida.
      result.set(t.id, null)
      prev = t.balance
      return
    }
    const expected = round2(prev + signed(t))
    const diff = round2(t.balance - expected)
    checked += 1
    const ok = Math.abs(diff) <= ROW_TOLERANCE
    result.set(t.id, ok)
    if (!ok) breaks.push({ transaction_id: t.id, page: t.source.page, expected_balance: expected, printed_balance: t.balance, difference: diff })
    // Se resincroniza con el saldo impreso para que un error no se propague a todas las filas.
    prev = t.balance
  }

  let i = 0
  while (i < txs.length) {
    const date = txs[i]?.date
    let j = i
    while (j < txs.length && txs[j]?.date === date) j++
    const group = txs.slice(i, j)
    const pending = [...group]
    // Con filas sin saldo en el día no se puede reordenar con seguridad: orden impreso.
    const reorderable = group.length > 1 && group.every((t) => t.balance !== null)
    while (pending.length > 0) {
      let k = 0
      if (reorderable && prev !== null) {
        const base: number = prev
        const fit = pending.findIndex((t) => t.balance !== null && Math.abs(round2(base + signed(t)) - t.balance) <= ROW_TOLERANCE)
        if (fit >= 0) k = fit
      }
      const [t] = pending.splice(k, 1)
      if (t) apply(t)
    }
    i = j
  }
  const rows = txs.map((t) => ({ transactionId: t.id, ok: result.get(t.id) ?? null }))
  return { rows, breaks, checked, withoutBalance }
}

type Adjustment = { item: 'interest_earned' | 'fees_charged' | 'tax_withheld'; amount: number }

interface Sums {
  credits: number
  debits: number
  nCredits: number
  nDebits: number
}

function sums(txs: readonly Transaction[]): Sums {
  const cr = txs.filter((t) => t.type === 'credit')
  const db = txs.filter((t) => t.type === 'debit')
  return { credits: round2(cr.reduce((s, t) => s + t.amount, 0)), debits: round2(db.reduce((s, t) => s + t.amount, 0)), nCredits: cr.length, nDebits: db.length }
}

/** Combinaciones de conceptos del resumen no detallados que pueden entrar al cuadre. */
function adjustmentSets(p: PrintedSummary): Adjustment[][] {
  const parts: Adjustment[] = []
  if (p.interestEarned) parts.push({ item: 'interest_earned', amount: p.interestEarned })
  if (p.feesCharged) parts.push({ item: 'fees_charged', amount: -p.feesCharged })
  if (p.taxWithheld) parts.push({ item: 'tax_withheld', amount: -p.taxWithheld })
  const sets: Adjustment[][] = []
  for (let mask = 1; mask < 1 << parts.length; mask++) sets.push(parts.filter((_, i) => (mask >> i) & 1))
  return sets
}

export function reconcilePeriod(transactions: readonly Transaction[], printed: PrintedSummary): PeriodReconciliation {
  const all = sums(transactions)
  const hasInternal = transactions.some((t) => t.internal_transfer)
  // Resumen consolidado (Nu): los traspasos entre la cuenta y sus apartados no son entradas ni salidas.
  const external = hasInternal ? sums(transactions.filter((t) => !t.internal_transfer)) : null

  const global =
    printed.opening !== null && printed.closing !== null
      ? (() => {
          const opening = printed.opening
          const closing = printed.closing
          const attempt = (base: Sums, excludes: boolean, adj: Adjustment[]) => {
            const expected = round2(opening + base.credits - base.debits + adj.reduce((s, a) => s + a.amount, 0))
            const difference = round2(closing - expected)
            return { opening_balance: opening, credits: base.credits, debits: base.debits, expected_closing: expected, printed_closing: closing, difference, ok: false, excludes_internal_transfers: excludes, adjustments: adj.map((a) => ({ item: a.item, amount: round2(a.amount) })) }
          }
          const direct = attempt(all, false, [])
          if (Math.abs(direct.difference) <= GLOBAL_TOLERANCE) return { ...direct, ok: true }
          // Fórmulas alternativas, solo si cuadran al centavo: una coincidencia exacta con un concepto impreso no es casualidad.
          const bases: [Sums, boolean][] = external ? [[external, true], [all, false]] : [[all, false]]
          for (const [base, excludes] of bases) {
            for (const adj of [[], ...adjustmentSets(printed)]) {
              if (!excludes && adj.length === 0) continue
              const a = attempt(base, excludes, adj)
              if (Math.abs(a.difference) <= EXACT_TOLERANCE) return { ...a, ok: true }
            }
          }
          return direct
        })()
      : null

  const amountCheck = (printedValue: number | null, values: number[]) => {
    const extracted = values.find((v) => printedValue !== null && Math.abs(v - printedValue) <= GLOBAL_TOLERANCE) ?? values[0] ?? 0
    return {
      printed: printedValue,
      extracted,
      difference: printedValue === null ? null : round2(extracted - printedValue),
      ok: printedValue === null ? null : Math.abs(extracted - printedValue) <= GLOBAL_TOLERANCE,
    }
  }
  const countCheck = (printedValue: number | null, values: number[]) => {
    const extracted = values.find((v) => v === printedValue) ?? values[0] ?? 0
    return { printed: printedValue, extracted, ok: printedValue === null ? null : printedValue === extracted }
  }
  const pick = (f: (s: Sums) => number) => (external ? [f(all), f(external)] : [f(all)])

  // Saldo corrido: en el orden impreso y, si hay muchas rupturas, al revés (estados que listan del más reciente al más antiguo).
  const withBalance = transactions.filter((t) => t.balance !== null).length
  let running: Reconciliation['running_balance'] = null
  let rows: RowCheck[] = transactions.map((t) => ({ transactionId: t.id, ok: null }))
  let order: PeriodReconciliation['order'] = null
  if (withBalance >= 2) {
    const fwd = runChain(transactions, printed.opening)
    const rev = runChain([...transactions].reverse(), printed.opening)
    const useRev = rev.checked > 0 && rev.breaks.length < fwd.breaks.length
    const chosen = useRev ? rev : fwd
    order = useRev ? 'reversed' : 'printed'
    rows = useRev ? [...chosen.rows].reverse() : chosen.rows
    running = { rows_checked: chosen.checked, rows_without_balance: chosen.withoutBalance, breaks: chosen.breaks, ok: chosen.breaks.length === 0 }
  }

  const totals = {
    credits: amountCheck(printed.totalCredits, pick((s) => s.credits)),
    debits: amountCheck(printed.totalDebits, pick((s) => s.debits)),
    credits_count: countCheck(printed.creditsCount, pick((s) => s.nCredits)),
    debits_count: countCheck(printed.debitsCount, pick((s) => s.nDebits)),
  }

  const checks = [global?.ok ?? null, totals.credits.ok, totals.debits.ok, totals.credits_count.ok, totals.debits_count.ok, running?.ok ?? null].filter((x): x is boolean => x !== null)
  // El cuadre global exacto con saldo corrido sano manda: una diferencia contra los totales
  // impresos es de presentación (bancos que no cuentan el ISR o las comisiones en su total).
  const strong = global?.ok === true && running?.ok !== false
  const status: Reconciliation['status'] = strong
    ? 'reconciled'
    : checks.length === 0
      ? 'not_checkable'
      : checks.includes(false)
        ? 'not_reconciled'
        : running?.ok === true
          ? 'reconciled'
          : 'partially_reconciled'

  return { reconciliation: { status, tolerance: GLOBAL_TOLERANCE, global, totals, running_balance: running }, rows, order }
}

/** Páginas donde se rompe el saldo corrido: ahí se reintenta. */
export function pagesWithBreaks(r: Reconciliation): number[] {
  return [...new Set((r.running_balance?.breaks ?? []).map((b) => b.page))].sort((a, b) => a - b)
}

/** Puntaje de calidad para elegir entre dos lecturas: menos rupturas y menor descuadre. */
export function reconciliationScore(r: Reconciliation): number {
  const breaks = r.running_balance?.breaks.length ?? 0
  const globalDiff = Math.abs(r.global?.difference ?? 0)
  const totalsDiff = Math.abs(r.totals.credits.difference ?? 0) + Math.abs(r.totals.debits.difference ?? 0)
  return breaks * 1_000_000 + Math.min(globalDiff + totalsDiff, 999_999)
}

/** Las cifras impresas de un periodo, tal como las usa el cuadre. */
export function printedOf(p: Period) {
  return {
    opening: p.summary.opening_balance.value,
    closing: p.summary.closing_balance.value,
    totalCredits: p.summary.total_credits.value,
    totalDebits: p.summary.total_debits.value,
    creditsCount: p.summary.credits_count.value,
    debitsCount: p.summary.debits_count.value,
    interestEarned: p.summary.interest_earned.value,
    feesCharged: p.summary.fees_charged.value,
    taxWithheld: p.summary.tax_withheld.value,
  }
}
