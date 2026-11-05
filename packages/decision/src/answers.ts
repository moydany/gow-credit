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
 * - **Documentos**: rutas a PDFs nuevos (estado reciente, meses anteriores, páginas faltantes).
 * - **No sé / no tengo**: se registra; la pregunta sigue sin resolver.
 */
import { Decision, type ApplicationRequest, type OwnerAnswer, type Question, type StatementExtraction, type SupplierIdentity, type Transaction, type TransactionClassification } from '@gow/contracts'
import { classifyByRules } from './classify/rules.ts'
import { ruleContext } from './ledger.ts'

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
}

export interface ApplyAnswersInput {
  statements: readonly StatementExtraction[]
  supplier: SupplierIdentity | null
  request: ApplicationRequest | null
  questions: readonly Question[]
  answers: readonly OwnerAnswer[]
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
        const current = existingClassification(s, t, input.request)
        if (current.category !== answer.category && current.confidence >= CONTRADICTION_CONFIDENCE) {
          contradictions.push({ question_id: q.id, reason: `el dueño dice ${answer.category}, el documento indica ${current.category} con confianza ${String(current.confidence)}` })
          break
        }
        statements[idx] = setClassification(s, t.id, { category: answer.category, confidence: 1, counterparty: answer.counterparty, counterparty_rfc: current.counterparty_rfc, classifier: 'owner_answer' })
        applied.push(answer)
        break
      }
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
  return { statements, supplier, applied, rejected, contradictions, documents }
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
