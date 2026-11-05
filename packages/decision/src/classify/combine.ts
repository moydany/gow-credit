/**
 * Jev (o Haiku) encima de las reglas (docs/02 §4c, ADR 0015). Las reglas resuelven lo que tiene
 * palabra clave clara o identidad (comisiones, impuestos, traspasos internos, pagos del
 * comprador, traspasos propios); al modelo solo van los movimientos que las reglas dejan con
 * confianza baja (transferencias genéricas, efectivo, lo irreconocible). Así el modelo nunca
 * contradice un dato determinístico y se le mandan menos filas.
 *
 * Cómo se combinan:
 * - **Jev** (probabilidades calibradas): si coincide con la regla, la mayor confianza de las dos;
 *   si no, la etiqueta y la confianza de Jev.
 * - **Haiku** (confianza autoreportada, mal calibrada: spike 3): su confianza no se usa. Si
 *   coincide con una regla con palabra clave, max(regla, 0.8); si no, su etiqueta con 0.6,
 *   bajo el umbral: se ve en el reporte y puede motivar una pregunta, pero no suma ingresos.
 */
import type { ApplicationRequest, StatementExtraction, Transaction, TransactionCategory, TransactionClassification, TransactionRef } from '@gow/contracts'
import { ruleContext } from '../ledger.ts'
import { classifyByRules, type RuleMatch } from './rules.ts'

/** Una regla con esta confianza o más no se manda al modelo. */
export const RULE_CONFIDENCE_SKIPS_MODEL = 0.85
/** Reglas de identidad o de la extracción: deterministas aunque su confianza sea menor. */
const DETERMINISTIC_RULES = new Set(['internal_transfer', 'buyer_rfc', 'buyer_name', 'own_rfc', 'own_name'])
/** Confianza de Haiku cuando coincide con una regla con palabra clave. */
export const UNCALIBRATED_AGREEMENT_CONFIDENCE = 0.8
/** Confianza de Haiku sin respaldo de una regla: bajo el umbral de 0.7. */
export const UNCALIBRATED_ALONE_CONFIDENCE = 0.6
/** Una regla con menos confianza es el respaldo genérico (`unrecognized`), no una señal. */
const RULE_SIGNAL_MIN = 0.6

export interface ModelLabel {
  transaction_id: string
  category: TransactionCategory
  confidence: number
}

export interface ModelInfo {
  model: string
  /** true para Jev; false para Haiku. */
  calibrated: boolean
}

export interface ModelCandidate {
  ref: TransactionRef
  tx: Transaction
  rule: RuleMatch
}

export function needsModel(rule: RuleMatch): boolean {
  return !DETERMINISTIC_RULES.has(rule.rule) && rule.classification.confidence < RULE_CONFIDENCE_SKIPS_MODEL
}

/** Movimientos que las reglas no resuelven con confianza. Los ya clasificados (dueño, analista, modelo) no se repiten. */
export function transactionsForModel(statement: StatementExtraction, request: ApplicationRequest | null): ModelCandidate[] {
  const ctx = ruleContext(statement, request)
  const out: ModelCandidate[] = []
  for (const a of statement.accounts) {
    for (const p of a.periods) {
      for (const t of p.transactions) {
        if (t.classification !== null) continue
        const rule = classifyByRules(t, ctx)
        if (needsModel(rule)) out.push({ ref: { document_sha256: statement.document.sha256, transaction_id: t.id }, tx: t, rule })
      }
    }
  }
  return out
}

export function combineClassification(rule: RuleMatch, label: ModelLabel, info: ModelInfo): TransactionClassification {
  const r = rule.classification
  const agree = r.category === label.category
  let confidence: number
  if (info.calibrated) confidence = agree ? Math.max(r.confidence, label.confidence) : label.confidence
  else confidence = agree && r.confidence >= RULE_SIGNAL_MIN ? Math.max(r.confidence, UNCALIBRATED_AGREEMENT_CONFIDENCE) : UNCALIBRATED_ALONE_CONFIDENCE
  return { category: label.category, confidence: Math.round(confidence * 1e4) / 1e4, counterparty: null, counterparty_rfc: r.counterparty_rfc, classifier: info.model }
}

/** Copia del estado de cuenta con las etiquetas del modelo combinadas con las reglas. No muta el original. */
export function withModelLabels(statement: StatementExtraction, request: ApplicationRequest | null, labels: readonly ModelLabel[], info: ModelInfo): StatementExtraction {
  const byId = new Map(labels.map((l) => [l.transaction_id, l]))
  const ctx = ruleContext(statement, request)
  return {
    ...statement,
    accounts: statement.accounts.map((a) => ({
      ...a,
      periods: a.periods.map((p) => ({
        ...p,
        transactions: p.transactions.map((t) => {
          const label = byId.get(t.id)
          if (label === undefined || t.classification !== null) return t
          const rule = classifyByRules(t, ctx)
          if (!needsModel(rule)) return t
          return { ...t, classification: combineClassification(rule, label, info) }
        }),
      })),
    })),
  }
}
