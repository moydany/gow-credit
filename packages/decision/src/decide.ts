/**
 * `decide`: perfil + motor + la regla de docs/03 §7 a nivel de movimiento. Un abono grande sin
 * clasificar con confianza (o clasificado como préstamo con confianza media) se le pregunta al
 * proveedor solo si la respuesta puede cambiar la banda: se recalcula el perfil suponiendo que
 * esos abonos son pagos de clientes y se compara. Sigue siendo puro: sin LLM ni base.
 */
import { Decision, FINAL_STATUS_RANK, type FinalDecisionStatus, type Policy, type StatementExtraction, type TransactionRef } from '@gow/contracts'
import { evaluate, type EvaluateOptions } from './engine/evaluate.ts'
import { fmt, STATUS_TEXT } from './engine/messages.ts'
import { evidenceRef, type Ledger, type LedgerRow } from './ledger.ts'
import { buildProfileWithLedger, type ProfileInput } from './profile.ts'
import { sumMoney } from './util/num.ts'

/** Un abono clasificado como préstamo con menos de esta confianza también se pregunta (docs/03 §7). */
export const LOAN_CONFIDENCE_TO_TRUST = 0.9
/** Movimientos que se listan en una pregunta. */
export const MAX_ASKED_TRANSACTIONS = 10
export const COUNTERFACTUAL_CLASSIFIER = 'counterfactual'

export interface DecideInput extends ProfileInput {
  policy: Policy
  policyId?: string | null
  clarificationRoundsUsed?: number
}

export interface DecideResult {
  decision: Decision
  ledger: Ledger
  /** Abonos inciertos que se preguntaron (vacío si no cambian la banda). */
  asked: LedgerRow[]
}

function isUncertainCredit(r: LedgerRow, minConfidence: number): boolean {
  if (r.type !== 'credit' || r.internal || !r.verified) return false
  const c = r.classification
  return c.confidence < minConfidence || (c.category === 'loan_disbursement' && c.confidence < LOAN_CONFIDENCE_TO_TRUST)
}

/** Abonos inciertos mayores al % de los ingresos de su periodo que fija la política. */
export function uncertainDeposits(ledger: Ledger, policy: Policy, minConfidence: number): LedgerRow[] {
  const pct = policy.clarification.askWhenAmountAbovePctOfIncome / 100
  const out: LedgerRow[] = []
  for (const p of ledger.periods) {
    const rows = ledger.rows.filter((r) => r.period === p && r.type === 'credit' && !r.internal && r.verified)
    const uncertain = rows.filter((r) => isUncertainCredit(r, minConfidence))
    const income = rows.filter((r) => r.classification.category === 'customer_payment' && r.classification.confidence >= minConfidence)
    const base = sumMoney([...income, ...uncertain].map((r) => r.amount))
    out.push(...uncertain.filter((r) => r.amount > pct * base))
  }
  return out.sort((a, b) => b.amount - a.amount || a.day - b.day)
}

function reclassified(statements: readonly StatementExtraction[], rows: readonly LedgerRow[]): StatementExtraction[] {
  const keys = new Set(rows.map((r) => `${r.ref.document_sha256}#${r.ref.transaction_id}`))
  return statements.map((s) => ({
    ...s,
    accounts: s.accounts.map((a) => ({
      ...a,
      periods: a.periods.map((p) => ({
        ...p,
        transactions: p.transactions.map((t) =>
          keys.has(`${s.document.sha256}#${t.id}`)
            ? { ...t, classification: { category: 'customer_payment' as const, confidence: 1, counterparty: t.classification?.counterparty ?? null, counterparty_rfc: t.classification?.counterparty_rfc ?? null, classifier: COUNTERFACTUAL_CLASSIFIER } }
            : t,
        ),
      })),
    })),
  }))
}

/**
 * Estado y banda de la línea que da el puntaje con sus topes, sin compuertas: lo que un abono
 * puede mover. Si un tope bajó el estado, la banda es la primera con ese estado (la que fija la línea).
 */
function scoreOutcome(policy: Policy, d: Decision): { status: FinalDecisionStatus; band: number } {
  const band = d.band
  if (band === null) return { status: 'not_qualified', band: Number.MAX_SAFE_INTEGER }
  let status: FinalDecisionStatus = band.status
  for (const c of d.evaluation.caps) if (c.applied && FINAL_STATUS_RANK[c.max_status] < FINAL_STATUS_RANK[status]) status = c.max_status
  const same = policy.decision.bands.findIndex((b) => b.status === status)
  return { status, band: status === band.status || same < 0 ? band.index : same }
}

function better(a: { status: FinalDecisionStatus; band: number }, b: { status: FinalDecisionStatus; band: number }): boolean {
  return FINAL_STATUS_RANK[a.status] > FINAL_STATUS_RANK[b.status] || (a.status === b.status && a.band < b.band)
}

export function decide(input: DecideInput): DecideResult {
  const { profile, ledger } = buildProfileWithLedger(input)
  const rounds = input.clarificationRoundsUsed ?? 0
  const opts: EvaluateOptions = { policyId: input.policyId ?? null, clarificationRoundsUsed: rounds }
  const base = evaluate(input.policy, profile, opts)

  // Si una compuerta ya rechaza o manda a revisión, ningún abono lo cambia.
  const decisiveGate = base.evaluation.gates.some((g) => g.effect === 'not_qualified' || g.effect === 'human_review')
  if (decisiveGate || base.status === 'qualified' || base.status === 'human_review') return { decision: base, ledger, asked: [] }

  const candidates = uncertainDeposits(ledger, input.policy, profile.parameters.min_classification_confidence)
  if (candidates.length === 0) return { decision: base, ledger, asked: [] }
  const best = buildProfileWithLedger({ ...input, statements: reclassified(input.statements, candidates) }).profile
  const bestDecision = evaluate(input.policy, best, { ...opts, counterfactuals: false })
  const from = scoreOutcome(input.policy, base)
  const to = scoreOutcome(input.policy, bestDecision)
  if (!better(to, from)) return { decision: base, ledger, asked: [] }

  const asked = candidates.slice(0, MAX_ASKED_TRANSACTIONS)
  const refs: TransactionRef[] = asked.map((r) => r.ref)
  const total = sumMoney(candidates.map((r) => r.amount))
  const reason = {
    code: 'deposit_clarification',
    message: `${String(candidates.length)} abono(s) por ${fmt(total)} sin clasificar con confianza (el mayor de ${fmt(candidates[0]?.amount)}): si son pagos de clientes el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
    features: ['operating_income_monthly' as const],
  }
  const step = {
    code: 'classify_deposits',
    feature: 'operating_income_monthly' as const,
    current_value: profile.features.operating_income_monthly.value,
    target_value: best.features.operating_income_monthly.value,
    related: (['new_debt_in_period', 'buyer_payments_count'] as const)
      .filter((f) => best.features[f].value !== profile.features[f].value)
      .map((f) => ({ feature: f, current_value: profile.features[f].value, target_value: best.features[f].value })),
    from: { status: base.status, score: base.score },
    to: { status: bestDecision.status, score: bestDecision.score },
    message: null,
  }

  if (rounds >= input.policy.clarification.maxRounds) {
    const decision = Decision.parse({
      ...base,
      status: 'human_review',
      limit: null,
      clarification: null,
      reasons: [...base.reasons, reason, { code: 'clarification_rounds_exhausted', message: 'Sin rondas de aclaración disponibles: pasa a revisión humana.', features: [] }],
      next_steps: [step, ...base.next_steps],
    })
    return { decision, ledger, asked }
  }
  const topics = [...new Set([...(base.clarification?.topics ?? []), 'deposit_classification' as const])]
  const decision = Decision.parse({
    ...base,
    status: 'needs_clarification',
    limit: null,
    clarification: { topics, issue_ids: base.clarification?.issue_ids ?? [], transactions: refs },
    reasons: [...base.reasons, { ...reason, message: `${reason.message} Se pregunta: ${asked.map(evidenceRef).join(', ')}.` }],
    next_steps: [step, ...base.next_steps],
  })
  return { decision, ledger, asked }
}
