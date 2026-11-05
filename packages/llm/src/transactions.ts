/**
 * Clasificación de movimientos (docs/02 §4c, paso `classifyTransactions`; ADR 0015). Jev si hay
 * TYPESAFE_API_KEY (probabilidades calibradas), si no Haiku con salida estructurada. Se mandan
 * lotes de hasta 25 movimientos como estado JSON con una pregunta por fila; las opciones dependen
 * del sentido (un abono no puede ser nómina). Qué filas se mandan y cómo se combina la etiqueta
 * con las reglas lo decide `@gow/decision` (combine.ts), no este paquete.
 */
import { TransactionCategory, type TokenUsage } from '@gow/contracts'
import { choice, TypeSafeClient, type ChoiceQuestion } from '@typesafe-ai/sdk'
import { z } from 'zod'
import { hashKey, type JsonFileCache } from './json-cache.ts'
import { costUsd, JEV_MODEL, LIGHT_MODEL, ZERO_USAGE } from './models.ts'
import { loadPrompt } from './prompts.ts'
import type { StructuredLlm } from './structured.ts'

export const TRANSACTION_BATCH_SIZE = 25
/** Versión de las preguntas a Jev (viven en código, no en prompts/; se versionan igual). */
export const JEV_TRANSACTION_QUESTIONS = 'jev_classify_transactions.v1'

export interface TransactionRow {
  id: string
  date: string
  type: 'credit' | 'debit'
  amount: number
  description: string
  reference: string | null
}

export interface TransactionLabel {
  id: string
  category: TransactionCategory
  /** Calibrada en Jev; en Haiku es nominal y no se usa (spike 3). */
  confidence: number
}

export interface TransactionBatchResult {
  labels: TransactionLabel[]
  model: string
  usage: TokenUsage
  costUsd: number
  latencyMs: number
  responseCacheHit: boolean
  promptId: string
}

export interface TransactionClassifier {
  readonly implementation: 'jev' | 'claude'
  readonly model: string
  readonly calibrated: boolean
  /** true si no había llave de Jev y clasifica Haiku. */
  readonly fallback: boolean
  classifyBatch(rows: readonly TransactionRow[], ctx: { bank: string | null }): Promise<TransactionBatchResult>
}

const CREDIT_OPTIONS = {
  customer_payment: 'Cobro a un cliente o venta: transferencia de un tercero, depósito por una venta, liquidación de terminal o plataforma',
  own_transfer: 'Dinero del propio titular que viene de otra cuenta suya o de una inversión',
  loan_disbursement: 'Préstamo o crédito recibido de un banco, financiera o fintech',
  interest: 'Intereses o rendimientos',
  other: 'Devolución, reembolso, nómina recibida u otra cosa',
} as const satisfies Partial<Record<TransactionCategory, string>>

const DEBIT_OPTIONS = {
  supplier_payment: 'Pago a un proveedor o a un tercero por bienes o servicios',
  payroll: 'Nómina o pagos a empleados',
  tax: 'Impuestos o cuotas de seguridad social (SAT, IMSS, INFONAVIT)',
  fee: 'Comisión del banco o IVA de una comisión',
  loan_payment: 'Pago a un crédito, préstamo o tarjeta',
  own_transfer: 'Envío a otra cuenta del propio titular o a una inversión',
  interest: 'Intereses cobrados',
  other: 'Retiro de efectivo, compra con tarjeta u otra cosa',
} as const satisfies Partial<Record<TransactionCategory, string>>

export function allowedCategories(type: TransactionRow['type']): readonly TransactionCategory[] {
  return Object.keys(type === 'credit' ? CREDIT_OPTIONS : DEBIT_OPTIONS) as TransactionCategory[]
}

function stateRows(rows: readonly TransactionRow[]) {
  return rows.map((r) => ({
    id: r.id,
    fecha: r.date,
    sentido: r.type === 'credit' ? 'abono' : 'cargo',
    monto: r.amount,
    concepto: r.reference ? `${r.description} ${r.reference}` : r.description,
  }))
}

interface CachedBatch {
  labels: TransactionLabel[]
  model: string
  usage: TokenUsage
  original_cost_usd: number
}

export class JevTransactionClassifier implements TransactionClassifier {
  readonly implementation = 'jev' as const
  readonly model = JEV_MODEL
  readonly calibrated = true
  readonly fallback = false
  readonly #client: TypeSafeClient
  readonly #cache: JsonFileCache

  constructor(apiKey: string, cache: JsonFileCache) {
    this.#client = new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL })
    this.#cache = cache
  }

  async classifyBatch(rows: readonly TransactionRow[], ctx: { bank: string | null }): Promise<TransactionBatchResult> {
    const key = hashKey({ v: 1, q: JEV_TRANSACTION_QUESTIONS, model: JEV_MODEL, bank: ctx.bank, rows })
    const started = Date.now()
    const { value, hit } = await this.#cache.through<CachedBatch>(key, 'clasificación de movimientos con Jev', async () => {
      const questions: Record<string, ChoiceQuestion<Record<string, string>>> = {}
      rows.forEach((r, i) => {
        questions[`r${String(i)}`] = choice(`Movimiento ${r.id} (${r.type === 'credit' ? 'abono' : 'cargo'}) del estado de cuenta: ¿qué es?`, r.type === 'credit' ? CREDIT_OPTIONS : DEBIT_OPTIONS)
      })
      const res = await this.#client.systemOne({ state: { banco: ctx.bank ?? 'desconocido', movimientos: stateRows(rows) }, questions })
      const labels: TransactionLabel[] = []
      rows.forEach((r, i) => {
        const a = res.answers[`r${String(i)}`]
        const cat = TransactionCategory.safeParse(a?.choice)
        if (a && cat.success && allowedCategories(r.type).includes(cat.data)) labels.push({ id: r.id, category: cat.data, confidence: a.confidence })
      })
      const usage = { ...ZERO_USAGE, input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0 }
      const model = res.model || JEV_MODEL
      return { labels, model, usage, original_cost_usd: costUsd(model, usage) }
    })
    return { labels: value.labels, model: value.model, usage: value.usage, costUsd: hit ? 0 : value.original_cost_usd, latencyMs: hit ? 0 : Date.now() - started, responseCacheHit: hit, promptId: JEV_TRANSACTION_QUESTIONS }
  }
}

const HaikuLabels = z.object({
  labels: z.array(z.object({ id: z.string(), category: TransactionCategory })),
})

export class ClaudeTransactionClassifier implements TransactionClassifier {
  readonly implementation = 'claude' as const
  readonly model = LIGHT_MODEL
  readonly calibrated = false
  readonly fallback: boolean
  readonly #llm: StructuredLlm

  constructor(llm: StructuredLlm, opts: { isFallback: boolean }) {
    this.#llm = llm
    this.fallback = opts.isFallback
  }

  async classifyBatch(rows: readonly TransactionRow[], ctx: { bank: string | null }): Promise<TransactionBatchResult> {
    const prompt = loadPrompt('classify_transactions', 1, {
      bank: ctx.bank ?? 'banco desconocido',
      rows: JSON.stringify(rows.map((r) => ({ id: r.id, type: r.type, date: r.date, amount: r.amount, description: r.reference ? `${r.description} ${r.reference}` : r.description }))),
    })
    const res = await this.#llm.call({
      purpose: 'classify_transactions',
      model: LIGHT_MODEL,
      system: 'Clasificas movimientos de estados de cuenta bancarios mexicanos. Respondes solo con el JSON pedido.',
      document: null,
      instruction: prompt.text,
      schema: HaikuLabels,
      schemaName: 'transaction_labels.v1',
      promptVersion: prompt.id,
      effort: 'low',
      maxOutputTokens: 8000,
      serverFallback: false,
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const labels: TransactionLabel[] = []
    for (const l of res.object.labels) {
      const row = byId.get(l.id)
      // Una categoría que no corresponde al sentido (un abono como nómina) se descarta: quedan las reglas.
      if (row && allowedCategories(row.type).includes(l.category)) labels.push({ id: l.id, category: l.category, confidence: 0.5 })
    }
    return { labels, model: res.model, usage: res.usage, costUsd: res.costUsd, latencyMs: res.latencyMs, responseCacheHit: res.responseCacheHit, promptId: prompt.id }
  }
}

export function createTransactionClassifier(llm: StructuredLlm, cache: JsonFileCache, env: NodeJS.ProcessEnv = process.env): TransactionClassifier {
  const key = env.TYPESAFE_API_KEY?.trim()
  if (key) return new JevTransactionClassifier(key, cache)
  return new ClaudeTransactionClassifier(llm, { isFallback: true })
}

export interface ClassifyRowsResult {
  labels: TransactionLabel[]
  batches: TransactionBatchResult[]
}

/** Clasifica en lotes; `limit` es el semáforo de llamadas del proceso. */
export async function classifyTransactionRows(
  classifier: TransactionClassifier,
  rows: readonly TransactionRow[],
  ctx: { bank: string | null; limit: <T>(task: () => Promise<T>) => Promise<T>; batchSize?: number },
): Promise<ClassifyRowsResult> {
  const size = ctx.batchSize ?? TRANSACTION_BATCH_SIZE
  const chunks: TransactionRow[][] = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  const batches = await Promise.all(chunks.map((c) => ctx.limit(() => classifier.classifyBatch(c, { bank: ctx.bank }))))
  return { labels: batches.flatMap((b) => b.labels), batches }
}
