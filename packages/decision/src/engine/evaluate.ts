/**
 * `evaluate(policy, profile)`: el motor de decisión (docs/03 §4 a §6). Función pura y
 * determinística, sin LLM ni base: misma política y mismo perfil dan el mismo veredicto, con
 * el diagnóstico (compuertas, dimensiones, topes, línea), las razones y los contrafactuales.
 * La fecha del veredicto es la del perfil salvo que se pase otra.
 */
import { Decision, DOCUMENT_AGE_WARNING, monthsText, statementMaxAgeDays, type Policy, type Profile, type Reason, type StatementAgeSetting, type TransactionRef } from '@gow/contracts'
import type { z } from 'zod'
import { counterfactuals } from './counterfactuals.ts'
import { evaluateCore } from './core.ts'

export const ENGINE_VERSION = '0.1.0'

export interface EvaluateOptions {
  /** Id de la versión de política, para re-explicar la decisión. */
  policyId?: string | null
  /** `decided_at`; por defecto `profile.computed_at`, para que el resultado sea reproducible. */
  now?: string
  /** Rondas de aclaración ya usadas en la solicitud (docs/03 §7). */
  clarificationRoundsUsed?: number
  /** false para no calcular contrafactuales (simulación masiva). */
  counterfactuals?: boolean
  /** Movimientos sobre los que se pregunta (los agrega `decide`). */
  clarificationTransactions?: TransactionRef[]
  /**
   * Antigüedad máxima del estado de cuenta, ajuste del tenant (ADR 0049). Con ella, las compuertas
   * de la política sobre `document_age_days` no aplican: un documento más viejo se analiza igual y
   * el veredicto lleva la advertencia `document_age_warning`. Sin ella (standalone), la política
   * decide sola.
   */
  statementAge?: StatementAgeSetting
}

/** La política sin las compuertas de antigüedad: con el ajuste del tenant, la antigüedad solo advierte. */
export function withoutDocumentAgeGates(policy: Policy): Policy {
  return policy.gates.some((g) => g.when.feature === 'document_age_days') ? { ...policy, gates: policy.gates.filter((g) => g.when.feature !== 'document_age_days') } : policy
}

/**
 * La advertencia de antigüedad (ADR 0049): el corte más reciente es más viejo que el ajuste, o no se
 * sabe cuándo fue. Sin límite (`max_months: null`), nunca.
 */
export function documentAgeWarning(profile: Profile, setting: StatementAgeSetting): z.infer<typeof Reason> | null {
  const months = setting.max_months
  if (months === null) return null
  const maxDays = statementMaxAgeDays(months)
  const age = profile.features.document_age_days.value
  const limit = `la antigüedad máxima de ${monthsText(months)} (${String(maxDays)} días) que fija la configuración de la institución crediticia`
  if (typeof age !== 'number') {
    return { code: DOCUMENT_AGE_WARNING, message: `Advertencia: no se pudo calcular la antigüedad del estado de cuenta (sin fecha de corte) para compararla con ${limit}. Se analizó igual.`, features: ['document_age_days'] }
  }
  if (age <= maxDays) return null
  return { code: DOCUMENT_AGE_WARNING, message: `Advertencia: el estado de cuenta tiene ${String(age)} días desde su corte más reciente, más que ${limit}. Se analizó igual, sin pedir uno más reciente.`, features: ['document_age_days'] }
}

export function evaluate(policy: Policy, profile: Profile, opts: EvaluateOptions = {}): Decision {
  const coreOpts = { clarificationRoundsUsed: opts.clarificationRoundsUsed ?? 0 }
  const effective = opts.statementAge ? withoutDocumentAgeGates(policy) : policy
  const core = evaluateCore(effective, profile, coreOpts)
  const band = policy.decision.bands[core.bandIndex]
  const warning = opts.statementAge ? documentAgeWarning(profile, opts.statementAge) : null
  return Decision.parse({
    status: core.status,
    limit: core.limit,
    score: core.score,
    band: band ? { index: core.bandIndex, min: band.min, status: band.status } : null,
    policy: { id: opts.policyId ?? null, version: policy.version },
    profile,
    evaluation: { gates: core.gates, dimensions: core.dimensions, caps: core.caps, limit: core.limitEvaluation },
    reasons: warning ? [...core.reasons, warning] : core.reasons,
    next_steps: opts.counterfactuals === false ? [] : counterfactuals(effective, profile, core, coreOpts),
    clarification: core.status === 'needs_clarification' ? { topics: core.topics, issue_ids: [], transactions: opts.clarificationTransactions ?? [] } : null,
    engine_version: ENGINE_VERSION,
    decided_at: opts.now ?? profile.computed_at,
  })
}
