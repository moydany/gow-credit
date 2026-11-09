/**
 * Default adapter of the port: one Mastra Agent per (model, system prompt), using the AI SDK
 * provider. The PDF goes as a `document` block with `cache_control`, structured output is native
 * via `output_config.format`, and `thinking`, `effort` and `fallbacks` pass through as is.
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
  // Prefer the raw Anthropic object; if absent, rebuild it from the normalized one.
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
  // The request body is never propagated (it carries the PDF): only status and a short message.
  const short = (e.message ?? String(err)).split('\n')[0]?.slice(0, 300) ?? 'error desconocido'
  if (status !== null) return new LlmCallError('api_error', `Anthropic respondió ${String(status)}: ${short}`, { status, retryable: e.isRetryable ?? (status >= 500 || status === 429) })
  if (/schema|parse|json|validation|structured/i.test(short)) return new LlmCallError('invalid_output', `salida estructurada inválida: ${short}`, { retryable: true })
  if (/timeout|aborted/i.test(short)) return new LlmCallError('timeout', short, { retryable: true })
  return new LlmCallError('api_error', short, { retryable: true })
}

/** Gemini thinks in levels, not effort: low -> low, medium -> medium, high or above -> high. */
export function geminiThinkingLevel(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high'
}

/** Gemini usage in the same format: cached is implicit read; thinking is billed as output. */
function googleUsage(u: UsageLike, raw: Record<string, unknown> | undefined): TokenUsage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (raw && typeof raw.promptTokenCount === 'number') {
    const cached = n(raw.cachedContentTokenCount)
    return { input_tokens: Math.max(0, n(raw.promptTokenCount) - cached), output_tokens: n(raw.candidatesTokenCount) + n(raw.thoughtsTokenCount), cache_creation_input_tokens: 0, cache_read_input_tokens: cached }
  }
  const cached = n(u.cachedInputTokens)
  return { input_tokens: Math.max(0, n(u.inputTokens) - cached), output_tokens: n(u.outputTokens), cache_creation_input_tokens: 0, cache_read_input_tokens: cached }
}

function buildDocumentContent<T>(req: StructuredRequest<T>, provider: string) {
  if (!req.document) return []
  return [
    {
      type: 'file' as const,
      data: req.document.base64,
      mediaType: 'application/pdf',
      ...(req.document.cache && provider === 'anthropic' ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } } : {}),
    },
  ]
}

function resolveTokenUsage(
  provider: Provider,
  usage: UsageLike,
  providerMetadata: Record<string, unknown> | undefined,
): TokenUsage {
  if (provider === 'anthropic') {
    const raw = (providerMetadata?.anthropic as { usage?: Record<string, unknown> } | undefined)?.usage
    return toTokenUsage(usage, raw)
  }
  const raw = (providerMetadata?.google as { usageMetadata?: Record<string, unknown> } | undefined)?.usageMetadata
  return googleUsage(usage, raw)
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
    if (!this.#google) throw new LlmCallError('missing_api_key', `Falta GOOGLE_GENERATIVE_AI_API_KEY para ${model} (proveedor experimental).`)
    return this.#google(model)
  }

  #agent(model: string, provider: Provider, system: string): Agent {
    const key = `${model}\u0000${system}`
    let agent = this.#agents.get(key)
    if (!agent) {
      agent = new Agent({ id: `gow-${model}-${String(this.#agents.size)}`, name: 'gow-structured', instructions: system, model: this.#model(model, provider), maxRetries: this.#maxRetries })
      // Mastra's logger prints the raw error (headers and request parts). No PII in logs:
       // it is silenced and the error comes out sanitized by classifyError.
      agent.__setLogger(noopLogger)
      this.#agents.set(key, agent)
    }
    return agent
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const provider = providerOf(req.model)
    const agent = this.#agent(req.model, provider, req.system)
    const content = [
      ...buildDocumentContent(req, provider),
      { type: 'text' as const, text: req.instruction },
    ]
    const anthropicOptions = {
      anthropic: {
        thinking: { type: 'adaptive' as const },
        effort: req.effort,
        structuredOutputMode: 'outputFormat' as const,
        ...(req.serverFallback ? { fallbacks: 'default' as const } : {}),
      },
    }
    const googleOptions = { google: { thinkingConfig: { thinkingLevel: geminiThinkingLevel(req.effort) }, structuredOutputs: true } }
    const providerOptions = provider === 'anthropic' ? anthropicOptions : googleOptions
    const started = Date.now()
    let stream: { text: Promise<string> } | undefined
    try {
      const out = await agent.stream([{ role: 'user' as const, content }], {
        structuredOutput: { schema: req.schema, errorStrategy: 'strict' },
        providerOptions,
        modelSettings: { maxOutputTokens: req.maxOutputTokens },
      })
      stream = out
      const [object, usage, finishReason, providerMetadata] = await Promise.all([out.object, out.usage, out.finishReason, out.providerMetadata])
      const tokenUsage = resolveTokenUsage(provider, usage, providerMetadata)
      await assertFinished(finishReason, req.maxOutputTokens, out)
      const parsed = req.schema.safeParse(object)
      if (!parsed.success) throw new LlmCallError('invalid_output', 'la salida no valida contra el esquema', { retryable: true, cause: parsed.error, rawOutput: JSON.stringify(object) })
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
      const e = classifyError(err)
      // The raw output only travels to exchange recording, never into the message.
      if (e.rawOutput !== null || !stream) throw e
      throw new LlmCallError(e.code, e.message, { retryable: e.retryable, status: e.status, cause: e.cause, rawOutput: await textOf(stream) })
    }
  }
}

/** A truncated or declined response is useless: error with whatever arrived. */
async function assertFinished(finishReason: string | undefined, maxOutputTokens: number, out: { text: Promise<string> }): Promise<void> {
  if (finishReason === 'length') throw new LlmCallError('max_tokens', `la respuesta se cortó en maxOutputTokens=${String(maxOutputTokens)}`, { retryable: false, rawOutput: await textOf(out) })
  if (finishReason === 'content-filter') throw new LlmCallError('refusal', 'el modelo declinó la solicitud', { retryable: false, rawOutput: await textOf(out) })
}

/** Text that arrived; if the stream broke, nothing (with a wait cap). */
async function textOf(out: { text: Promise<string> }): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { resolve(null) }, 2000)
    timer.unref()
  })
  try {
    return await Promise.race([out.text.then((t) => t || null, () => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}
