/**
 * Destino en Postgres de la grabación de intercambios con el modelo (ADR 0064): una fila por
 * llamada en `app.llm_exchanges`, en la transacción del tenant del ámbito. Sin tenant en el ámbito
 * no hay a quién atribuirla y no se guarda (no pasa en el worker: cada trabajo abre su ámbito).
 */
import { llmExchanges, withTenant, type Db } from '@gow/db'
import { boundText, MAX_RAW_CHARS, type LlmExchange, type LlmExchangeSink, type LlmScope } from '@gow/llm'

/** Postgres no acepta U+0000 ni en text ni en jsonb. */
function text(value: string): string {
  return value.replaceAll('\u0000', '')
}

/** El objeto como jsonb; si es enorme, va recortado como texto en `raw_output`. */
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
