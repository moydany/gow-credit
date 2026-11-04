/**
 * Condiciones del DSL de política (docs/03 §4) y lectura de features del perfil. Matching
 * exhaustivo sobre `op`: un operador nuevo en el contrato no compila hasta tener su caso aquí.
 */
import { FEATURE_CATALOG, featureEnumValues, type Condition, type ConditionOp, type FeatureName, type Profile } from '@gow/contracts'
import type { z } from 'zod'
import type { ExclusionReason as ExclusionReasonSchema } from '@gow/contracts'

export type ExclusionReason = z.infer<typeof ExclusionReasonSchema>

export interface FeatureRead {
  value: unknown
  /** Por qué no se puede usar para decidir; null si se puede. */
  exclusion: ExclusionReason | null
  confidence: number
}

/**
 * Lee una feature para decidir (docs/04 §5): desconocida si es null; excluida si no está
 * verificada o está en conflicto; con `minConfidence`, excluida si la confianza no alcanza.
 */
export function readFeature(profile: Profile, name: FeatureName, minConfidence: number | null = null): FeatureRead {
  const f = profile.features[name] as { value: unknown; verification: string; confidence: number }
  if (f.value === null) return { value: null, exclusion: 'unknown', confidence: f.confidence }
  if (f.verification === 'conflict') return { value: f.value, exclusion: 'conflict', confidence: f.confidence }
  if (f.verification === 'unverified') return { value: f.value, exclusion: 'unverified', confidence: f.confidence }
  if (minConfidence !== null && f.confidence < minConfidence) return { value: f.value, exclusion: 'low_confidence', confidence: f.confidence }
  return { value: f.value, exclusion: null, confidence: f.confidence }
}

function asNumber(v: unknown): number {
  if (typeof v !== 'number') throw new Error(`se esperaba un número y llegó ${JSON.stringify(v)}`)
  return v
}

/** ¿Se cumple la condición con este valor (no nulo)? */
export function checkCondition(cond: Condition, value: unknown): boolean {
  const op: ConditionOp = cond.op
  switch (op) {
    case '<':
      return asNumber(value) < asNumber(cond.value)
    case '<=':
      return asNumber(value) <= asNumber(cond.value)
    case '>':
      return asNumber(value) > asNumber(cond.value)
    case '>=':
      return asNumber(value) >= asNumber(cond.value)
    case '==':
      return value === cond.value
    case '!=':
      return value !== cond.value
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(String(value))
    case 'not_in':
      return Array.isArray(cond.value) && !cond.value.includes(String(value))
    case 'empty':
      return Array.isArray(value) && value.length === 0
    case 'not_empty':
      return Array.isArray(value) && value.length > 0
  }
}

/** Paso mínimo de una feature numérica: 1 para enteros, un centavo para montos, 0.0001 para razones. */
export function stepOf(name: FeatureName): number {
  const kind = FEATURE_CATALOG[name].kind
  return kind === 'int' ? 1 : kind === 'money' ? 0.01 : 0.0001
}

/**
 * El valor más cercano que cumple la condición, para los contrafactuales. `undefined` cuando
 * no hay un valor único que proponer (`!=`, `not_empty`).
 */
export function satisfyingValue(cond: Condition): unknown {
  const step = stepOf(cond.feature)
  const op: ConditionOp = cond.op
  switch (op) {
    case '<':
      return Math.round((asNumber(cond.value) - step) * 10_000) / 10_000
    case '<=':
    case '>=':
    case '==':
      return cond.value
    case '>':
      return Math.round((asNumber(cond.value) + step) * 10_000) / 10_000
    case '!=':
      return typeof cond.value === 'boolean' ? !cond.value : typeof cond.value === 'number' ? Math.round((cond.value + step) * 10_000) / 10_000 : undefined
    case 'in':
      return Array.isArray(cond.value) ? cond.value[0] : undefined
    case 'not_in': {
      const allowed = (featureEnumValues(cond.feature) ?? []).filter((v) => Array.isArray(cond.value) && !cond.value.includes(v))
      return allowed[0]
    }
    case 'empty':
      return []
    case 'not_empty':
      return undefined
  }
}

/** La condición contraria: un tope deja de aplicar cuando su condición deja de cumplirse. */
export function negate(cond: Condition): Condition {
  const inverse: Record<ConditionOp, ConditionOp> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==', in: 'not_in', not_in: 'in', empty: 'not_empty', not_empty: 'empty' }
  return { ...cond, op: inverse[cond.op] }
}
