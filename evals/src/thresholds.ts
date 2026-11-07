/**
 * Extraction eval thresholds. Per document: a bank that falls under any of them with the default
 * model fails `pnpm eval`. Invention and omission are separate because they take different fixes.
 */
export const THRESHOLDS = {
  /** Movement precision: at most 0.5% of rows invented. */
  precision: 0.995,
  /** Movement recall: at most 1% of rows omitted. */
  recall: 0.99,
  /** Accuracy per matched row. */
  amount: 0.995,
  date: 0.99,
  type: 0.995,
  balance: 0.99,
  /** Fuzzy description (description + reference against the bank's row). */
  description: 0.9,
  /** Header and summary per field (includes not inventing what is redacted). */
  header: 0.9,
  /** CFDI per field. */
  fiscal: 0.85,
  /** The document must end up reconciled (first pass or after the re-read). */
  reconciled_final: true,
} as const

export type ThresholdKey = Exclude<keyof typeof THRESHOLDS, 'reconciled_final'>
