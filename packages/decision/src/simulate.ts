/**
 * Policy simulation over a set of profiles: offline replay of past requests with a draft
 * version, compared against the current one. Pure: stored profiles go in as they are, so the
 * diff only reflects the policy change.
 */
import { SimulationReport, type DecisionStatus, type Policy, type SimulationCase, type StatementAgeSetting } from '@gow/contracts'
import { DECISION_STATUS_RANK } from './engine/core.ts'
import { evaluate } from './engine/evaluate.ts'

export interface PolicyRef {
  id: string | null
  policy: Policy
}

const BAD = new Set(['late', 'default', 'fraud'])
const STATUSES: readonly DecisionStatus[] = ['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review']

/** `statementAge`: the tenant's age setting, to simulate how full mode decides. */
export function simulatePolicy(draft: PolicyRef, cases: readonly SimulationCase[], baseline: PolicyRef | null = null, opts: { statementAge?: StatementAgeSetting } = {}): SimulationReport {
  const age = opts.statementAge ? { statementAge: opts.statementAge } : {}
  const rows = cases.map((c) => {
    const d = evaluate(draft.policy, c.profile, { policyId: draft.id, counterfactuals: false, ...age })
    const b = baseline ? evaluate(baseline.policy, c.profile, { policyId: baseline.id, counterfactuals: false, ...age }) : null
    return {
      id: c.id,
      outcome: c.outcome,
      draft: { status: d.status, score: d.score, limit: d.limit },
      baseline: b ? { status: b.status, score: b.score, limit: b.limit } : null,
    }
  })
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.draft.status === s).length])) as Record<DecisionStatus, number>
  let transitions: SimulationReport['transitions'] = null
  if (baseline) {
    const t = { upgraded: 0, downgraded: 0, unchanged: 0, limit_increased: 0, limit_decreased: 0 }
    for (const r of rows) {
      const b = r.baseline
      if (!b) continue
      const delta = DECISION_STATUS_RANK[r.draft.status] - DECISION_STATUS_RANK[b.status]
      if (delta > 0) t.upgraded++
      else if (delta < 0) t.downgraded++
      else t.unchanged++
      if ((r.draft.limit ?? 0) > (b.limit ?? 0)) t.limit_increased++
      else if ((r.draft.limit ?? 0) < (b.limit ?? 0)) t.limit_decreased++
    }
    transitions = t
  }
  const outcomes = STATUSES.map((status) => {
    const withOutcome = rows.filter((r) => r.draft.status === status && r.outcome !== null)
    const bad = withOutcome.filter((r) => BAD.has(r.outcome ?? '')).length
    return { status, with_outcome: withOutcome.length, bad, bad_rate: withOutcome.length > 0 ? Math.round((bad / withOutcome.length) * 10_000) / 10_000 : null }
  }).filter((o) => o.with_outcome > 0)
  return SimulationReport.parse({
    policy: { id: draft.id, version: draft.policy.version },
    baseline: baseline ? { id: baseline.id, version: baseline.policy.version } : null,
    total: rows.length,
    by_status,
    cases: rows,
    transitions,
    outcomes,
  })
}
