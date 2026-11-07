/**
 * Maximum line with no requested amount: the largest amount the policy would approve if asked.
 * The capacity dimension compares income to the amount, so more amount means less score and an
 * equal or worse band. Found by bisection in cents over the same policy.
 *
 * Gates that ask for clarification do not void it: they are reported as conditions
 * (`conditional_on`). A gate that rejects or sends to review, or a result that depends on
 * doubtful data, does: then there is no maximum line to offer.
 */
import { HISTORY_GATE_ID, type FinalDecisionStatus, type MaxLine, type Policy, type Profile, type StatementAgeSetting } from '@gow/contracts'
import { withFeatures } from './engine/counterfactuals.ts'
import { evaluate } from './engine/evaluate.ts'
import { floor2 } from './util/num.ts'

const QUALIFYING: ReadonlySet<string> = new Set<FinalDecisionStatus>(['qualified', 'qualified_with_limit'])
const MIN_AMOUNT = 0.01

interface Probe {
  ok: boolean
  status: string
  limit: number | null
  score: number | null
}

export function maxLine(policy: Policy, profile: Profile, opts: { statementAge?: StatementAgeSetting } = {}): MaxLine | null {
  const age = opts.statementAge ? { statementAge: opts.statementAge } : {}
  const base = evaluate(policy, profile, { counterfactuals: false, ...age })
  if (base.evaluation.gates.some((g) => g.effect === 'not_qualified' || g.effect === 'human_review')) return null
  const pending = base.evaluation.gates.filter((g) => g.effect === 'needs_clarification').map((g) => g.id)
  // The history gate is the engine's: it is relaxed by evaluating as if the policy asked for one month.
  const relaxed: Policy = { ...policy, gates: policy.gates.filter((g) => !pending.includes(g.id)), ...(pending.includes(HISTORY_GATE_ID) ? { history: { months: 1 as const } } : {}) }

  const probe = (amount: number): Probe => {
    const d = evaluate(relaxed, withFeatures(profile, [{ feature: 'requested_amount', value: amount }]), { counterfactuals: false, ...age })
    const ok = QUALIFYING.has(d.status) && d.limit !== null && d.limit >= amount
    return { ok, status: d.status, limit: d.limit, score: d.score }
  }

  const first = probe(MIN_AMOUNT)
  if (!first.ok || first.limit === null) return null
  // More amount, equal or smaller line: the minimum request's line bounds the search.
  let lo = Math.round(MIN_AMOUNT * 100)
  let hi = Math.round(first.limit * 100)
  if (probe(hi / 100).ok) lo = hi
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (probe(mid / 100).ok) lo = mid
    else hi = mid
  }
  const amount = floor2(lo / 100)
  const at = probe(amount)
  if (!at.ok) return null
  return { amount, status: at.status as MaxLine['status'], score: at.score, conditional_on: pending }
}
