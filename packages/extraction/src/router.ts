/**
 * Extraction model router. Decides which model reads each part of the document; no flag decides
 * it. Each call records the model that produced it (`ModelCall.model`).
 *
 * - Main: `gemini-3.8-flash` if there is a Google key; otherwise `claude-opus-5-5`, so
 *   `pnpm run evaluate` keeps working with only ANTHROPIC_API_KEY.
 * - Provider failure (quota, error or Google outage after retries): the whole document is
 *   repeated with Opus. A bigger model from the same provider does not help if the provider is
 *   the problem.
 * - Quality failure (output that fails validation twice in a row, a mismatch the re-read does
 *   not resolve): the block is repeated with the quality emergency model.
 * - Double read: with Claude, a different family from the main model; Opus if the re-read effort
 *   is high, Haiku otherwise.
 */
import { LIGHT_MODEL, LlmCallError, OPUS_MODEL, PROVIDER_FALLBACK_MODEL, providerOf, QUALITY_FALLBACK_MODEL, EXTRACTION_MODEL, type Effort } from '@gow/llm'

export interface ModelPlan {
  primary: string
  qualityFallback: string
  providerFallback: string
  doubleRead: string
  /** Why the main model is not the default one, if applicable. */
  note: string | null
}

export function planModels(input: { requested?: string | undefined; googleAvailable: boolean; retryEffort: Effort }): ModelPlan {
  const highEffort = input.retryEffort === 'high' || input.retryEffort === 'xhigh' || input.retryEffort === 'max'
  const doubleRead = highEffort ? OPUS_MODEL : LIGHT_MODEL
  if (input.requested) {
    return { primary: input.requested, qualityFallback: QUALITY_FALLBACK_MODEL, providerFallback: PROVIDER_FALLBACK_MODEL, doubleRead, note: null }
  }
  if (!input.googleAvailable) {
    return { primary: PROVIDER_FALLBACK_MODEL, qualityFallback: QUALITY_FALLBACK_MODEL, providerFallback: PROVIDER_FALLBACK_MODEL, doubleRead, note: `sin llave de Google; extracción con ${PROVIDER_FALLBACK_MODEL}` }
  }
  return { primary: EXTRACTION_MODEL, qualityFallback: QUALITY_FALLBACK_MODEL, providerFallback: PROVIDER_FALLBACK_MODEL, doubleRead, note: null }
}

/**
 * Is the error the provider's, not the content's? Only counts for a model from a different
 * provider than the emergency one.
 */
export function isProviderFailure(err: unknown, model: string, plan: ModelPlan): boolean {
  if (!(err instanceof LlmCallError)) return false
  if (providerOf(model) === providerOf(plan.providerFallback)) return false
  return err.code === 'api_error' || err.code === 'timeout' || err.code === 'missing_api_key'
}

/** Server-side fallback on refusal: only Opus and Sonnet have it. */
export function supportsServerFallback(model: string): boolean {
  return model === OPUS_MODEL || model === 'claude-sonnet-5-5'
}
