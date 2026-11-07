/**
 * Puerto de llamadas estructuradas. La extracción depende de esta interfaz, no de Mastra ni
 * del SDK: el adaptador por defecto es Mastra (spike 1) y la caché de respuestas por hash es
 * un decorador. Si algún día hay que usar la salida de emergencia, cambia el adaptador y
 * nada más.
 */
import type { TokenUsage } from '@gow/contracts'
import type { z } from 'zod'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PdfInput {
  /** PDF en base64, sin saltos de línea. */
  base64: string
  /** sha256 del PDF: entra en la llave de la caché de respuestas. */
  sha256: string
  /** Marca el bloque del documento con cache_control para reutilizarlo entre llamadas. */
  cache: boolean
}

export interface StructuredRequest<T> {
  /** Para trazas y costo: classify, summary, transactions, retry_page, double_read. */
  purpose: string
  model: string
  /** System prompt estable: mismo texto en todas las llamadas sobre un documento (caché). */
  system: string
  document: PdfInput | null
  /** Va después del documento: es lo único que cambia entre pasadas. */
  instruction: string
  schema: z.ZodType<T>
  /** Nombre del esquema para la llave de caché y las trazas, con versión (extraction_chunk.v1). */
  schemaName: string
  promptVersion: string
  effort: Effort
  maxOutputTokens: number
  /** Fallback del servidor ante refusal; Haiku no lo soporta. */
  serverFallback: boolean
}

export interface StructuredResult<T> {
  object: T
  /** Uso reportado por la API (en un hit de caché local: el de la llamada original). */
  usage: TokenUsage
  /** Costo de esta corrida: 0 si la respuesta salió de la caché local. */
  costUsd: number
  latencyMs: number
  model: string
  finishReason: string
  responseCacheHit: boolean
}

export interface StructuredLlm {
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>
}

/** Error de la llamada al modelo con un código estable para issues y reportes (sin PII). */
export class LlmCallError extends Error {
  readonly code: 'missing_api_key' | 'api_error' | 'invalid_output' | 'refusal' | 'max_tokens' | 'timeout'
  readonly retryable: boolean
  readonly status: number | null
  /**
   * Lo que devolvió el modelo cuando no sirvió (cortado, sin validar). Lleva datos del documento:
   * solo para la grabación de intercambios (ADR 0064), nunca para el mensaje ni para logs.
   */
  readonly rawOutput: string | null

  constructor(code: LlmCallError['code'], message: string, opts: { retryable?: boolean; status?: number | null; cause?: unknown; rawOutput?: string | null } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'LlmCallError'
    this.code = code
    this.retryable = opts.retryable ?? false
    this.status = opts.status ?? null
    this.rawOutput = opts.rawOutput ?? null
  }
}
