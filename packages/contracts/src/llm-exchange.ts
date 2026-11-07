/**
 * Intercambio con un modelo tal cual (ADR 0064): lo que se mandó (system prompt, instrucción,
 * parámetros y la huella del PDF) y lo que volvió (objeto, salida cruda si no validó, error, uso,
 * costo). Sirve para analizar un caso que falló sin volver a llamar al modelo.
 *
 * Lleva datos del documento: vive en `app.llm_exchanges` con RLS (nunca en la bitácora de
 * movimientos ni en logs) y en modo standalone en `data/out/evaluate/<id>.llm.jsonl`.
 */
import { z } from 'zod'
import { TokenUsage } from './primitives.ts'

export const LlmExchangeOutcome = z.enum(['ok', 'error'])
export type LlmExchangeOutcome = z.infer<typeof LlmExchangeOutcome>

/** Fila de la lista: sin contenido, para recorrer muchas sin cargar los prompts. */
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

/** Detalle crudo: verlo queda en la bitácora de movimientos (`llm_exchange.viewed`). */
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
