/**
 * Grabación de cada intercambio con un modelo (ADR 0064). Decorador del puerto: va por fuera de la
 * caché de respuestas, así que también queda lo que salió de ella (marcado), y nunca cambia el
 * resultado de la llamada: si guardar falla, se avisa por `onError` y la llamada sigue.
 *
 * El intercambio pertenece a lo que se esté procesando: el worker abre un ámbito por trabajo
 * (`withLlmScope`) y todas las llamadas dentro de él, aunque pasen por el clasificador, el
 * redactor o el limitador, lo heredan por AsyncLocalStorage.
 *
 * Lleva datos del documento (prompts, respuestas): el destino es una tabla con RLS o un archivo en
 * data/, nunca un log. El PDF no se copia: va su sha256.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TokenUsage } from '@gow/contracts'
import { LlmCallError, type StructuredLlm, type StructuredRequest, type StructuredResult } from './structured.ts'

export interface LlmScope {
  tenantId?: string
  /** Solicitud en curso (uuid en modo full; el id del PDF en standalone). */
  applicationId?: string
  inboundMessageId?: string
}

export interface LlmExchange {
  purpose: string
  model: string
  schemaName: string
  promptVersion: string
  effort: string
  maxOutputTokens: number
  serverFallback: boolean
  system: string
  instruction: string
  documentSha256: string | null
  outcome: 'ok' | 'error'
  response: unknown
  rawOutput: string | null
  errorCode: string | null
  errorMessage: string | null
  finishReason: string | null
  responseCacheHit: boolean
  usage: TokenUsage | null
  costUsd: number
  latencyMs: number
  at: string
}

export interface LlmExchangeSink {
  record(exchange: LlmExchange, scope: LlmScope): Promise<void>
}

const scopes = new AsyncLocalStorage<LlmScope>()

/** Corre `fn` con las llamadas al modelo atribuidas a `scope`. */
export function withLlmScope<T>(scope: LlmScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn)
}

export function currentLlmScope(): LlmScope | undefined {
  return scopes.getStore()
}

/** Tope por campo: una respuesta enorme no debe tumbar la inserción ni la página. */
export const MAX_RAW_CHARS = 1_000_000

export function boundText(text: string | null | undefined, max = MAX_RAW_CHARS): string | null {
  if (text === null || text === undefined) return null
  return text.length > max ? `${text.slice(0, max)}\n…[recortado: ${String(text.length - max)} caracteres más]` : text
}

function errorOf(err: unknown): { code: string; message: string; raw: string | null } {
  if (err instanceof LlmCallError) return { code: err.code, message: err.message, raw: boundText(err.rawOutput) }
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'unknown', message: message.split('\n')[0]?.slice(0, 500) ?? 'error', raw: null }
}

export class RecordingStructuredLlm implements StructuredLlm {
  readonly #inner: StructuredLlm
  readonly #sink: LlmExchangeSink
  readonly #onError: (message: string) => void

  constructor(inner: StructuredLlm, sink: LlmExchangeSink, opts: { onError?: (message: string) => void } = {}) {
    this.#inner = inner
    this.#sink = sink
    this.#onError = opts.onError ?? (() => undefined)
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const scope = currentLlmScope() ?? {}
    const started = Date.now()
    const base = {
      purpose: req.purpose,
      model: req.model,
      schemaName: req.schemaName,
      promptVersion: req.promptVersion,
      effort: req.effort,
      maxOutputTokens: req.maxOutputTokens,
      serverFallback: req.serverFallback,
      system: req.system,
      instruction: req.instruction,
      documentSha256: req.document?.sha256 ?? null,
      at: new Date(started).toISOString(),
    }
    try {
      const res = await this.#inner.call(req)
      await this.#save({ ...base, outcome: 'ok', response: res.object, rawOutput: null, errorCode: null, errorMessage: null, finishReason: res.finishReason, responseCacheHit: res.responseCacheHit, usage: res.usage, costUsd: res.costUsd, latencyMs: res.latencyMs }, scope)
      return res
    } catch (err) {
      const e = errorOf(err)
      await this.#save({ ...base, outcome: 'error', response: null, rawOutput: e.raw, errorCode: e.code, errorMessage: e.message, finishReason: null, responseCacheHit: false, usage: null, costUsd: 0, latencyMs: Date.now() - started }, scope)
      throw err
    }
  }

  async #save(exchange: LlmExchange, scope: LlmScope): Promise<void> {
    try {
      await this.#sink.record(exchange, scope)
    } catch (err) {
      // Solo el tipo de error: el mensaje del destino podría citar el contenido.
      this.#onError(`no se guardó el intercambio con el modelo (${exchange.purpose}): ${err instanceof Error ? err.name : 'error'}`)
    }
  }
}

/**
 * Destino en archivos del modo standalone: una línea JSON por intercambio en
 * `<dir>/<solicitud>.llm.jsonl`, junto a la extracción (data/ no se versiona).
 */
export class JsonlLlmExchangeSink implements LlmExchangeSink {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  pathFor(applicationId: string | undefined): string {
    return join(this.#dir, `${(applicationId ?? 'sin-solicitud').replace(/[^\w.-]/g, '_')}.llm.jsonl`)
  }

  record(exchange: LlmExchange, scope: LlmScope): Promise<void> {
    mkdirSync(this.#dir, { recursive: true })
    appendFileSync(this.pathFor(scope.applicationId), `${JSON.stringify({ application_id: scope.applicationId ?? null, ...exchange })}\n`)
    return Promise.resolve()
  }
}
