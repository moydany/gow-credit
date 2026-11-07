/**
 * Ground-truth format. Every value carries its provenance; the ground truth is built from the text
 * layer and the bank's arithmetic, never from the output of the model being measured. The JSON
 * files live in data/ground-truth/ (not versioned).
 */
import { z } from 'zod'

export const GT_VERSION = '1.0.0'

export const GtProvenance = z.enum(['text_layer', 'bank_arithmetic', 'visual_review', 'human_review'])
export type GtProvenance = z.infer<typeof GtProvenance>

/** Value with provenance; `value: null` means "the document doesn't print it". */
export const gtValue = <T extends z.ZodType>(t: T) =>
  z.strictObject({
    value: t.nullable(),
    provenance: z.array(GtProvenance).min(1),
    page: z.int().min(1).nullable(),
  })

const Str = gtValue(z.string())
const Num = gtValue(z.number())
const Int = gtValue(z.int())
const Day = gtValue(z.iso.date())

export const GtTransaction = z.strictObject({
  page: z.int().min(1),
  date: z.iso.date(),
  /** Full description: all the row's lines joined, without the reference column. */
  description: z.string().min(1),
  /** First line of the description (what any reasonable reading must include). */
  description_head: z.string().min(1),
  /** Reference or folio when the bank prints it in its own column; null otherwise. */
  reference: z.string().nullable(),
  amount: z.number().positive(),
  type: z.enum(['credit', 'debit']),
  balance: z.number().nullable(),
  internal_transfer: z.boolean(),
  provenance: z.array(GtProvenance).min(1),
})
export type GtTransaction = z.infer<typeof GtTransaction>

export const GtPeriod = z.strictObject({
  key: z.string(),
  period_start: Day,
  period_end: Day,
  opening_balance: Num,
  closing_balance: Num,
  total_credits: Num,
  total_debits: Num,
  credits_count: Int,
  debits_count: Int,
  /** Arithmetic checks the ground-truth ledger passed. */
  checks: z.strictObject({
    running_balance: z.enum(['ok', 'not_printed', 'failed']),
    global: z.enum(['ok', 'ok_consolidated', 'failed', 'not_checkable']),
    totals: z.enum(['ok', 'not_printed', 'failed']),
    counts: z.enum(['ok', 'not_printed', 'failed']),
  }),
  /** Page -> how many rows it has; used to measure per page and for the report. */
  pages: z.array(z.int().min(1)),
  transactions: z.array(GtTransaction),
})
export type GtPeriod = z.infer<typeof GtPeriod>

export const GtAccount = z.strictObject({
  key: z.string(),
  account_type: gtValue(z.enum(['checking', 'savings', 'investment', 'credit_card', 'other'])),
  account_number: Str,
  clabe: Str,
  currency: Str,
  periods: z.array(GtPeriod),
})
export type GtAccount = z.infer<typeof GtAccount>

export const GtFiscalDocument = z.strictObject({
  kind: gtValue(z.enum(['income', 'withholding', 'other'])),
  page: z.int().min(1),
  uuid: Str,
  issued_at: Str,
  certified_at: Str,
  issuer_certificate: Str,
  sat_certificate: Str,
  pac_rfc: Str,
  issuer_rfc: Str,
  receiver_rfc: Str,
  receiver_name: Str,
  receiver_tax_regime: Str,
  receiver_cfdi_use: Str,
  subtotal: Num,
  tax: Num,
  total: Num,
})
export type GtFiscalDocument = z.infer<typeof GtFiscalDocument>

export const GroundTruth = z.strictObject({
  gt_version: z.literal(GT_VERSION),
  file_name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  page_count: z.int().min(1),
  bank: z.string(),
  /** Whether it counts toward the CI threshold: all its periods close on running balance or totals. */
  gated: z.boolean(),
  holder: z.strictObject({ name: Str, rfc: Str }),
  accounts: z.array(GtAccount),
  fiscal_documents: z.array(GtFiscalDocument),
  review: z.strictObject({
    built_by: z.string(),
    built_at: z.iso.date(),
    method: z.string(),
    human_sample: z.string().nullable(),
  }),
  /** Notes without personal data: convention decisions, what doesn't reconcile and why. */
  notes: z.array(z.string()),
})
export type GroundTruth = z.infer<typeof GroundTruth>
