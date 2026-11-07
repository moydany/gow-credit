/**
 * Jev (or Haiku) on top of the rules. Rules settle what has a clear keyword or identity
 * (fees, taxes, internal transfers, buyer payments, own transfers); only movements the rules
 * leave at low confidence (generic transfers, cash, unrecognizable) go to the model. So the model
 * never contradicts deterministic data and fewer rows are sent.
 *
 * Combining:
 * - **Jev** (calibrated probabilities): if it agrees with the rule, the higher of the two
 *   confidences; otherwise Jev's label and confidence.
 * - **Haiku** (self-reported confidence, poorly calibrated): its confidence is ignored. If it
 *   agrees with a keyword rule, max(rule, 0.8); otherwise its label at 0.6, below the threshold:
 *   it shows in the report and can prompt a question, but adds no income.
 */
import type { ApplicationRequest, StatementExtraction, Transaction, TransactionCategory, TransactionClassification, TransactionRef } from '@gow/contracts'
import { ruleContext } from '../ledger.ts'
import { classifyByRules, type RuleMatch } from './rules.ts'

/** A rule at or above this confidence is not sent to the model. */
export const RULE_CONFIDENCE_SKIPS_MODEL = 0.85
/** Identity or extraction rules: deterministic even if their confidence is lower. */
const DETERMINISTIC_RULES = new Set(['internal_transfer', 'buyer_rfc', 'buyer_name', 'own_rfc', 'own_name'])
/** Haiku confidence when it agrees with a keyword rule. */
export const UNCALIBRATED_AGREEMENT_CONFIDENCE = 0.8
/** Haiku confidence with no rule backing: below the 0.7 threshold. */
export const UNCALIBRATED_ALONE_CONFIDENCE = 0.6
/** A rule below this confidence is the generic fallback (`unrecognized`), not a signal. */
const RULE_SIGNAL_MIN = 0.6

export interface ModelLabel {
  transaction_id: string
  category: TransactionCategory
  confidence: number
}

export interface ModelInfo {
  model: string
  /** true for Jev; false for Haiku. */
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

/** Movements the rules do not settle with confidence. Already-classified ones (owner, analyst, model) are not repeated. */
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

/** Copy of the statement with model labels combined with the rules. Does not mutate the original. */
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
