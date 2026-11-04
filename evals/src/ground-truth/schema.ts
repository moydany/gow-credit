/**
 * Formato del ground truth (fase 3, ADR 0001). Cada valor lleva su procedencia; el ground
 * truth se construye desde la capa de texto y la aritmética del banco, nunca desde la salida
 * del modelo que se va a medir. Los JSON viven en data/ground-truth/ (no se versionan, ADR 0012).
 */
import { z } from 'zod'

export const GT_VERSION = '1.0.0'

export const GtProvenance = z.enum(['text_layer', 'bank_arithmetic', 'visual_review', 'human_review'])
export type GtProvenance = z.infer<typeof GtProvenance>

/** Valor con procedencia; `value: null` significa "el documento no lo imprime". */
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
  /** Concepto completo: todas las líneas de la fila unidas, sin la columna de referencia. */
  description: z.string().min(1),
  /** Primera línea del concepto (lo que cualquier lectura razonable debe incluir). */
  description_head: z.string().min(1),
  /** Referencia o folio cuando el banco la imprime en columna propia; null si no. */
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
  /** Comprobaciones aritméticas que pasó el libro de movimientos del ground truth. */
  checks: z.strictObject({
    running_balance: z.enum(['ok', 'not_printed', 'failed']),
    global: z.enum(['ok', 'ok_consolidated', 'failed', 'not_checkable']),
    totals: z.enum(['ok', 'not_printed', 'failed']),
    counts: z.enum(['ok', 'not_printed', 'failed']),
  }),
  /** Página → cuántas filas tiene; sirve para medir por página y para el reporte. */
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
  /** Si entra al umbral de CI: todos sus periodos cierran saldo corrido o totales (ADR 0001). */
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
  /** Notas sin datos personales: decisiones de convención, lo que no cuadra y por qué. */
  notes: z.array(z.string()),
})
export type GroundTruth = z.infer<typeof GroundTruth>
