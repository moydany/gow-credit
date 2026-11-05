/**
 * Preguntas al dueño a partir del veredicto (docs/03 §7). El motor dice qué temas preguntar;
 * aquí se arma una pregunta por tema (una por abono en `deposit_classification`) con los hechos
 * que puede citar, las respuestas posibles y un texto de plantilla que siempre pasa el filtro de
 * cifras. El modelo redacta después sobre estos mismos hechos (writer.ts).
 */
import type { AskTopic, Decision, GateEvaluation, Question, QuestionFact, StatementExtraction, TransactionRef } from '@gow/contracts'
import { buildLedger, LOAN_CONFIDENCE_TO_TRUST, type LedgerRow } from '@gow/decision'
import { pesos, spanishDate } from './figures.ts'

/** Abonos que se preguntan cuando el motor pide aclarar la clasificación sin señalar movimientos. */
const FALLBACK_DEPOSITS = 5

export const DEPOSIT_OPTIONS: Question['options'] = [
  { value: 'customer_payment', label: 'Pago de un cliente o venta' },
  { value: 'loan_disbursement', label: 'Préstamo o crédito' },
  { value: 'own_transfer', label: 'Traspaso desde otra cuenta mía' },
  { value: 'interest', label: 'Intereses o rendimientos' },
  { value: 'other', label: 'Otra cosa' },
]

const TOPIC_ORDER: readonly AskTopic[] = ['deposit_classification', 'identity_fields', 'recent_statement', 'additional_months', 'reconciliation_gap', 'missing_pages']

function gateFor(decision: Decision, topic: AskTopic): GateEvaluation | null {
  return decision.evaluation.gates.find((g) => g.ask === topic && g.outcome !== 'pass') ?? null
}

function txRows(statements: readonly StatementExtraction[], refs: readonly TransactionRef[]) {
  const out: { ref: TransactionRef; date: string; amount: number; description: string }[] = []
  for (const ref of refs) {
    const s = statements.find((x) => x.document.sha256 === ref.document_sha256)
    const t = s?.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions)).find((x) => x.id === ref.transaction_id)
    if (t) out.push({ ref, date: t.date, amount: t.amount, description: t.reference ? `${t.description} ${t.reference}` : t.description })
  }
  return out
}

function uncertainCredits(statements: readonly StatementExtraction[], decision: Decision): TransactionRef[] {
  const min = decision.profile.parameters.min_classification_confidence
  const ledger = buildLedger(statements, { request: decision.profile.inputs.request, minConfidence: min })
  const uncertain = (r: LedgerRow) =>
    r.type === 'credit' && !r.internal && r.verified && (r.classification.confidence < min || (r.classification.category === 'loan_disbursement' && r.classification.confidence < LOAN_CONFIDENCE_TO_TRUST))
  return ledger.rows
    .filter(uncertain)
    .sort((a, b) => b.amount - a.amount || a.day - b.day)
    .slice(0, FALLBACK_DEPOSITS)
    .map((r) => r.ref)
}

function depositQuestion(id: string, row: { ref: TransactionRef; date: string; amount: number; description: string }): Question {
  const facts: QuestionFact[] = [
    { name: 'fecha', value: row.date },
    { name: 'monto', value: row.amount },
    { name: 'concepto', value: row.description },
  ]
  return {
    id,
    topic: 'deposit_classification',
    kind: 'deposit',
    transaction: row.ref,
    facts,
    options: DEPOSIT_OPTIONS,
    text: `Tu estado de cuenta muestra un abono de ${pesos(row.amount)} el ${spanishDate(row.date)} con el concepto "${row.description}". ¿Qué fue? Puede ser pago de un cliente o venta, préstamo o crédito, traspaso desde otra cuenta tuya, intereses u otra cosa.`,
    text_source: 'template',
  }
}

function latestStatementDate(decision: Decision): string | null {
  const age = decision.profile.features.document_age_days.value
  if (typeof age !== 'number') return null
  const asOf = new Date(`${decision.profile.computed_at.slice(0, 10)}T00:00:00Z`)
  asOf.setUTCDate(asOf.getUTCDate() - age)
  return asOf.toISOString().slice(0, 10)
}

function otherQuestion(id: string, topic: Exclude<AskTopic, 'deposit_classification'>, decision: Decision): Question {
  const gate = gateFor(decision, topic)
  const base = { id, topic, transaction: null, options: [], text_source: 'template' as const }
  switch (topic) {
    case 'identity_fields':
      return {
        ...base,
        kind: 'identity',
        facts: [],
        text: 'No pudimos confirmar en el estado de cuenta a quién pertenece la cuenta: el titular, el RFC o la CLABE vienen ocultos, incompletos o no coinciden. Confírmanos la razón social o el nombre del titular, el RFC y la CLABE de la cuenta.',
      }
    case 'recent_statement': {
      const latest = latestStatementDate(decision)
      const age = decision.profile.features.document_age_days.value
      const max = typeof gate?.threshold === 'number' ? gate.threshold : null
      const facts: QuestionFact[] = [
        { name: 'fecha_de_corte_mas_reciente', value: latest },
        { name: 'dias_desde_el_corte', value: typeof age === 'number' ? age : null },
        { name: 'dias_maximos', value: max },
      ]
      const when = latest && typeof age === 'number' ? `tiene corte al ${spanishDate(latest)}, hace ${String(age)} días` : 'no muestra una fecha de corte reciente'
      const need = max !== null ? `con corte de los últimos ${String(max)} días` : 'reciente'
      return { ...base, kind: 'documents', facts, text: `El estado de cuenta más reciente que recibimos ${when}. Para evaluarte necesitamos uno ${need}. ¿Nos lo puedes enviar?` }
    }
    case 'additional_months': {
      const months = decision.profile.features.months_of_history.value
      const need = typeof gate?.threshold === 'number' ? gate.threshold : null
      const facts: QuestionFact[] = [
        { name: 'meses_recibidos', value: typeof months === 'number' ? months : null },
        { name: 'meses_requeridos', value: need },
      ]
      const have = typeof months === 'number' ? `${String(months)} ${months === 1 ? 'mes' : 'meses'} de estados de cuenta` : 'pocos meses de estados de cuenta'
      const want = need !== null ? `Con ${String(need)} meses` : 'Con más meses'
      return { ...base, kind: 'documents', facts, text: `Recibimos ${have}. ${want} podemos evaluar mejor tu flujo. ¿Nos envías los estados de cuenta de los meses anteriores?` }
    }
    case 'reconciliation_gap':
      return { ...base, kind: 'documents', facts: [], text: 'Los saldos del estado de cuenta no cuadran con sus movimientos. ¿Nos envías el documento completo, tal como lo descargas de tu banco?' }
    case 'missing_pages':
      return { ...base, kind: 'documents', facts: [], text: 'Al estado de cuenta parecen faltarle páginas. ¿Nos envías el documento completo, tal como lo descargas de tu banco?' }
  }
}

/** Preguntas para un veredicto `needs_clarification`. Vacío si no hay nada concreto que preguntar. */
export function buildQuestions(decision: Decision, statements: readonly StatementExtraction[]): Question[] {
  const c = decision.clarification
  if (decision.status !== 'needs_clarification' || c === null) return []
  const out: Question[] = []
  const next = () => `q${String(out.length + 1)}`
  for (const topic of TOPIC_ORDER) {
    if (!c.topics.includes(topic)) continue
    if (topic === 'deposit_classification') {
      const refs = c.transactions.length > 0 ? c.transactions : uncertainCredits(statements, decision)
      for (const row of txRows(statements, refs)) out.push(depositQuestion(next(), row))
    } else {
      out.push(otherQuestion(next(), topic, decision))
    }
  }
  return out
}
