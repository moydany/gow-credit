/**
 * Owner answers merged onto the extraction as supplier-provided fields, with their origin marked.
 * Pure: paths to new documents are returned so the workflow can extract them.
 *
 * - **Deposit**: classification becomes `classifier: owner_answer`, confidence 1; the profile
 *   keeps that provenance. If it contradicts a confident document classification (a rule, or the
 *   model at 0.8+ on another category) it is not merged and the request goes to human review,
 *   e.g. "says client payment, but the sender is a lender".
 * - **Identity**: the declared identity the document is compared against. If one is already
 *   registered (the tenant's), the registered one wins and the answer is only recorded; the
 *   document is still what gets verified.
 * - **Charge**: same as a deposit. "Gasto personal" is stored as `other` (still money out, not a
 *   credit payment). It only contradicts the document when it changes the group that weighs in
 *   the flow (debt, own transfer or expense) against a confident classification.
 * - **Main client**: if the request had no buyer, the owner's name becomes the analysis buyer;
 *   its payments are searched by name in the statement.
 * - **Account use**: declared in the profile; changes how deposits that are only presumed client
 *   payments are read (ledger.ts).
 * - **Documents**: paths to new PDFs (recent statement, earlier months, missing pages).
 * - **No sé / no tengo**: recorded; the question stays unresolved.
 */
import {
  Decision,
  NO_DECLARATIONS,
  type ApplicationRequest,
  type ChargeAnswerCategory,
  type OwnerAnswer,
  type OwnerDeclarations,
  type Question,
  type StatementExtraction,
  type SupplierIdentity,
  type Transaction,
  type TransactionCategory,
  type TransactionClassification,
} from '@gow/contracts'
import { classifyByRules } from './classify/rules.ts'
import { ruleContext } from './ledger.ts'
import { effectiveRequest } from './profile.ts'

/** An existing classification with at least this confidence on another category makes the answer contradict it. */
export const CONTRADICTION_CONFIDENCE = 0.8

export interface AnswerIssue {
  question_id: string
  reason: string
}

export interface AppliedAnswers {
  statements: StatementExtraction[]
  supplier: SupplierIdentity | null
  applied: OwnerAnswer[]
  rejected: AnswerIssue[]
  contradictions: AnswerIssue[]
  /** Paths of new PDFs, as they came in the answer. */
  documents: string[]
  /** Main client and account use, accumulated with what was already declared. */
  declarations: OwnerDeclarations
}

export interface ApplyAnswersInput {
  statements: readonly StatementExtraction[]
  supplier: SupplierIdentity | null
  request: ApplicationRequest | null
  questions: readonly Question[]
  answers: readonly OwnerAnswer[]
  /** Declared in earlier rounds. */
  declarations?: OwnerDeclarations
}

/** Category a charge answer is stored under. */
export const CHARGE_CATEGORY: Readonly<Record<ChargeAnswerCategory, TransactionCategory>> = {
  loan_payment: 'loan_payment',
  supplier_payment: 'supplier_payment',
  own_transfer: 'own_transfer',
  personal_expense: 'other',
  other: 'other',
}

/** How a charge weighs in the flow (features/statement.ts): debt, own transfer or expense. */
function chargeGroup(c: TransactionCategory): 'debt' | 'own' | 'expense' {
  if (c === 'loan_payment' || c === 'interest') return 'debt'
  return c === 'own_transfer' ? 'own' : 'expense'
}

function existingClassification(s: StatementExtraction, t: Transaction, request: ApplicationRequest | null): TransactionClassification {
  const rules = classifyByRules(t, ruleContext(s, request)).classification
  const given = t.classification
  return given !== null && given.confidence >= rules.confidence ? given : rules
}

function setClassification(s: StatementExtraction, txId: string, c: TransactionClassification): StatementExtraction {
  return {
    ...s,
    accounts: s.accounts.map((a) => ({
      ...a,
      periods: a.periods.map((p) => ({ ...p, transactions: p.transactions.map((t) => (t.id === txId ? { ...t, classification: c } : t)) })),
    })),
  }
}

function findTransaction(s: StatementExtraction, txId: string): Transaction | null {
  for (const a of s.accounts) for (const p of a.periods) for (const t of p.transactions) if (t.id === txId) return t
  return null
}

interface AnswersApplyState {
  statements: StatementExtraction[]
  supplier: ApplyAnswersInput['supplier']
  applied: OwnerAnswer[]
  rejected: AnswerIssue[]
  contradictions: AnswerIssue[]
  documents: string[]
  declarations: OwnerDeclarations
}

function applyDepositAnswer(
  state: AnswersApplyState,
  q: Question,
  answer: Extract<OwnerAnswer, { kind: 'deposit' }>,
  request: ApplyAnswersInput['request'],
): void {
  const ref = q.transaction
  const idx = ref ? state.statements.findIndex((s) => s.document.sha256 === ref.document_sha256) : -1
  const s = state.statements[idx]
  const t = ref && s ? findTransaction(s, ref.transaction_id) : null
  if (!ref || !s || !t) {
    state.rejected.push({ question_id: answer.question_id, reason: 'el movimiento de la pregunta ya no está en la extracción' })
    return
  }
  const current = existingClassification(s, t, request)
  if (current.category !== answer.category && current.confidence >= CONTRADICTION_CONFIDENCE) {
    state.contradictions.push({
      question_id: q.id,
      reason: `el dueño dice ${answer.category}, el documento indica ${current.category} con confianza ${String(current.confidence)}`,
    })
    return
  }
  state.statements[idx] = setClassification(s, t.id, {
    category: answer.category,
    confidence: 1,
    counterparty: answer.counterparty,
    counterparty_rfc: current.counterparty_rfc,
    classifier: 'owner_answer',
  })
  state.applied.push(answer)
}

function applyChargeAnswer(
  state: AnswersApplyState,
  q: Question,
  answer: Extract<OwnerAnswer, { kind: 'charge' }>,
  request: ApplyAnswersInput['request'],
): void {
  const ref = q.transaction
  const idx = ref ? state.statements.findIndex((s) => s.document.sha256 === ref.document_sha256) : -1
  const s = state.statements[idx]
  const t = ref && s ? findTransaction(s, ref.transaction_id) : null
  if (!ref || !s || !t || t.type !== 'debit') {
    state.rejected.push({ question_id: answer.question_id, reason: 'el cargo de la pregunta ya no está en la extracción' })
    return
  }
  const category = CHARGE_CATEGORY[answer.category]
  const current = existingClassification(s, t, request)
  if (chargeGroup(current.category) !== chargeGroup(category) && current.confidence >= CONTRADICTION_CONFIDENCE) {
    state.contradictions.push({
      question_id: q.id,
      reason: `el dueño dice ${answer.category}, el documento indica ${current.category} con confianza ${String(current.confidence)}`,
    })
    return
  }
  state.statements[idx] = setClassification(s, t.id, {
    category,
    confidence: 1,
    counterparty: answer.counterparty,
    counterparty_rfc: current.counterparty_rfc,
    classifier: 'owner_answer',
  })
  state.applied.push(answer)
}

function applyIdentityAnswer(
  state: AnswersApplyState,
  answer: Extract<OwnerAnswer, { kind: 'identity' }>,
): void {
  if (state.supplier !== null) {
    state.applied.push(answer)
    return
  }
  if (answer.legal_name === null) {
    state.rejected.push({
      question_id: answer.question_id,
      reason: 'para declarar la identidad hace falta al menos la razón social o el nombre del titular (legal_name)',
    })
    return
  }
  state.supplier = {
    legal_name: answer.legal_name,
    rfc: answer.rfc,
    clabes: answer.clabe === null ? [] : [answer.clabe],
  }
  state.applied.push(answer)
}

function recordTopicAnswered(kind: Question['kind'], declarations: OwnerDeclarations): OwnerDeclarations {
  if (kind === 'buyer' || kind === 'account_use') {
    const topic = kind === 'buyer' ? 'main_buyer' : 'account_use'
    if (!declarations.answered.includes(topic)) {
      return { ...declarations, answered: [...declarations.answered, topic] }
    }
  }
  return declarations
}

function validateAnswer(
  answer: OwnerAnswer,
  questions: readonly Question[],
  seen: Set<string>,
): { q: Question } | { rejectReason: string } {
  const q = questions.find((x) => x.id === answer.question_id)
  if (!q) return { rejectReason: 'no hay una pregunta con ese id en esta solicitud' }
  if (seen.has(q.id)) return { rejectReason: 'pregunta respondida dos veces: vale la primera respuesta' }
  if (answer.kind !== 'decline' && answer.kind !== q.kind) {
    return { rejectReason: `la pregunta espera una respuesta de tipo ${q.kind}, no ${answer.kind}` }
  }
  seen.add(q.id)
  return { q }
}

function dispatchSingleAnswer(
  state: AnswersApplyState,
  q: Question,
  answer: OwnerAnswer,
  input: ApplyAnswersInput,
  request: ApplyAnswersInput['request'],
): void {
  switch (answer.kind) {
    case 'decline':
      state.applied.push(answer)
      break
    case 'deposit':
      applyDepositAnswer(state, q, answer, request)
      break
    case 'charge':
      applyChargeAnswer(state, q, answer, request)
      break
    case 'buyer':
      if (!input.request?.buyer) state.declarations = { ...state.declarations, buyer: answer.name }
      state.applied.push(answer)
      break
    case 'account_use':
      state.declarations = { ...state.declarations, account_use: answer.use }
      state.applied.push(answer)
      break
    case 'identity':
      applyIdentityAnswer(state, answer)
      break
    case 'documents':
      state.documents.push(...answer.paths)
      state.applied.push(answer)
      break
  }
}

export function applyOwnerAnswers(input: ApplyAnswersInput): AppliedAnswers {
  const state: AnswersApplyState = {
    statements: [...input.statements],
    supplier: input.supplier,
    applied: [],
    rejected: [],
    contradictions: [],
    documents: [],
    declarations: input.declarations ?? NO_DECLARATIONS,
  }
  const seen = new Set<string>()
  const request = effectiveRequest(input.request, state.declarations)

  for (const answer of input.answers) {
    const val = validateAnswer(answer, input.questions, seen)
    if ('rejectReason' in val) {
      state.rejected.push({ question_id: answer.question_id, reason: val.rejectReason })
      continue
    }
    state.declarations = recordTopicAnswered(val.q.kind, state.declarations)
    dispatchSingleAnswer(state, val.q, answer, input, request)
  }

  return {
    statements: state.statements,
    supplier: state.supplier,
    applied: state.applied,
    rejected: state.rejected,
    contradictions: state.contradictions,
    documents: state.documents,
    declarations: state.declarations,
  }
}

/**
 * An answer that very likely contradicts the document goes to human review instead of being
 * merged. A gate rejection is respected: review would not improve it.
 */
export function withContradictions(decision: Decision, contradictions: readonly AnswerIssue[]): Decision {
  if (contradictions.length === 0 || decision.status === 'not_qualified') return decision
  return Decision.parse({
    ...decision,
    status: 'human_review',
    limit: null,
    clarification: null,
    reasons: [
      ...decision.reasons,
      {
        code: 'owner_answer_contradicts_document',
        message: `La respuesta del dueño contradice el documento en ${String(contradictions.length)} pregunta(s) (${contradictions.map((c) => c.question_id).join(', ')}): pasa a revisión humana.`,
        features: [],
      },
    ],
  })
}
