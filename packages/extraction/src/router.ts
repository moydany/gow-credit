/**
 * Router de modelos de extracción (ADR 0003, ADR 0011). Decide qué modelo lee cada parte del
 * documento; no lo decide un flag. Cada llamada registra el modelo que la produjo
 * (`ModelCall.model`).
 *
 * - Principal: `gemini-3.8-flash` si hay llave de Google; si no, `claude-opus-5-5`, para que
 *   `pnpm run evaluate` siga funcionando solo con ANTHROPIC_API_KEY.
 * - Falla del proveedor (cuota, error o caída de Google tras los reintentos): el documento
 *   entero se repite con Opus. Un modelo más grande del mismo proveedor no ayuda si el
 *   proveedor es el problema.
 * - Falla de calidad (salida que no valida dos veces seguidas, descuadre que la relectura no
 *   resuelve): el bloque se repite con el modelo de emergencia por calidad.
 * - Doble lectura (`04` §3.6): con Claude, otra familia que el principal; Opus si el effort de
 *   la relectura es alto, Haiku si no.
 */
import { LIGHT_MODEL, LlmCallError, OPUS_MODEL, PROVIDER_FALLBACK_MODEL, providerOf, QUALITY_FALLBACK_MODEL, EXTRACTION_MODEL, type Effort } from '@gow/llm'

export interface ModelPlan {
  primary: string
  qualityFallback: string
  providerFallback: string
  doubleRead: string
  /** Por qué el principal no es el de la ADR 0011, si aplica. */
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

/** ¿El error es del proveedor (no del contenido)? Solo cuenta para un modelo de otro proveedor que el de emergencia. */
export function isProviderFailure(err: unknown, model: string, plan: ModelPlan): boolean {
  if (!(err instanceof LlmCallError)) return false
  if (providerOf(model) === providerOf(plan.providerFallback)) return false
  return err.code === 'api_error' || err.code === 'timeout' || err.code === 'missing_api_key'
}

/** Fallback del lado del servidor ante refusal: solo Opus y Sonnet lo tienen. */
export function supportsServerFallback(model: string): boolean {
  return model === OPUS_MODEL || model === 'claude-sonnet-5-5'
}
