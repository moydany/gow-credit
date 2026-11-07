/**
 * A model exchange as-is: what was sent (system prompt, instruction, parameters, PDF fingerprint)
 * and what came back (object, raw output if it did not validate, error, usage, cost). Lets a
 * failed case be analyzed without calling the model again.
 *
 * Carries document data: lives in `app.llm_exchanges` with RLS (never in the movement log or
 * logs) and, in standalone, in `data/out/evaluate/<id>.llm.jsonl`.
 */
import { z } from 'zod'
import { TokenUsage } from './primitives.ts'

export const LlmExchangeOutcome = z.enum(['ok', 'error'])
export type LlmExchangeOutcome = z.infer<typeof LlmExchangeOutcome>

/** List row: no content, so many can be listed without loading prompts. */
export const LlmExchangeRow = z.strictObject({
  id: z.uuid(),
  application_id: z.uuid().nullable(),
  inbound_message_id: z.uuid().nullable(),
  purpose: z.string().describe('classify, summary, transactions, retry_page, double_read, interpret, explain...'),
  model: z.string(),
  schema_name: z.string(),
  prompt_version: z.string(),
  effort: z.string(),
  outcome: LlmExchangeOutcome,
  error_code: z.string().nullable(),
  finish_reason: z.string().nullable(),
  response_cache_hit: z.boolean().describe('La respuesta salió de la caché local: no hubo llamada'),
  usage: TokenUsage.nullable(),
  cost_usd: z.number(),
  latency_ms: z.number().int(),
  at: z.string(),
})
export type LlmExchangeRow = z.infer<typeof LlmExchangeRow>

/** Raw detail: viewing it is recorded in the movement log (`llm_exchange.viewed`). */
export const LlmExchangeDetail = LlmExchangeRow.extend({
  system: z.string(),
  instruction: z.string(),
  document_sha256: z.string().nullable().describe('Huella del PDF enviado; el PDF ya está en el almacenamiento'),
  max_output_tokens: z.number().int(),
  server_fallback: z.boolean(),
  response: z.unknown().describe('Objeto que devolvió el modelo y validó contra el esquema'),
  raw_output: z.string().nullable().describe('Salida tal cual cuando no validó o se cortó'),
  error_message: z.string().nullable(),
})
export type LlmExchangeDetail = z.infer<typeof LlmExchangeDetail>

export const LlmExchangeListQuery = z.strictObject({
  application_id: z.uuid().optional(),
  outcome: LlmExchangeOutcome.optional(),
})
export type LlmExchangeListQuery = z.infer<typeof LlmExchangeListQuery>
