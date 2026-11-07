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

export function applyOwnerAnswers(input: ApplyAnswersInput): AppliedAnswers {
  const statements = [...input.statements]
  let supplier = input.supplier
  const applied: OwnerAnswer[] = []
  const rejected: AnswerIssue[] = []
  const contradictions: AnswerIssue[] = []
  const documents: string[] = []
  const seen = new Set<string>()
  let declarations: OwnerDeclarations = input.declarations ?? NO_DECLARATIONS
  const request = effectiveRequest(input.request, declarations)

  for (const answer of input.answers) {
    const q = input.questions.find((x) => x.id === answer.question_id)
    const reject = (reason: string) => rejected.push({ question_id: answer.question_id, reason })
    if (!q) {
      reject('no hay una pregunta con ese id en esta solicitud')
      continue
    }
    if (seen.has(q.id)) {
      reject('pregunta respondida dos veces: vale la primera respuesta')
      continue
    }
    if (answer.kind !== 'decline' && answer.kind !== q.kind) {
      reject(`la pregunta espera una respuesta de tipo ${q.kind}, no ${answer.kind}`)
      continue
    }
    seen.add(q.id)
    // Main client and account use are not asked again, even after a "no sé".
    if (q.kind === 'buyer' || q.kind === 'account_use') {
      const topic = q.kind === 'buyer' ? 'main_buyer' : 'account_use'
      if (!declarations.answered.includes(topic)) declarations = { ...declarations, answered: [...declarations.answered, topic] }
    }

    switch (answer.kind) {
      case 'decline':
        applied.push(answer)
        break
      case 'deposit': {
        const ref = q.transaction
        const idx = ref ? statements.findIndex((s) => s.document.sha256 === ref.document_sha256) : -1
        const s = statements[idx]
        const t = ref && s ? findTransaction(s, ref.transaction_id) : null
        if (!ref || !s || !t) {
          reject('el movimiento de la pregunta ya no está en la extracción')
          break
        }
        const current = existingClassification(s, t, request)
        if (current.category !== answer.category && current.confidence >= CONTRADICTION_CONFIDENCE) {
          contradictions.push({ question_id: q.id, reason: `el dueño dice ${answer.category}, el documento indica ${current.category} con confianza ${String(current.confidence)}` })
          break
        }
        statements[idx] = setClassification(s, t.id, { category: answer.category, confidence: 1, counterparty: answer.counterparty, counterparty_rfc: current.counterparty_rfc, classifier: 'owner_answer' })
        applied.push(answer)
        break
      }
      case 'charge': {
        const ref = q.transaction
        const idx = ref ? statements.findIndex((s) => s.document.sha256 === ref.document_sha256) : -1
        const s = statements[idx]
        const t = ref && s ? findTransaction(s, ref.transaction_id) : null
        if (!ref || !s || !t || t.type !== 'debit') {
          reject('el cargo de la pregunta ya no está en la extracción')
          break
        }
        const category = CHARGE_CATEGORY[answer.category]
        const current = existingClassification(s, t, request)
        if (chargeGroup(current.category) !== chargeGroup(category) && current.confidence >= CONTRADICTION_CONFIDENCE) {
          contradictions.push({ question_id: q.id, reason: `el dueño dice ${answer.category}, el documento indica ${current.category} con confianza ${String(current.confidence)}` })
          break
        }
        statements[idx] = setClassification(s, t.id, { category, confidence: 1, counterparty: answer.counterparty, counterparty_rfc: current.counterparty_rfc, classifier: 'owner_answer' })
        applied.push(answer)
        break
      }
      case 'buyer':
        // A buyer already on the request wins: the answer is only recorded.
        if (!input.request?.buyer) declarations = { ...declarations, buyer: answer.name }
        applied.push(answer)
        break
      case 'account_use':
        declarations = { ...declarations, account_use: answer.use }
        applied.push(answer)
        break
      case 'identity': {
        if (supplier !== null) {
          applied.push(answer)
          break
        }
        if (answer.legal_name === null) {
          reject('para declarar la identidad hace falta al menos la razón social o el nombre del titular (legal_name)')
          break
        }
        supplier = { legal_name: answer.legal_name, rfc: answer.rfc, clabes: answer.clabe === null ? [] : [answer.clabe] }
        applied.push(answer)
        break
      }
      case 'documents':
        documents.push(...answer.paths)
        applied.push(answer)
        break
    }
  }
  return { statements, supplier, applied, rejected, contradictions, documents, declarations }
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
