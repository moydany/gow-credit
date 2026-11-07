/**
 * Port for structured calls. Extraction depends on this interface, not on Mastra or the SDK: the
 * default adapter is Mastra and the hash-keyed response cache is a decorator. To use the
 * emergency output, only the adapter changes.
 */
import type { TokenUsage } from '@gow/contracts'
import type { z } from 'zod'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PdfInput {
  /** Base64 PDF, without line breaks. */
  base64: string
  /** sha256 of the PDF: part of the response cache key. */
  sha256: string
  /** Marks the document block with cache_control so it is reused across calls. */
  cache: boolean
}

export interface StructuredRequest<T> {
  /** For traces and cost: classify, summary, transactions, retry_page, double_read. */
  purpose: string
  model: string
  /** Stable system prompt: same text on every call about a document (cache). */
  system: string
  document: PdfInput | null
  /** Goes after the document: the only thing that changes between passes. */
  instruction: string
  schema: z.ZodType<T>
  /** Schema name for the cache key and traces, versioned (extraction_chunk.v1). */
  schemaName: string
  promptVersion: string
  effort: Effort
  maxOutputTokens: number
  /** Server fallback on refusal; Haiku does not support it. */
  serverFallback: boolean
}

export interface StructuredResult<T> {
  object: T
  /** Usage reported by the API (on a local cache hit: that of the original call). */
  usage: TokenUsage
  /** Cost of this run: 0 if the response came from the local cache. */
  costUsd: number
  latencyMs: number
  model: string
  finishReason: string
  responseCacheHit: boolean
}

export interface StructuredLlm {
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>
}

/** Model call error with a stable code for issues and reports (no PII). */
export class LlmCallError extends Error {
  readonly code: 'missing_api_key' | 'api_error' | 'invalid_output' | 'refusal' | 'max_tokens' | 'timeout'
  readonly retryable: boolean
  readonly status: number | null
  /**
   * What the model returned when it was unusable (truncated, unvalidated). Carries document data:
   * only for exchange recording, never for the message or logs.
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
