/**
 * `evaluate(policy, profile)`: the decision engine. Pure and deterministic, no LLM or database:
 * same policy and profile give the same verdict, with the diagnosis (gates, dimensions, caps,
 * line), reasons and counterfactuals. The verdict date is the profile's unless another is passed.
 */
import { Decision, DOCUMENT_AGE_WARNING, HISTORY_GATE_ID, monthsText, statementMaxAgeDays, type Policy, type Profile, type Reason, type StatementAgeSetting, type TransactionRef } from '@gow/contracts'
import type { z } from 'zod'
import { counterfactuals } from './counterfactuals.ts'
import { evaluateCore } from './core.ts'

export const ENGINE_VERSION = '0.1.0'

export interface EvaluateOptions {
  /** Policy version id, to re-explain the decision. */
  policyId?: string | null
  /** `decided_at`; defaults to `profile.computed_at` so the result is reproducible. */
  now?: string
  /** Clarification rounds already used on the request. */
  clarificationRoundsUsed?: number
  /** false to skip counterfactuals (bulk simulation). */
  counterfactuals?: boolean
  /** Movements being asked about (added by `decide`). */
  clarificationTransactions?: TransactionRef[]
  /**
   * Maximum statement age, a tenant setting. With it, the policy's `document_age_days` gates do
   * not apply: an older document is still analyzed and the verdict carries the
   * `document_age_warning`. Without it (standalone), the policy decides alone.
   */
  statementAge?: StatementAgeSetting
}

/** The policy without the age gates: with the tenant setting, age only warns. */
export function withoutDocumentAgeGates(policy: Policy): Policy {
  return policy.gates.some((g) => g.when.feature === 'document_age_days') ? { ...policy, gates: policy.gates.filter((g) => g.when.feature !== 'document_age_days') } : policy
}

/**
 * The policy with the history gate (ADR 0072): with `history.months` above 1, the months in a row
 * up to the latest cutoff must reach it; otherwise the supplier is asked for the missing ones. It is
 * the first gate so that request goes out before any other question about documents.
 */
export function withHistoryGate(policy: Policy): Policy {
  const months = policy.history.months
  if (months <= 1 || policy.gates.some((g) => g.id === HISTORY_GATE_ID)) return policy
  const gate = {
    id: HISTORY_GATE_ID,
    description: `La política evalúa ${String(months)} meses seguidos hasta el corte más reciente`,
    when: { feature: 'months_of_history' as const, op: '>=' as const, value: months },
    onFail: { status: 'needs_clarification' as const, ask: 'additional_months' as const },
    onUnknown: 'ask' as const,
  }
  return { ...policy, gates: [gate, ...policy.gates] }
}

/**
 * The age warning: the most recent cutoff is older than the setting, or its date is unknown.
 * Never with no limit (`max_months: null`).
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
  const effective = withHistoryGate(opts.statementAge ? withoutDocumentAgeGates(policy) : policy)
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
