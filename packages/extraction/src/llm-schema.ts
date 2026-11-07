/**
 * Esquema que ve el modelo. Es uno solo para todas las llamadas de extracción sobre un
 * documento, porque el esquema forma parte del prefijo cacheado (ADR 0005): la pasada 1
 * llena `summary` y la 2 llena `transactions`.
 *
 * Restricciones de la API: a lo más 16 parámetros con uniones (cada `nullable` cuenta) y una
 * gramática compilada acotada. Por eso: casi nada es nullable (única unión: `summary`); los
 * valores citados son un solo tipo `{ field, value, page, snippet }` en listas por nivel, y lo
 * que no está impreso simplemente no se incluye; los enums traen `unknown`; y los montos van
 * como texto tal como están impresos ("1,250.50", "-$865.12"), que el código convierte.
 */
import { DocumentType, TransactionType } from '@gow/contracts'
import { z } from 'zod'

export const EXTRACTION_SCHEMA_NAME = 'extraction_chunk.v3'

/** Un valor citado ausente: el modelo simplemente no lo incluye en la lista. */
export const ABSENT: { value: string; page: number; snippet: string } = { value: '', page: 0, snippet: '' }

export function pick(values: readonly { field: string; value: string; page: number; snippet: string }[], name: string) {
  return values.find((v) => v.field === name && v.value.trim().length > 0) ?? ABSENT
}

/** Nombres de los valores citados. Un solo tipo de objeto en todo el esquema mantiene chica la gramática. */
export const HEADER_FIELDS = ['bank_name', 'holder_name', 'holder_rfc', 'holder_address'] as const
export const ACCOUNT_FIELDS = ['product_name', 'account_number', 'clabe'] as const
export const PERIOD_FIELDS = [
  'period_start',
  'period_end',
  'statement_date',
  'opening_balance',
  'closing_balance',
  'total_credits',
  'total_debits',
  'credits_count',
  'debits_count',
  'average_balance',
  'fees_charged',
  'interest_earned',
  'tax_withheld',
] as const
/** Bloque fiscal (docs/09 §3). Sin sellos ni cadena original completa: no tienen campo. */
export const FISCAL_FIELDS = [
  'cfdi_version',
  'uuid',
  'series',
  'folio',
  'issued_at',
  'certified_at',
  'issuer_certificate',
  'sat_certificate',
  'pac_rfc',
  'issuer_rfc',
  'issuer_name',
  'issuer_tax_regime',
  'receiver_rfc',
  'receiver_name',
  'receiver_tax_regime',
  'receiver_cfdi_use',
  'receiver_postal_code',
  'payment_form',
  'payment_method',
  'currency',
  'subtotal',
  'tax',
  'total',
  'chain_uuid',
  'chain_certified_at',
  'chain_sat_certificate',
] as const
export type FiscalField = (typeof FISCAL_FIELDS)[number]
export type HeaderField = (typeof HEADER_FIELDS)[number]
export type AccountField = (typeof ACCOUNT_FIELDS)[number]
export type PeriodField = (typeof PERIOD_FIELDS)[number]

const Cited = z.object({
  field: z.enum([...HEADER_FIELDS, ...ACCOUNT_FIELDS, ...PERIOD_FIELDS, ...FISCAL_FIELDS]),
  value: z.string().describe('Tal como aparece en el documento'),
  page: z.number().int().describe('Página del PDF desde 1'),
  snippet: z.string().describe('Texto literal donde se leyó'),
})
export type CitedOut = z.infer<typeof Cited>

const PeriodOut = z.object({
  ref: z.string(),
  values: z.array(Cited).describe('Solo los valores del periodo que aparecen impresos'),
  movement_pages: z.array(z.number().int()),
  prints_running_balance: z.boolean(),
})

const AccountOut = z.object({
  ref: z.string(),
  account_type: z.enum(['checking', 'savings', 'investment', 'credit_card', 'other', 'unknown']),
  currency: z.string().describe('ISO 4217 (MXN, USD); cadena vacía si no se indica'),
  values: z.array(Cited).describe('product_name, account_number y clabe, los que aparezcan'),
  periods: z.array(PeriodOut),
})

const FiscalOut = z.object({
  kind: z.enum(['income', 'withholding', 'other']),
  page: z.number().int().describe('Página donde empieza el comprobante'),
  snippet: z.string().describe('Leyenda que lo identifica, por ejemplo "representación impresa de un CFDI"'),
  values: z.array(Cited).describe('Campos del comprobante que aparecen impresos; nunca sellos ni la cadena original completa'),
  issuer_seal_present: z.boolean(),
  sat_seal_present: z.boolean(),
  original_chain_present: z.boolean(),
  seals_look_truncated: z.enum(['yes', 'no', 'unknown']),
})
export type FiscalOut = z.infer<typeof FiscalOut>

export const SummaryOut = z.object({
  document_kind: DocumentType,
  holder_type: z.enum(['individual', 'individual_with_business_activity', 'legal_entity', 'unknown']),
  values: z.array(Cited).describe('bank_name, holder_name, holder_rfc y holder_address, los que aparezcan'),
  accounts: z.array(AccountOut),
  fiscal_documents: z.array(FiscalOut),
  suspicious_instructions: z.array(z.object({ page: z.number().int(), snippet: z.string() })),
})
export type SummaryOut = z.infer<typeof SummaryOut>

export const TransactionOut = z.object({
  account_ref: z.string(),
  period_ref: z.string(),
  page: z.number().int(),
  date: z.string().describe('YYYY-MM-DD'),
  settlement_date: z.string().describe('YYYY-MM-DD; cadena vacía si el banco no la imprime aparte'),
  description: z.string(),
  reference: z.string().describe('Cadena vacía si no hay columna de referencia'),
  amount: z.string().describe('Monto tal como está impreso'),
  type: TransactionType,
  balance: z.string().describe('Saldo impreso en la fila; cadena vacía si la fila no lo trae'),
  internal_transfer: z.boolean().describe('Traspaso entre la cuenta y sus propios apartados o cajitas'),
  snippet: z.string(),
})
export type TransactionOut = z.infer<typeof TransactionOut>

export const ExtractionChunk = z.object({
  summary: SummaryOut.nullable(),
  transactions: z.array(TransactionOut),
})
export type ExtractionChunk = z.infer<typeof ExtractionChunk>
