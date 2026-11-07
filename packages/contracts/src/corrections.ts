/**
 * Analyst corrections during human review. Each is a (read value, correct value) pair on one
 * extraction value, with its page, and feeds the eval dataset. The set of targets is closed, not
 * a free JSON Pointer: only what the engine uses can be corrected (holder, CLABE, summary
 * figures, transactions), and the server can recompute the reconciliation afterwards.
 */
import { z } from 'zod'
import { IsoDate, LocalId, Money, SignedMoney } from './primitives.ts'
import { TransactionType } from './enums.ts'

export const HolderCorrectionField = z.enum(['name', 'rfc', 'holder_type'])
export const AccountCorrectionField = z.enum(['clabe', 'account_number'])
export const PeriodCorrectionField = z.enum(['opening_balance', 'closing_balance', 'total_credits', 'total_debits', 'credits_count', 'debits_count'])
export const TransactionCorrectionField = z.enum(['amount', 'type', 'date'])

export const CorrectionTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('holder'), field: HolderCorrectionField }),
  z.strictObject({ kind: z.literal('account'), account_id: LocalId, field: AccountCorrectionField }),
  z.strictObject({ kind: z.literal('period'), period_id: LocalId, field: PeriodCorrectionField }),
  z.strictObject({ kind: z.literal('transaction'), transaction_id: LocalId, field: TransactionCorrectionField }),
])
export type CorrectionTarget = z.infer<typeof CorrectionTarget>

export const CorrectionValue = z.union([z.string().trim().min(1).max(200), z.number()])

/** What the browser sends: the target, the correct value and the page where it shows. */
export const CorrectionInput = z.strictObject({
  target: CorrectionTarget,
  value: CorrectionValue,
  page: z.int().min(1).nullable(),
})
export type CorrectionInput = z.infer<typeof CorrectionInput>

export const CorrectionsBody = z.strictObject({ corrections: z.array(CorrectionInput).min(1).max(50) })

/** The stored correction; includes what was read, for the eval dataset. */
export const Correction = z.strictObject({
  id: z.uuid(),
  target: CorrectionTarget,
  read_value: z.union([z.string(), z.number(), z.null()]),
  value: CorrectionValue,
  page: z.int().min(1).nullable(),
  created_by: z.string().nullable().describe('Correo de quien corrigió'),
  created_at: z.string(),
})
export type Correction = z.infer<typeof Correction>

/** Value type each target accepts; server and form validate with the same thing. */
export function correctionValueKind(t: CorrectionTarget): 'text' | 'money' | 'signed_money' | 'count' | 'date' | 'type' | 'holder_type' {
  if (t.kind === 'holder') return t.field === 'holder_type' ? 'holder_type' : 'text'
  if (t.kind === 'account') return 'text'
  if (t.kind === 'period') return t.field === 'credits_count' || t.field === 'debits_count' ? 'count' : t.field === 'opening_balance' || t.field === 'closing_balance' ? 'signed_money' : 'money'
  return t.field === 'amount' ? 'money' : t.field === 'type' ? 'type' : 'date'
}

/** Error message for a value on that target, or null if it is valid. */
export function checkCorrectionValue(t: CorrectionTarget, value: string | number): string | null {
  const kind = correctionValueKind(t)
  const num = typeof value === 'number' ? value : Number(value.replace(/[$,\s]/g, ''))
  switch (kind) {
    case 'money':
      return Money.safeParse(num).success ? null : 'Escribe un monto positivo con a lo más dos decimales'
    case 'signed_money':
      return SignedMoney.safeParse(num).success ? null : 'Escribe un monto con a lo más dos decimales'
    case 'count':
      return Number.isInteger(num) && num >= 0 ? null : 'Escribe un número entero'
    case 'date':
      return IsoDate.safeParse(value).success ? null : 'Usa el formato AAAA-MM-DD'
    case 'type':
      return TransactionType.safeParse(value).success ? null : 'Elige abono o cargo'
    case 'holder_type':
      return ['individual', 'individual_with_business_activity', 'legal_entity'].includes(String(value)) ? null : 'Elige un tipo de titular'
    default:
      return String(value).trim().length > 0 ? null : 'No puede ir vacío'
  }
}

/**
 * Discard the document in human review: the analyst concludes it is unusable. Closed reason, no
 * free text, so the audit log and the request never hold notes that could carry document data.
 * The request ends `not_qualified` with `failure_reason = document_discarded:<reason>`; the
 * supplier may apply again with another document.
 */
export const DiscardReason = z.enum(['wrong_document', 'illegible', 'altered', 'incomplete'])
export type DiscardReason = z.infer<typeof DiscardReason>
export const DiscardBody = z.strictObject({ reason: DiscardReason })
export const DISCARD_REASON_LABELS: Record<DiscardReason, string> = {
  wrong_document: 'No es un estado de cuenta del proveedor',
  illegible: 'No se puede leer',
  altered: 'Parece alterado',
  incomplete: 'Le faltan páginas o periodos',
}
export const DISCARDED_PREFIX = 'document_discarded:'

/**
 * Corrections exported for evals: one file per document, keyed by the PDF sha256. No user,
 * tenant or request: only what was read, what it was and on which page. Lives in
 * `data/corrections/`, which is not versioned because values are document data.
 */
export const CorrectionsExport = z.strictObject({
  version: z.literal(1),
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  exported_at: z.string(),
  corrections: z.array(z.strictObject({ target: CorrectionTarget, read_value: z.union([z.string(), z.number(), z.null()]), value: CorrectionValue, page: z.int().min(1).nullable() })).min(1),
})
export type CorrectionsExport = z.infer<typeof CorrectionsExport>
