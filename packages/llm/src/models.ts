/**
 * Pinned models and prices (USD per million tokens, cache as of 2026-10-06). Changing a model here
 * must pass the evals.
 */
import type { TokenUsage } from '@gow/contracts'

export const OPUS_MODEL = 'claude-opus-5-5'
export const LIGHT_MODEL = 'claude-haiku-5-5'
export const GEMINI_FLASH = 'gemini-3.8-flash'
/** Default extraction model; without a Google key the router uses Opus. */
export const EXTRACTION_MODEL = GEMINI_FLASH
/** Emergency for an extraction provider failure: another provider. */
export const PROVIDER_FALLBACK_MODEL = OPUS_MODEL
/**
 * Emergency for quality. The plan calls for `gemini-4-carbon`, but that id is not on Google's
 * official pricing page nor in @ai-sdk/google 4.0.109 (`gemini-4-argon` is), and the owner chose
 * not to try it yet. Until verified, the quality emergency is Opus.
 */
export const QUALITY_FALLBACK_MODEL = OPUS_MODEL
export const JEV_MODEL = 'jev-1.13.0'
/** Experiments only (`pnpm extract --model`); not a pinned system model. */
export const EXPERIMENT_SONNET = 'claude-sonnet-5-5'
/** Historical alias of the experiment. */
export const EXPERIMENT_GEMINI_FLASH = GEMINI_FLASH

export type Provider = 'anthropic' | 'google'

export function providerOf(model: string): Provider {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gemini-')) return 'google'
  throw new Error(`modelo sin proveedor conocido: ${model}`)
}

export type ClaudeModel = typeof OPUS_MODEL | typeof LIGHT_MODEL

interface Price {
  input: number
  output: number
  cacheWrite5m: number
  cacheRead: number
}

const OPUS: Price = { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 }
const SONNET: Price = { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 }
/**
 * Verified on 2026-11-04 on the official page (aistudio.google.com/docs/pricing, formerly
 * ai.google.dev): USD 0.75 input, 3.75 output (includes thinking), 0.075 cache read, valid
 * through 2026-12-31; from 2027-01-01 it becomes 1.50 / 7.50 / 0.15. No cache write: implicit
 * caching only bills reads.
 */
const GEMINI_FLASH_PRICE: Price = { input: 0.75, output: 3.75, cacheWrite5m: 0, cacheRead: 0.075 }
/**
 * Jev (TypeSafe AI). Verified on 2026-11-04 on typesafe.ai: "$42 per billion input tokens"
 * (USD 0.042 per million). The page publishes no output price; aggregators (Maxim, Netlify AI
 * Gateway) list it as 0. No cache.
 */
const JEV_PRICE: Price = { input: 0.042, output: 0, cacheWrite5m: 0, cacheRead: 0 }
const HAIKU_UP_TO_100K: Price = { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 }
const HAIKU_ABOVE_100K: Price = { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 }

function priceFor(model: string, promptTokens: number): Price {
  if (model === OPUS_MODEL) return OPUS
  if (model === EXPERIMENT_SONNET) return SONNET
  if (model === GEMINI_FLASH) return GEMINI_FLASH_PRICE
  if (model.startsWith('jev-')) return JEV_PRICE
  if (model === LIGHT_MODEL) return promptTokens > 100_000 ? HAIKU_ABOVE_100K : HAIKU_UP_TO_100K
  // A server fallback model (refusal) is billed at its own rate; with no table entry, Opus is the upper bound.
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
