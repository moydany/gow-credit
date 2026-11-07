/**
 * Respuestas del dueño sobre la extracción (docs/02 §3: "se mergean sobre la extracción como
 * campos aportados por el proveedor, con origen marcado"; docs/04 §4; ADR 0015). Puro: las rutas
 * de documentos nuevos se devuelven para que el workflow los extraiga.
 *
 * - **Abono**: la clasificación queda con `classifier: owner_answer` y confianza 1; el perfil
 *   la marca con esa procedencia. Si contradice una clasificación confiable del documento (una
 *   regla o el modelo con 0.8 o más en otra categoría), no se mergea y la solicitud va a revisión
 *   humana: es el caso "dice que es pago de cliente, pero el emisor es una financiera".
 * - **Identidad**: es la identidad declarada contra la que se compara el documento. Si ya había
 *   una registrada (la del tenant), manda la registrada y la respuesta solo queda en el registro:
 *   el documento sigue siendo lo que se verifica.
 * - **Cargo** (ADR 0050): igual que un abono. "Gasto personal" se guarda como `other` (sigue siendo
 *   salida de dinero, no pago de crédito). Solo contradice al documento si cambia el grupo que pesa
 *   en el flujo (deuda, traspaso propio o gasto) contra una clasificación confiable.
 * - **Cliente principal** (ADR 0050): si la solicitud no traía comprador, el nombre que da el dueño
 *   es el comprador del análisis; sus pagos se buscan por nombre en el estado de cuenta.
 * - **Uso de la cuenta** (ADR 0050): queda declarado en el perfil y cambia cómo se leen los abonos
 *   que solo se presumen pago de cliente (ledger.ts).
 * - **Documentos**: rutas a PDFs nuevos (estado reciente, meses anteriores, páginas faltantes).
 * - **No sé / no tengo**: se registra; la pregunta sigue sin resolver.
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

/** Una clasificación existente con esta confianza o más en otra categoría hace que la respuesta la contradiga. */
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
  /** Rutas de PDFs nuevos, tal como vienen en la respuesta. */
  documents: string[]
  /** Cliente principal y uso de la cuenta, acumulados con lo que ya se había declarado. */
  declarations: OwnerDeclarations
}

export interface ApplyAnswersInput {
  statements: readonly StatementExtraction[]
  supplier: SupplierIdentity | null
  request: ApplicationRequest | null
  questions: readonly Question[]
  answers: readonly OwnerAnswer[]
  /** Lo declarado en rondas anteriores. */
  declarations?: OwnerDeclarations
}

/** Categoría con la que se guarda la respuesta sobre un cargo. */
export const CHARGE_CATEGORY: Readonly<Record<ChargeAnswerCategory, TransactionCategory>> = {
  loan_payment: 'loan_payment',
  supplier_payment: 'supplier_payment',
  own_transfer: 'own_transfer',
  personal_expense: 'other',
  other: 'other',
}

/** Cómo pesa un cargo en el flujo (features/statement.ts): deuda, traspaso propio o gasto. */
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
    // El cliente principal y el uso de la cuenta no se vuelven a preguntar, ni tras un "no sé".
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
        // Un comprador que ya traía la solicitud manda: la respuesta solo queda en el registro.
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
 * Una respuesta que contradice el documento con alta probabilidad va a revisión humana, no se
 * mergea (docs/04 §4). Un rechazo por compuerta se respeta: la revisión no lo mejora.
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
