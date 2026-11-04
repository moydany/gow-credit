/**
 * Contrato de extracción de un estado de cuenta (docs/07 B). Es lo que se mide en la
 * evaluación y lo que se publica como JSON Schema en docs/schema/.
 *
 * Forma: documento → accounts[] → periods[] → transactions[]. Un documento puede traer
 * varias cuentas (Santander: cheques e inversión) y varios periodos (Mercado Pago: tres
 * meses). Los montos de movimiento son positivos y el sentido va en `type`, porque cada
 * banco usa una convención distinta (signo, columnas, +/−).
 *
 * El esquema valida forma, no semántica: un movimiento fuera del periodo o un descuadre
 * no hacen inválido el documento; la verificación los reporta como `issues`.
 */
import { z } from 'zod'
import { DocumentType, Provenance, TransactionCategory, TransactionType, Verification } from './enums.ts'
import { Confidence, Count, Currency, field, IsoDate, IsoDateTime, IsoLocalDateTime, LocalId, Money, Sha256, SignedMoney, SourceRef, TokenUsage } from './primitives.ts'

export const STATEMENT_SCHEMA_VERSION = '1.1.0'

/** Tipo de producto de la cuenta. */
export const AccountType = z.enum(['checking', 'savings', 'investment', 'credit_card', 'other'])
export type AccountType = z.infer<typeof AccountType>

/** Persona física, persona física con actividad empresarial o persona moral. */
export const HolderType = z.enum(['individual', 'individual_with_business_activity', 'legal_entity'])
export type HolderType = z.infer<typeof HolderType>

/** Estado de la capa de texto del PDF; decide si la extracción va con texto o solo visión. */
export const TextLayer = z.enum(['ok', 'partial', 'corrupt', 'absent'])
export type TextLayer = z.infer<typeof TextLayer>

/** Clasificación de un movimiento (Jev o Haiku), opcional hasta que corre el paso. */
export const TransactionClassification = z
  .strictObject({
    category: TransactionCategory,
    confidence: Confidence,
    counterparty: z.string().nullable().describe('Contraparte identificada en la descripción, si la hay'),
    counterparty_rfc: z.string().nullable().describe('RFC de la contraparte cuando el banco lo imprime (SPEI de Santander, Banamex); validado (docs/09 §9.3)'),
    classifier: z.string().describe('Modelo que clasificó, por ejemplo jev-1.13.0 o claude-haiku-5-5'),
  })
  .meta({ id: 'TransactionClassification' })
export type TransactionClassification = z.infer<typeof TransactionClassification>

export const Transaction = z
  .strictObject({
    id: LocalId.describe('Estable dentro del documento, por ejemplo a1.p1.t0007'),
    date: IsoDate.describe('Fecha de operación'),
    settlement_date: IsoDate.nullable().describe('Fecha de liquidación cuando el banco la imprime aparte (BBVA)'),
    description: z.string().min(1).describe('Concepto tal como aparece, con las líneas unidas por un espacio'),
    reference: z.string().nullable().describe('Referencia, folio o clave de rastreo si viene en columna propia'),
    amount: Money.describe('Monto positivo del movimiento'),
    type: TransactionType,
    balance: SignedMoney.nullable().describe('Saldo después del movimiento; null si el banco no lo imprime en esa fila'),
    internal_transfer: z
      .boolean()
      .describe('Traspaso entre la cuenta y sus propios apartados dentro del mismo estado (cajitas, apartados, reservas); no es dinero que entra o sale del titular'),
    source: SourceRef,
    verification: Verification,
    confidence: Confidence,
    provenance: Provenance,
    classification: TransactionClassification.nullable(),
  })
  .meta({ id: 'Transaction' })
export type Transaction = z.infer<typeof Transaction>

/** Cifras de resumen impresas por el banco para un periodo. Todo es nullable: no todos las imprimen. */
export const PeriodSummary = z
  .strictObject({
    opening_balance: field(SignedMoney),
    closing_balance: field(SignedMoney),
    total_credits: field(Money).describe('Total de abonos o depósitos impreso por el banco'),
    total_debits: field(Money).describe('Total de cargos o retiros impreso por el banco'),
    credits_count: field(Count),
    debits_count: field(Count),
    average_balance: field(SignedMoney).describe('Saldo promedio del periodo'),
    fees_charged: field(Money).describe('Comisiones efectivamente cobradas'),
    interest_earned: field(Money),
    tax_withheld: field(Money).describe('ISR retenido'),
  })
  .meta({ id: 'PeriodSummary' })
export type PeriodSummary = z.infer<typeof PeriodSummary>

const AmountCheck = z.strictObject({
  printed: SignedMoney.nullable(),
  extracted: SignedMoney,
  difference: SignedMoney.nullable(),
  ok: z.boolean().nullable().describe('null si el banco no imprime la cifra y no se puede comparar'),
})

const CountCheck = z.strictObject({
  printed: Count.nullable(),
  extracted: Count,
  ok: z.boolean().nullable(),
})

export const RunningBalanceBreak = z.strictObject({
  transaction_id: LocalId,
  page: z.int().min(1),
  expected_balance: SignedMoney,
  printed_balance: SignedMoney,
  difference: SignedMoney,
})

/** Resultado de la verificación aritmética del periodo (docs/04 §3, puntos 1 a 3). */
export const Reconciliation = z
  .strictObject({
    status: z.enum(['reconciled', 'partially_reconciled', 'not_reconciled', 'not_checkable']),
    tolerance: Money.describe('Tolerancia en la moneda de la cuenta; 1.00 por defecto'),
    global: z
      .strictObject({
        opening_balance: SignedMoney,
        credits: Money,
        debits: Money,
        expected_closing: SignedMoney,
        printed_closing: SignedMoney,
        difference: SignedMoney,
        ok: z.boolean(),
        excludes_internal_transfers: z.boolean().describe('true si el resumen es consolidado y cuadra sin los traspasos internos'),
        adjustments: z
          .array(z.strictObject({ item: z.enum(['interest_earned', 'fees_charged', 'tax_withheld']), amount: SignedMoney }))
          .describe('Conceptos del resumen que el banco no detalla como movimiento y entran al cuadre'),
      })
      .nullable()
      .describe('Saldo inicial + abonos − cargos (± conceptos no detallados) contra saldo final; null si falta alguno'),
    totals: z.strictObject({
      credits: AmountCheck,
      debits: AmountCheck,
      credits_count: CountCheck,
      debits_count: CountCheck,
    }),
    running_balance: z
      .strictObject({
        rows_checked: Count,
        rows_without_balance: Count,
        breaks: z.array(RunningBalanceBreak),
        ok: z.boolean(),
      })
      .nullable()
      .describe('Saldo(n) = saldo(n−1) ± monto(n); null si el banco no imprime saldos por fila'),
  })
  .meta({ id: 'Reconciliation' })
export type Reconciliation = z.infer<typeof Reconciliation>

export const Period = z
  .strictObject({
    id: LocalId,
    period_start: field(IsoDate),
    period_end: field(IsoDate),
    statement_date: field(IsoDate).describe('Fecha de corte'),
    pages: z.array(z.int().min(1)).describe('Páginas del PDF que cubren este periodo'),
    summary: PeriodSummary,
    transactions: z.array(Transaction),
    reconciliation: Reconciliation.nullable().describe('null hasta que corre la verificación'),
  })
  .meta({ id: 'Period' })
export type Period = z.infer<typeof Period>

export const Account = z
  .strictObject({
    id: LocalId,
    product_name: field(z.string()).describe('Nombre del producto tal como aparece (CUENTA SANTANDER PYME)'),
    account_type: field(AccountType),
    account_number: field(z.string()).describe('Número de cuenta tal como aparece; puede venir enmascarado'),
    clabe: field(z.string()).describe('CLABE de 18 dígitos tal como aparece; null si no aparece completa'),
    currency: field(Currency),
    periods: z.array(Period),
  })
  .meta({ id: 'Account' })
export type Account = z.infer<typeof Account>

export const Holder = z
  .strictObject({
    name: field(z.string()),
    rfc: field(z.string()).describe('RFC tal como aparece; puede venir enmascarado'),
    holder_type: field(HolderType),
  })
  .meta({ id: 'Holder' })
export type Holder = z.infer<typeof Holder>

/**
 * CFDI impreso dentro del estado de cuenta (docs/09 §3): la factura que el banco emite al
 * titular por sus comisiones, o la constancia de retenciones de ISR. Es del titular, no de
 * una cuenta. Los sellos y la cadena original completa **no tienen campo**: un modelo al que
 * se le piden los "completa"; solo se registra si están y si se ven cortados. De la cadena
 * original se leen solo tres campos cortos, para cruzarlos con el encabezado del CFDI.
 */
export const FiscalDocument = z
  .strictObject({
    id: LocalId.describe('f1, f2, ...'),
    kind: z.enum(['income', 'withholding', 'other']).describe('income: CFDI de ingreso (tipo I); withholding: constancia de retenciones'),
    version: field(z.string()).describe('"4.0", "3.3"; "2.0" en retenciones'),
    uuid: field(z.string()).describe('Folio fiscal, 8-4-4-4-12 hexadecimal'),
    series: field(z.string()),
    folio: field(z.string()),
    issued_at: field(IsoLocalDateTime).describe('Fecha de expedición o emisión, hora local'),
    certified_at: field(IsoLocalDateTime).describe('Fecha de timbrado o certificación, hora local'),
    issuer_certificate: field(z.string()).describe('Número de serie del certificado del emisor (20 dígitos)'),
    sat_certificate: field(z.string()).describe('Número de serie del certificado del SAT (20 dígitos)'),
    pac_rfc: field(z.string()).describe('RFC del proveedor de certificación'),
    issuer: z.strictObject({ rfc: field(z.string()), name: field(z.string()), tax_regime: field(z.string()) }),
    receiver: z
      .strictObject({ rfc: field(z.string()), name: field(z.string()), tax_regime: field(z.string()), cfdi_use: field(z.string()), postal_code: field(z.string()) })
      .describe('Solo del bloque fiscal; si viene vacío es null, nunca se rellena con el titular del encabezado'),
    payment_form: field(z.string()).describe('Clave de forma de pago, por ejemplo "03"'),
    payment_method: field(z.string()).describe('"PUE" o "PPD"'),
    currency: field(Currency),
    subtotal: field(Money),
    tax: field(Money).describe('IVA trasladado'),
    total: field(Money),
    seals: z.strictObject({
      issuer_present: z.boolean(),
      sat_present: z.boolean(),
      chain_present: z.boolean(),
      looks_truncated: z.boolean().nullable().describe('true si algún sello se ve cortado; null si no se puede saber'),
    }),
    original_chain: z
      .strictObject({ uuid: field(z.string()), certified_at: field(IsoLocalDateTime), sat_certificate: field(z.string()) })
      .describe('Solo los tres campos cortos de la cadena original del complemento de certificación'),
    source: SourceRef,
  })
  .meta({ id: 'FiscalDocument' })
export type FiscalDocument = z.infer<typeof FiscalDocument>

/** Códigos de los problemas que produce la verificación. Cerrados: el reporte y los evals los cuentan. */
export const IssueCode = z.enum([
  'reconciliation_mismatch',
  'totals_mismatch',
  'count_mismatch',
  'running_balance_break',
  'invalid_clabe',
  'invalid_rfc',
  'date_out_of_period',
  'dates_out_of_order',
  'snippet_not_found',
  'double_read_conflict',
  'missing_required_field',
  'block_failed',
  'page_unreadable',
  'currency_inconsistent',
  'duplicate_transaction_removed',
  'possible_prompt_injection',
  'not_a_bank_statement',
  'large_unclassified_credit',
  'invalid_uuid',
  'fiscal_chain_mismatch',
  'fiscal_totals_mismatch',
  'fiscal_fees_mismatch',
  'fiscal_receiver_mismatch',
])
export type IssueCode = z.infer<typeof IssueCode>

export const Issue = z
  .strictObject({
    id: LocalId,
    code: IssueCode,
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).describe('Explicación en español para el analista'),
    page: z.int().min(1).nullable(),
    path: z.string().nullable().describe('JSON Pointer al valor afectado dentro de la extracción'),
    account_id: LocalId.nullable(),
    period_id: LocalId.nullable(),
    transaction_id: LocalId.nullable(),
    details: z.record(z.string(), z.json()),
  })
  .meta({ id: 'Issue' })
export type Issue = z.infer<typeof Issue>

/** Banderas de nivel documento para el reporte. */
export const DocumentFlag = z.enum([
  'not_a_bank_statement',
  'classifier_fallback',
  'vision_only',
  'multi_account',
  'multi_period',
  'partial_extraction',
  'reconciliation_failed',
  'possible_prompt_injection',
  'fiscal_document_present',
])
export type DocumentFlag = z.infer<typeof DocumentFlag>

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

/** Una llamada a un modelo durante la extracción, con lo que costó. */
export const ModelCall = z
  .strictObject({
    purpose: z.string().describe('classify, summary, transactions, retry_page, double_read, citations'),
    model: z.string(),
    prompt: z.string().nullable().describe('Nombre y versión del prompt, por ejemplo extract_summary.v1'),
    effort: Effort.nullable(),
    pages: z.array(z.int().min(1)),
    usage: TokenUsage,
    cost_usd: z.number().nonnegative(),
    latency_ms: Count,
    response_cache_hit: z.boolean().describe('true si la respuesta salió de la caché local por hash, sin llamar al modelo'),
  })
  .meta({ id: 'ModelCall' })
export type ModelCall = z.infer<typeof ModelCall>

export const ExtractionRun = z
  .strictObject({
    status: z.enum(['complete', 'partial', 'failed']),
    started_at: IsoDateTime,
    finished_at: IsoDateTime,
    duration_ms: Count,
    extraction_model: z.string(),
    classifier: z.strictObject({
      implementation: z.enum(['jev', 'claude']),
      model: z.string(),
      fallback: z.boolean().describe('true si Jev no estaba disponible y se usó Claude'),
    }),
    prompts: z.record(z.string(), z.string()).describe('Prompt → versión usada'),
    calls: z.array(ModelCall),
    usage: TokenUsage,
    cost_usd: z.number().nonnegative(),
    failure_reason: z.string().nullable(),
  })
  .meta({ id: 'ExtractionRun' })
export type ExtractionRun = z.infer<typeof ExtractionRun>

export const StatementExtraction = z
  .strictObject({
    schema_version: z.literal(STATEMENT_SCHEMA_VERSION),
    document: z.strictObject({
      file_name: z.string().min(1),
      sha256: Sha256,
      size_bytes: Count,
      page_count: z.int().min(1),
      text_layer: TextLayer,
      route: z.enum(['text_and_vision', 'vision_only']),
    }),
    classification: z.strictObject({
      document_type: DocumentType,
      confidence: Confidence,
      bank: z.string().nullable().describe('Banco identificado por el clasificador'),
    }),
    bank_name: field(z.string()).describe('Institución emisora tal como aparece'),
    holder: Holder,
    accounts: z.array(Account),
    fiscal_documents: z.array(FiscalDocument).describe('CFDI impresos en el documento (docs/09); lista vacía si no hay'),
    issues: z.array(Issue),
    flags: z.array(DocumentFlag),
    extraction: ExtractionRun,
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>()
    const claim = (id: string, path: (string | number)[]) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: `id repetido "${id}": cuentas, periodos, movimientos e issues deben tener ids únicos` })
      seen.add(id)
    }
    doc.accounts.forEach((a, ai) => {
      claim(a.id, ['accounts', ai, 'id'])
      a.periods.forEach((p, pi) => {
        claim(p.id, ['accounts', ai, 'periods', pi, 'id'])
        p.transactions.forEach((t, ti) => {
          claim(t.id, ['accounts', ai, 'periods', pi, 'transactions', ti, 'id'])
          if (t.source.page > doc.document.page_count) {
            ctx.addIssue({ code: 'custom', path: ['accounts', ai, 'periods', pi, 'transactions', ti, 'source', 'page'], message: `la página ${String(t.source.page)} no existe; el documento tiene ${String(doc.document.page_count)}` })
          }
        })
      })
    })
    doc.issues.forEach((i, ii) => {
      claim(i.id, ['issues', ii, 'id'])
    })
    doc.fiscal_documents.forEach((f, fi) => {
      claim(f.id, ['fiscal_documents', fi, 'id'])
      if (f.source.page > doc.document.page_count) {
        ctx.addIssue({ code: 'custom', path: ['fiscal_documents', fi, 'source', 'page'], message: `la página ${String(f.source.page)} no existe; el documento tiene ${String(doc.document.page_count)}` })
      }
    })
  })
  .meta({ id: 'StatementExtraction', title: 'Extracción de estado de cuenta', description: 'Contrato de extracción de GOW Credit (docs/07 B)' })
export type StatementExtraction = z.infer<typeof StatementExtraction>
