import type { Period, StatementExtraction, Transaction } from '@gow/contracts'

/** A movement where the running balance stops matching the printed one. */
export interface BalanceBreak {
  tx: Transaction
  /** Balance the previous row plus this movement gives. */
  expected: number
  /** Balance printed on this row. */
  printed: number
  /** printed − expected. */
  difference: number
  /**
   * Amount that makes this row land on the printed balance, if the amount is what was misread.
   * Null when no positive amount does it (then it is the sign, the date or another row).
   */
  suggestedAmount: number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Amount that closes the gap: a credit adds the difference, a debit subtracts it. */
export function suggestAmount(tx: Pick<Transaction, 'type' | 'amount'>, difference: number): number | null {
  const v = round2(tx.type === 'credit' ? tx.amount + difference : tx.amount - difference)
  return v > 0 ? v : null
}

/** A period's running-balance breaks, with their movement. */
export function periodBreaks(p: Period): BalanceBreak[] {
  const out: BalanceBreak[] = []
  for (const b of p.reconciliation?.running_balance?.breaks ?? []) {
    const tx = p.transactions.find((t) => t.id === b.transaction_id)
    if (tx) out.push({ tx, expected: b.expected_balance, printed: b.printed_balance, difference: b.difference, suggestedAmount: suggestAmount(tx, b.difference) })
  }
  return out
}

/** Every running-balance break of the extraction, in document order. */
export function balanceBreaks(x: StatementExtraction): BalanceBreak[] {
  return x.accounts.flatMap((a) => a.periods.flatMap(periodBreaks))
}
