/**
 * `decide`: profile + engine + the question rule at movement and request level. We only ask the
 * supplier what could change the band: rebuild the profile with the most favorable answer (the
 * least favorable for account use) and compare.
 *
 * - Large deposits not classified with confidence (or loans with medium confidence): customer payments?
 * - Large doubtful charges, mostly debt payments with low confidence: own-account transfers?
 * - Main buyer, when the request has none: do their payments show up?
 * - Account use, for individuals: is the account also personal?
 *
 * Foreign-currency accounts are never mixed with pesos: the request goes to human review.
 * Still pure: no LLM, no database.
 */
import {
  Decision,
  FINAL_STATUS_RANK,
  NO_DECLARATIONS,
  type AskTopic,
  type FinalDecisionStatus,
  type NextStep,
  type OwnerDeclarations,
  type Policy,
  type Profile,
  type StatementAgeSetting,
  type StatementExtraction,
  type TransactionCategory,
  type TransactionRef,
} from '@gow/contracts'
import { evaluate, type EvaluateOptions } from './engine/evaluate.ts'
import { fmt, STATUS_TEXT } from './engine/messages.ts'
import { evidenceRef, type Ledger, type LedgerRow } from './ledger.ts'
import { buildProfileWithLedger, type ProfileInput } from './profile.ts'
import { sumMoney } from './util/num.ts'

/** A deposit classified as a loan below this confidence is also asked about. */
export const LOAN_CONFIDENCE_TO_TRUST = 0.9
/**
 * A charge taken as a debt payment below this confidence is asked about. It equals
 * `CONTRADICTION_CONFIDENCE`: above it, a different answer contradicts the document and is
 * ignored, so asking would be pointless.
 */
export const CHARGE_DEBT_CONFIDENCE_TO_TRUST = 0.8
/** Transactions listed in one question. */
export const MAX_ASKED_TRANSACTIONS = 10
export const COUNTERFACTUAL_CLASSIFIER = 'counterfactual'

export interface DecideInput extends ProfileInput {
  policy: Policy
  policyId?: string | null
  clarificationRoundsUsed?: number
  /** Tenant setting: an old document warns instead of asking for a new one. */
  statementAge?: StatementAgeSetting
  /**
   * false when `request` is not the supplier's but the one the workflow builds at the maximum line
   * (no request came): the main buyer is not asked, as with no request at all.
   */
  askMainBuyer?: boolean
}

export interface DecideResult {
  decision: Decision
  ledger: Ledger
  /** Uncertain deposits and charges we asked about (empty if they don't move the band). */
  asked: LedgerRow[]
}

function isUncertainCredit(r: LedgerRow, minConfidence: number): boolean {
  if (r.type !== 'credit' || r.internal || !r.verified) return false
  const c = r.classification
  return c.confidence < minConfidence || (c.category === 'loan_disbursement' && c.confidence < LOAN_CONFIDENCE_TO_TRUST)
}

/** Uncertain deposits above the policy's % of their period's income. */
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

function isUncertainCharge(r: LedgerRow, minConfidence: number): boolean {
  if (r.type !== 'debit' || r.internal || !r.verified) return false
  const c = r.classification
  const debt = c.category === 'loan_payment' || c.category === 'interest'
  return c.confidence < (debt ? CHARGE_DEBT_CONFIDENCE_TO_TRUST : minConfidence)
}

/**
 * Uncertain charges above the same % threshold as deposits. A period with no income is
 * measured against its charges.
 */
export function uncertainCharges(ledger: Ledger, policy: Policy, minConfidence: number): LedgerRow[] {
  const pct = policy.clarification.askWhenAmountAbovePctOfIncome / 100
  const out: LedgerRow[] = []
  for (const p of ledger.periods) {
    const rows = ledger.rows.filter((r) => r.period === p && !r.internal && r.verified)
    const credits = rows.filter((r) => r.type === 'credit')
    const income = sumMoney(credits.filter((r) => (r.classification.category === 'customer_payment' && r.classification.confidence >= minConfidence) || isUncertainCredit(r, minConfidence)).map((r) => r.amount))
    const base = income > 0 ? income : sumMoney(rows.filter((r) => r.type === 'debit').map((r) => r.amount))
    out.push(...rows.filter((r) => isUncertainCharge(r, minConfidence) && r.amount > pct * base))
  }
  return out.sort((a, b) => b.amount - a.amount || a.day - b.day)
}

/** Individual: from the holder type read, or from a 13-character RFC if it wasn't read. */
export function isIndividualHolder(statements: readonly StatementExtraction[]): boolean {
  const s = statements.find((x) => x.classification.document_type === 'bank_statement')
  if (!s) return false
  const type = s.holder.holder_type.value
  if (type !== null) return type !== 'legal_entity'
  const rfc = s.holder.rfc.value?.replace(/[\s-]/g, '') ?? ''
  return rfc.length === 13
}

/** Accounts in another currency with transactions (the ledger ignores them). */
export function foreignCurrencyAccounts(statements: readonly StatementExtraction[]): { currency: string; transactions: number }[] {
  const out: { currency: string; transactions: number }[] = []
  for (const s of statements) {
    if (s.classification.document_type !== 'bank_statement') continue
    for (const a of s.accounts) {
      const currency = a.currency.value
      if (currency === null || currency === 'MXN' || a.account_type.value === 'credit_card') continue
      const transactions = a.periods.reduce((n, p) => n + p.transactions.length, 0)
      if (transactions > 0) out.push({ currency, transactions })
    }
  }
  return out
}

function reclassified(statements: readonly StatementExtraction[], rows: readonly LedgerRow[], category: TransactionCategory = 'customer_payment'): StatementExtraction[] {
  const keys = new Set(rows.map((r) => `${r.ref.document_sha256}#${r.ref.transaction_id}`))
  return statements.map((s) => ({
    ...s,
    accounts: s.accounts.map((a) => ({
      ...a,
      periods: a.periods.map((p) => ({
        ...p,
        transactions: p.transactions.map((t) =>
          keys.has(`${s.document.sha256}#${t.id}`)
            ? { ...t, classification: { category, confidence: 1, counterparty: t.classification?.counterparty ?? null, counterparty_rfc: t.classification?.counterparty_rfc ?? null, classifier: COUNTERFACTUAL_CLASSIFIER } }
            : t,
        ),
      })),
    })),
  }))
}

/**
 * Status and limit band from the score and its caps, without gates: what a movement can change.
 * A final verdict worse than the band (no available line) counts too, since a doubtful charge
 * usually moves the limit, not the score.
 */
function scoreOutcome(policy: Policy, d: Decision): { status: FinalDecisionStatus; band: number } {
  const band = d.band
  if (band === null || d.status === 'not_qualified') return { status: 'not_qualified', band: Number.MAX_SAFE_INTEGER }
  let status: FinalDecisionStatus = band.status
  for (const c of d.evaluation.caps) if (c.applied && FINAL_STATUS_RANK[c.max_status] < FINAL_STATUS_RANK[status]) status = c.max_status
  const same = policy.decision.bands.findIndex((b) => b.status === status)
  return { status, band: status === band.status || same < 0 ? band.index : same }
}

function better(a: { status: FinalDecisionStatus; band: number }, b: { status: FinalDecisionStatus; band: number }): boolean {
  return FINAL_STATUS_RANK[a.status] > FINAL_STATUS_RANK[b.status] || (a.status === b.status && a.band < b.band)
}

type Outcome = { status: FinalDecisionStatus; band: number }
/** A counterfactual result: score status and band, plus the full decision for `next_steps`. */
type Run = Outcome & { decision: Decision }

/** A counterfactual that would move the band: the question that settles it, with its reason and `next_step`. */
interface Ask {
  topic: AskTopic
  rows: LedgerRow[]
  reason: { code: string; message: string; features: Decision['reasons'][number]['features'] }
  step: NextStep | null
  /** With no rounds left: true if the doubt sends it to human review (movements), false if we decide without asking. */
  escalates: boolean
}

function changed(profile: Profile, best: Profile, features: readonly (keyof Profile['features'])[]): NextStep['related'] {
  return features.filter((f) => best.features[f].value !== profile.features[f].value).map((f) => ({ feature: f, current_value: profile.features[f].value, target_value: best.features[f].value }))
}

/**
 * Profile with the main buyer identified: their payments meet the policy's target, so the
 * dimension gets full points and the "no payments" cap doesn't apply.
 */
function withBuyerPayments(policy: Policy, profile: Profile): Profile {
  const target = Math.max(1, ...policy.score.dimensions.filter((d) => d.feature === 'buyer_payments_count').map((d) => Math.ceil(Math.max(d.fullAt, d.zeroAt))))
  const entry = { value: target, confidence: 1, verification: 'verified' as const, provenance: 'owner_answer' as const, evidence: [], note: 'contrafactual: pagos del cliente principal' }
  return { ...profile, features: { ...profile.features, buyer_payments_count: entry } }
}

interface Ctx {
  input: DecideInput
  profile: Profile
  ledger: Ledger
  base: Decision
  declarations: OwnerDeclarations
  /** Outcome of the base decision, without gates. */
  from: Outcome
  /** Re-evaluates the policy on a modified profile. */
  outcomeOf: (p: Profile) => Run
  /** Rebuilds the profile from modified statements or declarations. */
  profileOf: (statements: readonly StatementExtraction[], d?: OwnerDeclarations) => Profile
}

/** Foreign-currency accounts are never mixed with pesos: unless a gate already rejects, a person reviews. */
function foreignCurrencyResult(input: DecideInput, base: Decision, ledger: Ledger): DecideResult | null {
  const foreign = foreignCurrencyAccounts(input.statements)
  if (foreign.length === 0 || base.evaluation.gates.some((g) => g.effect === 'not_qualified')) return null
  const currencies = [...new Set(foreign.map((f) => f.currency))].join(', ')
  const mxn = ledger.periods.length > 0
  const decision = Decision.parse({
    ...base,
    status: 'human_review',
    limit: null,
    clarification: null,
    reasons: [
      ...base.reasons,
      {
        code: 'foreign_currency_statement',
        message: `El estado de cuenta trae ${String(foreign.length)} cuenta(s) en ${currencies} con movimientos: no se convierten ni se mezclan con pesos${mxn ? '; el perfil solo usa las cuentas en MXN' : ' y no hay cuentas en MXN que analizar'}. Pasa a revisión humana.`,
        features: [],
      },
    ],
  })
  return { decision, ledger, asked: [] }
}

/** Deposits we could ask about: would the band move if they were customer payments? */
function depositAsk(c: Ctx, deposits: LedgerRow[], depBest: Profile, to: Run): Ask {
  const { base, profile, from } = c
  const total = sumMoney(deposits.map((r) => r.amount))
  return {
    topic: 'deposit_classification',
    rows: deposits,
    escalates: true,
    reason: {
      code: 'deposit_clarification',
      message: `${String(deposits.length)} abono(s) por ${fmt(total)} sin clasificar con confianza (el mayor de ${fmt(deposits[0]?.amount)}): si son pagos de clientes el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
      features: ['operating_income_monthly'],
    },
    step: {
      code: 'classify_deposits',
      feature: 'operating_income_monthly',
      current_value: profile.features.operating_income_monthly.value,
      target_value: depBest.features.operating_income_monthly.value,
      related: changed(profile, depBest, ['new_debt_in_period', 'buyer_payments_count']),
      from: { status: base.status, score: base.score, limit: base.limit },
      to: { status: to.decision.status, score: to.decision.score, limit: to.decision.limit },
      message: null,
    },
  }
}

/** Charges we could ask about: would the band move if they were transfers to the holder's own accounts? */
function chargeAsk(c: Ctx, charges: LedgerRow[], chgBest: Profile, to: Run): Ask {
  const { base, profile, from } = c
    const total = sumMoney(charges.map((r) => r.amount))
    const debt = charges.filter((r) => r.classification.category === 'loan_payment' || r.classification.category === 'interest').length
  return {
    topic: 'charge_classification',
    rows: charges,
    escalates: true,
    reason: {
      code: 'charge_clarification',
      message: `${String(charges.length)} cargo(s) por ${fmt(total)} sin clasificar con confianza${debt > 0 ? ` (${String(debt)} tomado(s) como pago de crédito)` : ''}, el mayor de ${fmt(charges[0]?.amount)}: si son traspasos a otra cuenta del titular el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
      features: ['debt_service_monthly', 'free_cash_flow_monthly'],
    },
    step: {
      code: 'classify_charges',
      feature: 'free_cash_flow_monthly',
      current_value: profile.features.free_cash_flow_monthly.value,
      target_value: chgBest.features.free_cash_flow_monthly.value,
      related: changed(profile, chgBest, ['debt_service_monthly', 'debt_capacity']),
      from: { status: base.status, score: base.score, limit: base.limit },
      to: { status: to.decision.status, score: to.decision.score, limit: to.decision.limit },
      message: null,
    },
  }
}

interface Candidate {
  rows: LedgerRow[]
  best: Profile | null
  run: Run | null
}

/** The profile and outcome we'd get if these rows were reclassified favorably. */
function candidateOf(c: Ctx, rows: LedgerRow[], category?: TransactionCategory): Candidate {
  if (rows.length === 0) return { rows, best: null, run: null }
  const best = c.profileOf(reclassified(c.input.statements, rows, category))
  return { rows, best, run: c.outcomeOf(best) }
}

/** Both candidates reclassified at once, for when neither moves the band alone. */
function pairedRun(c: Ctx, dep: Candidate, chg: Candidate): Run | null {
  if (!dep.best || !chg.best) return null
  return c.outcomeOf(c.profileOf(reclassified(reclassified(c.input.statements, dep.rows), chg.rows, 'own_transfer')))
}

/** Deposit and charge questions. Each alone, or both together if only the pair moves the band. */
function movementAsks(c: Ctx): Ask[] {
  const { input, profile, ledger, base, from } = c
  if (base.status === 'qualified') return []
  const minConf = profile.parameters.min_classification_confidence
  const dep = candidateOf(c, uncertainDeposits(ledger, input.policy, minConf))
  const chg = candidateOf(c, uncertainCharges(ledger, input.policy, minConf), 'own_transfer')
  const wins = (r: Run | null) => r !== null && better(r, from)
  const depAlone = wins(dep.run)
  const chgAlone = wins(chg.run)
  const both = depAlone || chgAlone ? null : pairedRun(c, dep, chg)
  const asks: Ask[] = []
  const depRun = both ?? dep.run
  if ((depAlone || wins(both)) && dep.best && depRun) asks.push(depositAsk(c, dep.rows, dep.best, depRun))
  const chgRun = both ?? chg.run
  if ((chgAlone || wins(both)) && chg.best && chgRun) asks.push(chargeAsk(c, chg.rows, chg.best, chgRun))
  return asks
}

/**
 * Main buyer: a request without a buyer leaves the buyer dimension at zero and applies a cap.
 * Ask if the buyer's payments, once found, would move the band. Without a request there is no
 * invoice to advance, so the buyer is not evaluated by design.
 */
function buyerAsk(c: Ctx): Ask | null {
  const { input, profile, ledger, base, declarations, from, outcomeOf } = c
  const hasCredits = ledger.rows.some((r) => r.type === 'credit' && !r.internal && r.verified)
  const buyerAsked = declarations.answered.includes('main_buyer')
  if (!(base.status !== 'qualified' && input.askMainBuyer !== false && input.request !== null && input.request.buyer === null && declarations.buyer === null && !buyerAsked && hasCredits)) return null
  const to = outcomeOf(withBuyerPayments(input.policy, profile))
  if (!better(to, from)) return null
  return {
    topic: 'main_buyer',
    rows: [],
    escalates: false,
    reason: {
      code: 'main_buyer_clarification',
      message: `La solicitud no dice a quién se facturó: si los pagos del cliente principal aparecen en el estado de cuenta el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
      features: ['buyer_payments_count'],
    },
    step: null,
  }
}

/**
 * Account use, for individuals: in a mixed account, third-party transfers with no sales signal
 * are not assumed to be customer payments (ledger.ts). Ask if that would move the band.
 */
function accountUseAsk(c: Ctx): Ask | null {
  const { input, declarations, from, outcomeOf } = c
  if (!(isIndividualHolder(input.statements) && declarations.account_use === null && !declarations.answered.includes('account_use'))) return null
  const mixed = buildProfileWithLedger({ ...input, declarations: { ...declarations, account_use: 'mixed' } })
  const discounted = mixed.ledger.rows.filter((r) => r.mixedUseDiscount && r.verified)
  if (discounted.length === 0) return null
    const to = outcomeOf(mixed.profile)
  if (to.status === from.status && to.band === from.band) return null
  return {
    topic: 'account_use',
    rows: [],
    escalates: false,
    reason: {
      code: 'account_use_clarification',
      message: `El titular es persona física y ${String(discounted.length)} abono(s) por ${fmt(sumMoney(discounted.map((r) => r.amount)))} se toman como pago de cliente solo por ser transferencias de terceros: si la cuenta también es personal no cuentan como ingreso y el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
      features: ['operating_income_monthly'],
    },
    step: null,
  }
}

/** No rounds left: a doubtful movement that moves the band goes to a person. Buyer and account use are decided without asking. */
function exhaustedResult(c: Ctx, asks: Ask[]): DecideResult {
  const { base, ledger } = c
  if (!asks.some((a) => a.escalates)) return { decision: base, ledger, asked: [] }
  const steps = asks.flatMap((a) => (a.step ? [a.step] : []))
  const txAsks = asks.filter((a) => a.rows.length > 0)
  const decision = Decision.parse({
    ...base,
    status: 'human_review',
    limit: null,
    clarification: null,
    reasons: [...base.reasons, ...asks.filter((a) => a.escalates).map((a) => a.reason), { code: 'clarification_rounds_exhausted', message: 'Sin rondas de aclaración disponibles: pasa a revisión humana.', features: [] }],
    next_steps: [...steps, ...base.next_steps],
  })
  return { decision, ledger, asked: txAsks.flatMap((a) => a.rows.slice(0, MAX_ASKED_TRANSACTIONS)) }
}

function clarificationResult(c: Ctx, asks: Ask[]): DecideResult {
  const { base, ledger } = c
  const steps = asks.flatMap((a) => (a.step ? [a.step] : []))
  const txAsks = asks.filter((a) => a.rows.length > 0)
  const askedRows = txAsks.flatMap((a) => a.rows.slice(0, MAX_ASKED_TRANSACTIONS))
  const refs: TransactionRef[] = askedRows.map((r) => r.ref)
  const topics = [...new Set([...(base.clarification?.topics ?? []), ...asks.map((a) => a.topic)])]
  const decision = Decision.parse({
    ...base,
    status: 'needs_clarification',
    limit: null,
    clarification: { topics, issue_ids: base.clarification?.issue_ids ?? [], transactions: refs },
    reasons: [
      ...base.reasons,
      ...asks.map((a) => {
        const shown = a.rows.slice(0, MAX_ASKED_TRANSACTIONS)
        return shown.length > 0 ? { ...a.reason, message: `${a.reason.message} Se pregunta: ${shown.map(evidenceRef).join(', ')}.` } : a.reason
      }),
    ],
    next_steps: [...steps, ...base.next_steps],
  })
  return { decision, ledger, asked: askedRows }
}

export function decide(raw: DecideInput): DecideResult {
  // The months evaluated are the policy's: the profile only sees those.
  const input: DecideInput = { ...raw, parameters: { ...raw.parameters, evaluation_months: raw.policy.history.months } }
  const { profile, ledger } = buildProfileWithLedger(input)
  const rounds = input.clarificationRoundsUsed ?? 0
  const opts: EvaluateOptions = { policyId: input.policyId ?? null, clarificationRoundsUsed: rounds, ...(input.statementAge ? { statementAge: input.statementAge } : {}) }
  const base = evaluate(input.policy, profile, opts)
  const declarations: OwnerDeclarations = input.declarations ?? NO_DECLARATIONS

  const foreign = foreignCurrencyResult(input, base, ledger)
  if (foreign) return foreign

  // A rejecting or reviewing gate can't be changed by any answer.
  const decisiveGate = base.evaluation.gates.some((g) => g.effect === 'not_qualified' || g.effect === 'human_review')
  if (decisiveGate || base.status === 'human_review') return { decision: base, ledger, asked: [] }

  const from = scoreOutcome(input.policy, base)
  const outcomeOf = (p: Profile): Run => {
    const d = evaluate(input.policy, p, { ...opts, counterfactuals: false })
    return { ...scoreOutcome(input.policy, d), decision: d }
  }
  const profileOf = (statements: readonly StatementExtraction[], d: OwnerDeclarations = declarations) => buildProfileWithLedger({ ...input, statements, declarations: d }).profile
  const ctx: Ctx = { input, profile, ledger, base, declarations, from, outcomeOf, profileOf }

  const asks = [...movementAsks(ctx), ...[buyerAsk(ctx), accountUseAsk(ctx)].filter((a) => a !== null)]
  if (asks.length === 0) return { decision: base, ledger, asked: [] }
  return rounds >= input.policy.clarification.maxRounds ? exhaustedResult(ctx, asks) : clarificationResult(ctx, asks)
}
