/**
 * Modelos fijados y precios (USD por millón de tokens, skill claude-api, caché 2026-10-06).
 * Cambiar un modelo aquí es un cambio que pasa por evals (CLAUDE.md).
 */
import type { TokenUsage } from '@gow/contracts'

export const EXTRACTION_MODEL = 'claude-opus-5-5'
export const LIGHT_MODEL = 'claude-haiku-5-5'
export const JEV_MODEL = 'jev-1.13.0'
/** Solo para experimentos (`pnpm extract --model`); no es un modelo fijado del sistema (ADR 0003). */
export const EXPERIMENT_SONNET = 'claude-sonnet-5-5'

export type ClaudeModel = typeof EXTRACTION_MODEL | typeof LIGHT_MODEL

interface Price {
  input: number
  output: number
  cacheWrite5m: number
  cacheRead: number
}

const OPUS: Price = { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 }
const SONNET: Price = { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 }
const HAIKU_UP_TO_100K: Price = { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 }
const HAIKU_ABOVE_100K: Price = { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 }

function priceFor(model: string, promptTokens: number): Price {
  if (model === EXTRACTION_MODEL) return OPUS
  if (model === EXPERIMENT_SONNET) return SONNET
  if (model === LIGHT_MODEL) return promptTokens > 100_000 ? HAIKU_ABOVE_100K : HAIKU_UP_TO_100K
  // Un modelo de fallback del servidor (refusal) se cobra a su tarifa; sin tabla, se usa Opus como cota.
  return OPUS
}

export function costUsd(model: string, u: TokenUsage): number {
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  const p = priceFor(model, prompt)
  const usd = (u.input_tokens * p.input + u.cache_creation_input_tokens * p.cacheWrite5m + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1_000_000
  return Math.round(usd * 1e6) / 1e6
}

export const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  }
}
