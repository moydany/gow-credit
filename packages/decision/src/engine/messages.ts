/**
 * Textos de `reasons` para el analista del tenant, en español. Las cifras salen del motor tal
 * cual; la redacción para el proveedor (`next_steps.message`) la hace Claude en la fase 5 con
 * el filtro de cifras de docs/04 §4.
 */
import type { AskTopic, DecisionStatus, FeatureName } from '@gow/contracts'
import type { ExclusionReason } from './conditions.ts'

export function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'sin dato'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('es-MX') : v.toLocaleString('es-MX', { maximumFractionDigits: 4 })
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (Array.isArray(v)) return v.length === 0 ? 'ninguno' : v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export const STATUS_TEXT: Record<DecisionStatus, string> = {
  qualified: 'califica',
  qualified_with_limit: 'califica con límite',
  not_qualified: 'no califica',
  needs_clarification: 'necesita aclaración del proveedor',
  human_review: 'revisión humana',
}

export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  unknown: 'sin dato',
  unverified: 'el dato no está verificado contra el documento',
  conflict: 'el dato está en conflicto (dos lecturas distintas)',
  low_confidence: 'la clasificación de los movimientos no alcanza la confianza mínima',
}

export const ASK_TEXT: Record<AskTopic, string> = {
  recent_statement: 'un estado de cuenta reciente',
  identity_fields: 'confirmar titular y RFC',
  deposit_classification: 'aclarar el origen de abonos',
  reconciliation_gap: 'aclarar un descuadre',
  additional_months: 'más meses de estados de cuenta',
  missing_pages: 'páginas faltantes',
  charge_classification: 'aclarar qué fueron algunos cargos',
  main_buyer: 'saber quién es su cliente principal',
  account_use: 'saber si la cuenta también es personal',
}

/** Código estable a partir de un id de la política (que admite `-` y `.`). */
export function codeOf(...parts: string[]): string {
  return parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
}

export function featureList(features: readonly FeatureName[]): string {
  return features.join(', ')
}
