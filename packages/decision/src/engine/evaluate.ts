/**
 * `evaluate(policy, profile)`: el motor de decisión (docs/03 §4 a §6). Función pura y
 * determinística, sin LLM ni base: misma política y mismo perfil dan el mismo veredicto, con
 * el diagnóstico (compuertas, dimensiones, topes, línea), las razones y los contrafactuales.
 * La fecha del veredicto es la del perfil salvo que se pase otra.
 */
import { Decision, type Policy, type Profile, type TransactionRef } from '@gow/contracts'
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
}

export function evaluate(policy: Policy, profile: Profile, opts: EvaluateOptions = {}): Decision {
  const coreOpts = { clarificationRoundsUsed: opts.clarificationRoundsUsed ?? 0 }
  const core = evaluateCore(policy, profile, coreOpts)
  const band = policy.decision.bands[core.bandIndex]
  return Decision.parse({
    status: core.status,
    limit: core.limit,
    score: core.score,
    band: band ? { index: core.bandIndex, min: band.min, status: band.status } : null,
    policy: { id: opts.policyId ?? null, version: policy.version },
    profile,
    evaluation: { gates: core.gates, dimensions: core.dimensions, caps: core.caps, limit: core.limitEvaluation },
    reasons: core.reasons,
    next_steps: opts.counterfactuals === false ? [] : counterfactuals(policy, profile, core, coreOpts),
    clarification: core.status === 'needs_clarification' ? { topics: core.topics, issue_ids: [], transactions: opts.clarificationTransactions ?? [] } : null,
    engine_version: ENGINE_VERSION,
    decided_at: opts.now ?? profile.computed_at,
  })
}
