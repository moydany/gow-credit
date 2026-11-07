/**
 * `decide`: perfil + motor + la regla de docs/03 §7 a nivel de movimiento y de solicitud. Se le
 * pregunta al proveedor solo lo que puede cambiar la banda, recalculando el perfil con la respuesta
 * más favorable (o, para el uso de la cuenta, la menos favorable) y comparando:
 *
 * - Abonos grandes sin clasificar con confianza (o como préstamo con confianza media): ¿y si son
 *   pagos de clientes?
 * - Cargos grandes dudosos (ADR 0050), en especial los tomados como pago de crédito con confianza
 *   baja: ¿y si son traspasos a otra cuenta del titular?
 * - Cliente principal (ADR 0050), si la solicitud no trae comprador: ¿y si sus pagos aparecen?
 * - Uso de la cuenta (ADR 0050), si el titular es persona física: ¿y si también es personal?
 *
 * Una cuenta en otra moneda no se mezcla con pesos: la solicitud va a revisión humana.
 * Sigue siendo puro: sin LLM ni base.
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

/** Un abono clasificado como préstamo con menos de esta confianza también se pregunta (docs/03 §7). */
export const LOAN_CONFIDENCE_TO_TRUST = 0.9
/**
 * Un cargo tomado como pago de crédito con menos de esta confianza se pregunta (ADR 0050). Es la de
 * `CONTRADICTION_CONFIDENCE`: con más, una respuesta distinta contradice al documento y no se aplica,
 * así que preguntar no serviría.
 */
export const CHARGE_DEBT_CONFIDENCE_TO_TRUST = 0.8
/** Movimientos que se listan en una pregunta. */
export const MAX_ASKED_TRANSACTIONS = 10
export const COUNTERFACTUAL_CLASSIFIER = 'counterfactual'

export interface DecideInput extends ProfileInput {
  policy: Policy
  policyId?: string | null
  clarificationRoundsUsed?: number
  /** Ajuste del tenant (ADR 0049): la antigüedad del documento advierte en vez de pedir otro. */
  statementAge?: StatementAgeSetting
}

export interface DecideResult {
  decision: Decision
  ledger: Ledger
  /** Abonos y cargos inciertos que se preguntaron (vacío si no cambian la banda). */
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

function isUncertainCharge(r: LedgerRow, minConfidence: number): boolean {
  if (r.type !== 'debit' || r.internal || !r.verified) return false
  const c = r.classification
  const debt = c.category === 'loan_payment' || c.category === 'interest'
  return c.confidence < (debt ? CHARGE_DEBT_CONFIDENCE_TO_TRUST : minConfidence)
}

/**
 * Cargos inciertos mayores al % de los ingresos de su periodo que fija la política (el mismo umbral
 * que los abonos). Un periodo sin ingresos se mide contra sus cargos.
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

/** Persona física: por el tipo de titular leído o, si no se leyó, por el RFC de 13 caracteres. */
export function isIndividualHolder(statements: readonly StatementExtraction[]): boolean {
  const s = statements.find((x) => x.classification.document_type === 'bank_statement')
  if (!s) return false
  const type = s.holder.holder_type.value
  if (type !== null) return type !== 'legal_entity'
  const rfc = s.holder.rfc.value?.replace(/[\s-]/g, '') ?? ''
  return rfc.length === 13
}

/** Cuentas de estados de cuenta en otra moneda con movimientos (el ledger no las usa). */
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
 * Estado y banda de la línea que da el puntaje con sus topes, sin compuertas: lo que un movimiento
 * puede mover. Si un tope bajó el estado, la banda es la primera con ese estado (la que fija la línea).
 * Un veredicto final peor que la banda (sin línea disponible: el flujo libre no alcanza) también
 * cuenta (ADR 0050): un cargo dudoso suele mover la línea, no el puntaje.
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
/** Lo que da un contrafactual: estado y banda del puntaje, y el veredicto completo para `next_steps`. */
type Run = Outcome & { decision: Decision }

/** Un contrafactual que movería la banda: la pregunta que lo resuelve, con su motivo y su `next_step`. */
interface Ask {
  topic: AskTopic
  rows: LedgerRow[]
  reason: { code: string; message: string; features: Decision['reasons'][number]['features'] }
  step: NextStep | null
  /** Sin rondas: true si la duda manda a revisión humana (movimientos); false si se decide sin ella. */
  escalates: boolean
}

function changed(profile: Profile, best: Profile, features: readonly (keyof Profile['features'])[]): NextStep['related'] {
  return features.filter((f) => best.features[f].value !== profile.features[f].value).map((f) => ({ feature: f, current_value: profile.features[f].value, target_value: best.features[f].value }))
}

/**
 * Perfil con el cliente principal identificado (ADR 0050): sus pagos cuentan como los que pide la
 * política para dar todos los puntos de la dimensión y no aplicar el tope de "sin pagos".
 */
function withBuyerPayments(policy: Policy, profile: Profile): Profile {
  const target = Math.max(1, ...policy.score.dimensions.filter((d) => d.feature === 'buyer_payments_count').map((d) => Math.ceil(Math.max(d.fullAt, d.zeroAt))))
  const entry = { value: target, confidence: 1, verification: 'verified' as const, provenance: 'owner_answer' as const, evidence: [], note: 'contrafactual: pagos del cliente principal' }
  return { ...profile, features: { ...profile.features, buyer_payments_count: entry } }
}

export function decide(input: DecideInput): DecideResult {
  const { profile, ledger } = buildProfileWithLedger(input)
  const rounds = input.clarificationRoundsUsed ?? 0
  const opts: EvaluateOptions = { policyId: input.policyId ?? null, clarificationRoundsUsed: rounds, ...(input.statementAge ? { statementAge: input.statementAge } : {}) }
  const base = evaluate(input.policy, profile, opts)
  const declarations: OwnerDeclarations = input.declarations ?? NO_DECLARATIONS

  // Otra moneda (ADR 0050): no se convierte ni se mezcla con pesos. Solo una compuerta que ya
  // rechaza, sin depender del flujo, se respeta.
  const foreign = foreignCurrencyAccounts(input.statements)
  if (foreign.length > 0 && !base.evaluation.gates.some((g) => g.effect === 'not_qualified')) {
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

  // Si una compuerta ya rechaza o manda a revisión, ninguna respuesta lo cambia.
  const decisiveGate = base.evaluation.gates.some((g) => g.effect === 'not_qualified' || g.effect === 'human_review')
  if (decisiveGate || base.status === 'human_review') return { decision: base, ledger, asked: [] }

  const minConf = profile.parameters.min_classification_confidence
  const from = scoreOutcome(input.policy, base)
  const outcomeOf = (p: Profile): Run => {
    const d = evaluate(input.policy, p, { ...opts, counterfactuals: false })
    return { ...scoreOutcome(input.policy, d), decision: d }
  }
  const profileOf = (statements: readonly StatementExtraction[], d: OwnerDeclarations = declarations) => buildProfileWithLedger({ ...input, statements, declarations: d }).profile
  const asks: Ask[] = []

  // 1. Movimientos: abonos (¿pagos de clientes?) y cargos (¿traspasos propios?). Solo mejoran.
  if (base.status !== 'qualified') {
    const deposits = uncertainDeposits(ledger, input.policy, minConf)
    const charges = uncertainCharges(ledger, input.policy, minConf)
    const depBest = deposits.length > 0 ? profileOf(reclassified(input.statements, deposits)) : null
    const chgBest = charges.length > 0 ? profileOf(reclassified(input.statements, charges, 'own_transfer')) : null
    const depTo = depBest ? outcomeOf(depBest) : null
    const chgTo = chgBest ? outcomeOf(chgBest) : null
    let askDeposits = depTo !== null && better(depTo, from)
    let askCharges = chgTo !== null && better(chgTo, from)
    let both: Run | null = null
    if (!askDeposits && !askCharges && depBest && chgBest) {
      // Ninguno solo mueve la banda; juntos, quizá.
      both = outcomeOf(profileOf(reclassified(reclassified(input.statements, deposits), charges, 'own_transfer')))
      askDeposits = askCharges = better(both, from)
    }
    const depRun = both ?? depTo
    if (askDeposits && depBest && depRun) {
      const to = depRun
      const total = sumMoney(deposits.map((r) => r.amount))
      asks.push({
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
      })
    }
    const chgRun = both ?? chgTo
    if (askCharges && chgBest && chgRun) {
      const to = chgRun
      const total = sumMoney(charges.map((r) => r.amount))
      const debt = charges.filter((r) => r.classification.category === 'loan_payment' || r.classification.category === 'interest').length
      asks.push({
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
      })
    }
  }

  // 2. Cliente principal: una solicitud sin comprador deja la dimensión del comprador sin puntos y
  // aplica el tope. Se pregunta si sus pagos, de aparecer, moverían la banda. Sin solicitud no hay
  // factura que adelantar: es la línea máxima (ADR 0045) y el comprador no se evalúa por diseño.
  const hasCredits = ledger.rows.some((r) => r.type === 'credit' && !r.internal && r.verified)
  const buyerAsked = declarations.answered.includes('main_buyer')
  if (base.status !== 'qualified' && input.request !== null && input.request.buyer === null && declarations.buyer === null && !buyerAsked && hasCredits) {
    const to = outcomeOf(withBuyerPayments(input.policy, profile))
    if (better(to, from)) {
      asks.push({
        topic: 'main_buyer',
        rows: [],
        escalates: false,
        reason: {
          code: 'main_buyer_clarification',
          message: `La solicitud no dice a quién se facturó: si los pagos del cliente principal aparecen en el estado de cuenta el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
          features: ['buyer_payments_count'],
        },
        step: null,
      })
    }
  }

  // 3. Uso de la cuenta (persona física): en una cuenta mixta las transferencias de terceros sin
  // señal de venta no se presumen pago de cliente (ledger.ts). Se pregunta si eso movería la banda.
  if (isIndividualHolder(input.statements) && declarations.account_use === null && !declarations.answered.includes('account_use')) {
    const mixed = buildProfileWithLedger({ ...input, declarations: { ...declarations, account_use: 'mixed' } })
    const discounted = mixed.ledger.rows.filter((r) => r.mixedUseDiscount && r.verified)
    if (discounted.length > 0) {
      const to = outcomeOf(mixed.profile)
      if (to.status !== from.status || to.band !== from.band) {
        asks.push({
          topic: 'account_use',
          rows: [],
          escalates: false,
          reason: {
            code: 'account_use_clarification',
            message: `El titular es persona física y ${String(discounted.length)} abono(s) por ${fmt(sumMoney(discounted.map((r) => r.amount)))} se toman como pago de cliente solo por ser transferencias de terceros: si la cuenta también es personal no cuentan como ingreso y el resultado iría de "${STATUS_TEXT[from.status]}" a "${STATUS_TEXT[to.status]}".`,
            features: ['operating_income_monthly'],
          },
          step: null,
        })
      }
    }
  }

  if (asks.length === 0) return { decision: base, ledger, asked: [] }
  const steps = asks.flatMap((a) => (a.step ? [a.step] : []))
  const txAsks = asks.filter((a) => a.rows.length > 0)

  if (rounds >= input.policy.clarification.maxRounds) {
    // Sin rondas: un movimiento dudoso que mueve la banda lo revisa una persona; el comprador y el
    // uso de la cuenta no se pueden preguntar y se decide sin ellos (como hasta ahora).
    if (!asks.some((a) => a.escalates)) return { decision: base, ledger, asked: [] }
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
