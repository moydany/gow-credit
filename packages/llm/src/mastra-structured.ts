/**
 * Adaptador por defecto del puerto: un Agent de Mastra por (modelo, system prompt), con el
 * proveedor de AI SDK. Lo verificado en el spike 1: el PDF va como bloque `document` con
 * `cache_control`, la salida estructurada va nativa por `output_config.format`, y
 * `thinking`, `effort` y `fallbacks` llegan tal cual.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import type { TokenUsage } from '@gow/contracts'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { readAnthropicEnv, type AnthropicEnv } from './env.ts'
import { costUsd } from './models.ts'
import { LlmCallError, type StructuredLlm, type StructuredRequest, type StructuredResult } from './structured.ts'

interface UsageLike {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cachedInputTokens?: number | undefined
  cacheCreationInputTokens?: number | undefined
}

function toTokenUsage(u: UsageLike, raw: Record<string, unknown> | undefined): TokenUsage {
  // Preferimos el objeto crudo de Anthropic; si no está, se reconstruye desde el normalizado.
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (raw && typeof raw.input_tokens === 'number') {
    return {
      input_tokens: n(raw.input_tokens),
      output_tokens: n(raw.output_tokens),
      cache_creation_input_tokens: n(raw.cache_creation_input_tokens),
      cache_read_input_tokens: n(raw.cache_read_input_tokens),
    }
  }
  const read = n(u.cachedInputTokens)
  const write = n(u.cacheCreationInputTokens)
  return { input_tokens: Math.max(0, n(u.inputTokens) - read - write), output_tokens: n(u.outputTokens), cache_creation_input_tokens: write, cache_read_input_tokens: read }
}

function classifyError(err: unknown): LlmCallError {
  if (err instanceof LlmCallError) return err
  const e = err as { statusCode?: number; isRetryable?: boolean; message?: string; name?: string }
  const status = typeof e.statusCode === 'number' ? e.statusCode : null
  // Nunca se propaga el cuerpo del request (lleva el PDF): solo estado y un mensaje corto.
  const short = (e.message ?? String(err)).split('\n')[0]?.slice(0, 300) ?? 'error desconocido'
  if (status !== null) return new LlmCallError('api_error', `Anthropic respondió ${String(status)}: ${short}`, { status, retryable: e.isRetryable ?? (status >= 500 || status === 429) })
  if (/schema|parse|json|validation|structured/i.test(short)) return new LlmCallError('invalid_output', `salida estructurada inválida: ${short}`, { retryable: true })
  if (/timeout|aborted/i.test(short)) return new LlmCallError('timeout', short, { retryable: true })
  return new LlmCallError('api_error', short, { retryable: true })
}

export class MastraStructuredLlm implements StructuredLlm {
  readonly #agents = new Map<string, Agent>()
  readonly #provider: ReturnType<typeof createAnthropic>
  readonly #maxRetries: number

  constructor(env: AnthropicEnv = readAnthropicEnv(), opts: { maxRetries?: number } = {}) {
    if (!env.apiKey) throw new LlmCallError('missing_api_key', 'Falta ANTHROPIC_API_KEY (en el entorno o en .env).')
    this.#provider = createAnthropic({
      apiKey: env.apiKey,
      ...(env.baseURL ? { baseURL: env.baseURL } : {}),
      ...(env.workspaceId ? { headers: { 'anthropic-workspace-id': env.workspaceId } } : {}),
    })
    this.#maxRetries = opts.maxRetries ?? 3
  }

  #agent(model: string, system: string): Agent {
    const key = `${model}\u0000${system}`
    let agent = this.#agents.get(key)
    if (!agent) {
      agent = new Agent({ id: `gow-${model}-${String(this.#agents.size)}`, name: 'gow-structured', instructions: system, model: this.#provider(model), maxRetries: this.#maxRetries })
      // El logger de Mastra imprime el error crudo (headers y partes del request). Sin PII en
      // logs: se silencia y el error sale saneado por classifyError.
      agent.__setLogger(noopLogger)
      this.#agents.set(key, agent)
    }
    return agent
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const agent = this.#agent(req.model, req.system)
    const content = [
      ...(req.document
        ? [
            {
              type: 'file' as const,
              data: req.document.base64,
              mediaType: 'application/pdf',
              ...(req.document.cache ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } } : {}),
            },
          ]
        : []),
      { type: 'text' as const, text: req.instruction },
    ]
    const started = Date.now()
    try {
      const out = await agent.stream([{ role: 'user' as const, content }], {
        structuredOutput: { schema: req.schema, errorStrategy: 'strict' },
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' as const },
            effort: req.effort,
            structuredOutputMode: 'outputFormat' as const,
            ...(req.serverFallback ? { fallbacks: 'default' as const } : {}),
          },
        },
        modelSettings: { maxOutputTokens: req.maxOutputTokens },
      })
      const [object, usage, finishReason, providerMetadata] = await Promise.all([out.object, out.usage, out.finishReason, out.providerMetadata])
      const raw = (providerMetadata?.anthropic as { usage?: Record<string, unknown> } | undefined)?.usage
      const tokenUsage = toTokenUsage(usage, raw)
      if (finishReason === 'length') throw new LlmCallError('max_tokens', `la respuesta se cortó en maxOutputTokens=${String(req.maxOutputTokens)}`, { retryable: false })
      if (finishReason === 'content-filter') throw new LlmCallError('refusal', 'el modelo declinó la solicitud', { retryable: false })
      const parsed = req.schema.safeParse(object)
      if (!parsed.success) throw new LlmCallError('invalid_output', 'la salida no valida contra el esquema', { retryable: true, cause: parsed.error })
      return {
        object: parsed.data,
        usage: tokenUsage,
        costUsd: costUsd(req.model, tokenUsage),
        latencyMs: Date.now() - started,
        model: req.model,
        finishReason: finishReason ?? 'unknown',
        responseCacheHit: false,
      }
    } catch (err) {
      throw classifyError(err)
    }
  }
}
