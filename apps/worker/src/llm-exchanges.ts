/**
 * Postgres sink for model exchange recording: one row per call in `app.llm_exchanges`, in the
 * scope's tenant transaction. With no tenant in scope there is nobody to attribute it to and it is
 * not stored (does not happen in the worker: each job opens its scope).
 */
import { llmExchanges, withTenant, type Db } from '@gow/db'
import { boundText, MAX_RAW_CHARS, type LlmExchange, type LlmExchangeSink, type LlmScope } from '@gow/llm'

/** Postgres accepts U+0000 neither in text nor in jsonb. */
function text(value: string): string {
  return value.replaceAll('\u0000', '')
}

/** The object as jsonb; if huge, it is truncated as text into `raw_output`. */
function responseColumns(e: LlmExchange): { response: unknown; rawOutput: string | null } {
  if (e.response === null || e.response === undefined) return { response: null, rawOutput: e.rawOutput === null ? null : text(e.rawOutput) }
  const json = JSON.stringify(e.response).replaceAll('\\u0000', '')
  if (json.length > MAX_RAW_CHARS) return { response: null, rawOutput: boundText(json) }
  return { response: JSON.parse(json) as unknown, rawOutput: e.rawOutput === null ? null : text(e.rawOutput) }
}

export class DbLlmExchangeSink implements LlmExchangeSink {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async record(e: LlmExchange, scope: LlmScope): Promise<void> {
    if (!scope.tenantId) return
    const { response, rawOutput } = responseColumns(e)
    await withTenant(this.#db, scope.tenantId, (tx) =>
      tx.insert(llmExchanges).values({
        tenantId: scope.tenantId ?? '',
        applicationId: scope.applicationId ?? null,
        inboundMessageId: scope.inboundMessageId ?? null,
        purpose: e.purpose,
        model: e.model,
        schemaName: e.schemaName,
        promptVersion: e.promptVersion,
        effort: e.effort,
        maxOutputTokens: e.maxOutputTokens,
        serverFallback: e.serverFallback,
        system: text(boundText(e.system) ?? ''),
        instruction: text(boundText(e.instruction) ?? ''),
        documentSha256: e.documentSha256,
        outcome: e.outcome,
        response,
        rawOutput,
        errorCode: e.errorCode,
        errorMessage: e.errorMessage === null ? null : text(e.errorMessage),
        finishReason: e.finishReason,
        responseCacheHit: e.responseCacheHit,
        usage: e.usage,
        costUsd: e.costUsd.toFixed(6),
        latencyMs: Math.max(0, Math.round(e.latencyMs)),
        createdAt: new Date(e.at),
      }),
    )
  }
}
