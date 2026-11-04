/**
 * Adaptador por defecto del puerto: un Agent de Mastra por (modelo, system prompt), con el
 * proveedor de AI SDK. Lo verificado en el spike 1: el PDF va como bloque `document` con
 * `cache_control`, la salida estructurada va nativa por `output_config.format`, y
 * `thinking`, `effort` y `fallbacks` llegan tal cual.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { TokenUsage } from '@gow/contracts'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { readAnthropicEnv, readGoogleEnv, type AnthropicEnv, type GoogleEnv } from './env.ts'
import { costUsd, providerOf, type Provider } from './models.ts'
import { LlmCallError, type Effort, type StructuredLlm, type StructuredRequest, type StructuredResult } from './structured.ts'

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

/** Gemini piensa por niveles, no por effort: low → low, medium → medium, high o más → high. */
export function geminiThinkingLevel(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high'
}

/** Uso de Gemini en el mismo formato: lo cacheado es lectura implícita; el pensamiento se cobra como salida. */
function googleUsage(u: UsageLike, raw: Record<string, unknown> | undefined): TokenUsage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (raw && typeof raw.promptTokenCount === 'number') {
    const cached = n(raw.cachedContentTokenCount)
    return { input_tokens: Math.max(0, n(raw.promptTokenCount) - cached), output_tokens: n(raw.candidatesTokenCount) + n(raw.thoughtsTokenCount), cache_creation_input_tokens: 0, cache_read_input_tokens: cached }
  }
  const cached = n(u.cachedInputTokens)
  return { input_tokens: Math.max(0, n(u.inputTokens) - cached), output_tokens: n(u.outputTokens), cache_creation_input_tokens: 0, cache_read_input_tokens: cached }
}

export class MastraStructuredLlm implements StructuredLlm {
  readonly #agents = new Map<string, Agent>()
  readonly #anthropic: ReturnType<typeof createAnthropic> | null
  readonly #google: ReturnType<typeof createGoogleGenerativeAI> | null
  readonly #maxRetries: number

  constructor(env: AnthropicEnv = readAnthropicEnv(), opts: { maxRetries?: number; google?: GoogleEnv } = {}) {
    const google = opts.google ?? readGoogleEnv()
    if (!env.apiKey && !google.apiKey) throw new LlmCallError('missing_api_key', 'Falta ANTHROPIC_API_KEY (en el entorno o en .env).')
    this.#anthropic = env.apiKey
      ? createAnthropic({
          apiKey: env.apiKey,
          ...(env.baseURL ? { baseURL: env.baseURL } : {}),
          ...(env.workspaceId ? { headers: { 'anthropic-workspace-id': env.workspaceId } } : {}),
        })
      : null
    this.#google = google.apiKey ? createGoogleGenerativeAI({ apiKey: google.apiKey, ...(google.baseURL ? { baseURL: google.baseURL } : {}) }) : null
    this.#maxRetries = opts.maxRetries ?? 3
  }

  #model(model: string, provider: Provider) {
    if (provider === 'anthropic') {
      if (!this.#anthropic) throw new LlmCallError('missing_api_key', `Falta ANTHROPIC_API_KEY para ${model}.`)
      return this.#anthropic(model)
    }
    if (!this.#google) throw new LlmCallError('missing_api_key', `Falta GOOGLE_GENERATIVE_AI_API_KEY para ${model} (proveedor experimental, ADR 0010).`)
    return this.#google(model)
  }

  #agent(model: string, provider: Provider, system: string): Agent {
    const key = `${model}\u0000${system}`
    let agent = this.#agents.get(key)
    if (!agent) {
      agent = new Agent({ id: `gow-${model}-${String(this.#agents.size)}`, name: 'gow-structured', instructions: system, model: this.#model(model, provider), maxRetries: this.#maxRetries })
      // El logger de Mastra imprime el error crudo (headers y partes del request). Sin PII en
      // logs: se silencia y el error sale saneado por classifyError.
      agent.__setLogger(noopLogger)
      this.#agents.set(key, agent)
    }
    return agent
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const provider = providerOf(req.model)
    const agent = this.#agent(req.model, provider, req.system)
    const content = [
      ...(req.document
        ? [
            {
              type: 'file' as const,
              data: req.document.base64,
              mediaType: 'application/pdf',
              // Gemini cachea el prefijo de forma implícita; cache_control solo existe en Anthropic.
              ...(req.document.cache && provider === 'anthropic' ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } } : {}),
            },
          ]
        : []),
      { type: 'text' as const, text: req.instruction },
    ]
    const providerOptions =
      provider === 'anthropic'
        ? {
            anthropic: {
              thinking: { type: 'adaptive' as const },
              effort: req.effort,
              structuredOutputMode: 'outputFormat' as const,
              ...(req.serverFallback ? { fallbacks: 'default' as const } : {}),
            },
          }
        : { google: { thinkingConfig: { thinkingLevel: geminiThinkingLevel(req.effort) }, structuredOutputs: true } }
    const started = Date.now()
    try {
      const out = await agent.stream([{ role: 'user' as const, content }], {
        structuredOutput: { schema: req.schema, errorStrategy: 'strict' },
        providerOptions,
        modelSettings: { maxOutputTokens: req.maxOutputTokens },
      })
      const [object, usage, finishReason, providerMetadata] = await Promise.all([out.object, out.usage, out.finishReason, out.providerMetadata])
      const tokenUsage =
        provider === 'anthropic'
          ? toTokenUsage(usage, (providerMetadata?.anthropic as { usage?: Record<string, unknown> } | undefined)?.usage)
          : googleUsage(usage, (providerMetadata?.google as { usageMetadata?: Record<string, unknown> } | undefined)?.usageMetadata)
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
