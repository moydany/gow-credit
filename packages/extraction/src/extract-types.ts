import type { DocumentFlag, DocumentType, ModelCall, TokenUsage } from '@gow/contracts'
import type { Classifier, Effort, Limiter, StructuredLlm } from '@gow/llm'

export interface Classified {
  documentType: DocumentType
  classConfidence: number
  classifierBank: string | null
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean }
  flags: DocumentFlag[]
}

export interface ExtractDeps {
  llm: StructuredLlm
  classifier: Classifier
}

export interface ExtractOptions {
  extractionModel?: string
  googleAvailable?: boolean
  providerFallback?: { calls: ModelCall[]; from: string; reason: string; classification: Classified | null }
  blockPages: number
  summaryEffort: Effort
  transactionsEffort: Effort
  retryEffort: Effort
  maxRetryPages: number
  limit: Limiter
  onProgress?: (message: string) => void
  rejectNotStatementAbove?: number
  rejectMultipleStatements?: boolean
}

export const DEFAULT_OPTIONS = {
  blockPages: 4,
  summaryEffort: 'medium',
  transactionsEffort: 'low',
  retryEffort: 'high',
  maxRetryPages: 4,
} as const satisfies Partial<ExtractOptions>

export type CallRecorder = (
  purpose: string,
  prompt: string | null,
  effort: Effort | null,
  pages: number[],
  r: { model: string; usage: TokenUsage; costUsd: number; latencyMs: number; responseCacheHit: boolean },
) => void
