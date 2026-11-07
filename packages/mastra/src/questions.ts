/**
 * Preguntas al dueño a partir del veredicto (docs/03 §7). El motor dice qué temas preguntar;
 * aquí se arma una pregunta por tema (una por abono en `deposit_classification` y una por cargo en
 * `charge_classification`) con los hechos que puede citar, las respuestas posibles y un texto de
 * plantilla que siempre pasa el filtro de cifras. El modelo redacta después sobre estos mismos
 * hechos (writer.ts).
 */
import type { AskTopic, Decision, GateEvaluation, Question, QuestionFact, StatementExtraction, TransactionRef } from '@gow/contracts'
import { buildLedger, CHARGE_DEBT_CONFIDENCE_TO_TRUST, LOAN_CONFIDENCE_TO_TRUST, type LedgerRow } from '@gow/decision'
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

/** Cargos dudosos (ADR 0050). "Gasto personal" se guarda como `other`; ver `CHARGE_CATEGORY`. */
export const CHARGE_OPTIONS: Question['options'] = [
  { value: 'loan_payment', label: 'Pago de un crédito o préstamo' },
  { value: 'supplier_payment', label: 'Pago a un proveedor o gasto del negocio' },
  { value: 'own_transfer', label: 'Traspaso a otra cuenta mía' },
  { value: 'personal_expense', label: 'Gasto personal' },
  { value: 'other', label: 'Otra cosa' },
]

/** Uso de la cuenta de una persona física (ADR 0050). */
export const ACCOUNT_USE_OPTIONS: Question['options'] = [
  { value: 'business_only', label: 'Solo para mi negocio' },
  { value: 'mixed', label: 'Para mi negocio y también gastos personales' },
]

/** Primero lo que se contesta por chat (movimientos, cliente, uso de la cuenta); después datos y documentos. */
const TOPIC_ORDER: readonly AskTopic[] = [
  'deposit_classification',
  'charge_classification',
  'main_buyer',
  'account_use',
  'identity_fields',
  'recent_statement',
  'additional_months',
  'reconciliation_gap',
  'missing_pages',
]

function gateFor(decision: Decision, topic: AskTopic): GateEvaluation | null {
  return decision.evaluation.gates.find((g) => g.ask === topic && g.outcome !== 'pass') ?? null
}

type TxRow = { ref: TransactionRef; type: 'credit' | 'debit'; date: string; amount: number; description: string }

function txRows(statements: readonly StatementExtraction[], refs: readonly TransactionRef[]): TxRow[] {
  const out: TxRow[] = []
  for (const ref of refs) {
    const s = statements.find((x) => x.document.sha256 === ref.document_sha256)
    const t = s?.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions)).find((x) => x.id === ref.transaction_id)
    if (t) out.push({ ref, type: t.type, date: t.date, amount: t.amount, description: t.reference ? `${t.description} ${t.reference}` : t.description })
  }
  return out
}

/** Movimientos dudosos de un sentido, de mayor a menor, cuando el motor pide el tema sin señalarlos. */
function uncertainRows(statements: readonly StatementExtraction[], decision: Decision, type: 'credit' | 'debit'): TransactionRef[] {
  const min = decision.profile.parameters.min_classification_confidence
  const ledger = buildLedger(statements, { request: decision.profile.inputs.request, minConfidence: min, accountUse: decision.profile.inputs.declarations.account_use })
  const uncertain = (r: LedgerRow) => {
    if (r.type !== type || r.internal || !r.verified) return false
    const c = r.classification
    if (type === 'credit') return c.confidence < min || (c.category === 'loan_disbursement' && c.confidence < LOAN_CONFIDENCE_TO_TRUST)
    return c.confidence < (c.category === 'loan_payment' || c.category === 'interest' ? CHARGE_DEBT_CONFIDENCE_TO_TRUST : min)
  }
  return ledger.rows
    .filter(uncertain)
    .sort((a, b) => b.amount - a.amount || a.day - b.day)
    .slice(0, FALLBACK_DEPOSITS)
    .map((r) => r.ref)
}

function depositQuestion(id: string, row: TxRow): Question {
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

function chargeQuestion(id: string, row: TxRow): Question {
  const facts: QuestionFact[] = [
    { name: 'fecha', value: row.date },
    { name: 'monto', value: row.amount },
    { name: 'concepto', value: row.description },
  ]
  return {
    id,
    topic: 'charge_classification',
    kind: 'charge',
    transaction: row.ref,
    facts,
    options: CHARGE_OPTIONS,
    text: `Tu estado de cuenta muestra un cargo de ${pesos(row.amount)} el ${spanishDate(row.date)} con el concepto "${row.description}". ¿Qué fue? Puede ser pago de un crédito o préstamo, pago a un proveedor o gasto del negocio, traspaso a otra cuenta tuya, gasto personal u otra cosa.`,
    text_source: 'template',
  }
}

/** Texto libre: el nombre se busca en los abonos del estado de cuenta (ADR 0050). */
function buyerQuestion(id: string): Question {
  return {
    id,
    topic: 'main_buyer',
    kind: 'buyer',
    transaction: null,
    facts: [],
    options: [],
    text: '¿Quién es tu cliente principal, la empresa que te paga las facturas que quieres adelantar? Escribe su nombre como aparece en tus depósitos, o "no sé".',
    text_source: 'template',
  }
}

function accountUseQuestion(id: string): Question {
  return {
    id,
    topic: 'account_use',
    kind: 'account_use',
    transaction: null,
    facts: [],
    options: ACCOUNT_USE_OPTIONS,
    text: '¿Usas esta cuenta solo para tu negocio o también para gastos personales?',
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

/** La identidad se verifica con nombre y RFC; la CLABE no se pregunta (ADR 0044). */
type IdentityField = 'name' | 'rfc'
const IDENTITY_FIELDS: readonly IdentityField[] = ['name', 'rfc']
const FIELD_LABEL: Record<IdentityField, string> = { name: 'el nombre del titular', rfc: 'el RFC' }

function listEs(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`
}

/**
 * Pregunta de identidad que dice qué coincidió, qué no y qué no se pudo comparar, y pide solo lo que
 * falta (ADR 0043). La evidencia del cotejo viene como `<doc>:<campo>=<resultado>`. Sin evidencia
 * (no hay proveedor registrado contra el cual comparar), la pregunta pide nombre y RFC.
 */
export function identityQuestion(base: Omit<Question, 'kind' | 'facts' | 'text'>, decision: Decision): Question {
  const evidence = decision.profile.features.identity_match.evidence
  const results = new Map<IdentityField, Set<string>>()
  for (const e of evidence) {
    const m = /:(?:.*\.)?(name|rfc)=(\w+)$/.exec(e)
    if (!m?.[1] || !m[2]) continue
    const field = m[1] as IdentityField
    results.set(field, (results.get(field) ?? new Set()).add(m[2]))
  }
  if (results.size === 0) {
    return {
      ...base,
      kind: 'identity',
      facts: [{ name: 'pedir', value: 'name,rfc' }],
      text: 'No tenemos datos registrados para confirmar a quién pertenece la cuenta de tu estado de cuenta. ¿Nos confirmas la razón social o el nombre del titular y el RFC?',
    }
  }
  const matched = IDENTITY_FIELDS.filter((f) => results.get(f)?.has('match') || results.get(f)?.has('root'))
  const mismatched = IDENTITY_FIELDS.filter((f) => results.get(f)?.has('mismatch'))
  const unchecked = IDENTITY_FIELDS.filter((f) => !results.has(f) || (!matched.includes(f) && !mismatched.includes(f)))
  const ask = IDENTITY_FIELDS.filter((f) => !matched.includes(f) || mismatched.includes(f))
  const parts: string[] = []
  if (matched.length) parts.push(`${listEs(matched.map((f) => FIELD_LABEL[f]))} ${matched.length === 1 ? 'coincide' : 'coinciden'} con tus datos registrados`)
  if (mismatched.length) parts.push(`${listEs(mismatched.map((f) => FIELD_LABEL[f]))} no ${mismatched.length === 1 ? 'coincide' : 'coinciden'}`)
  if (unchecked.length) parts.push(`${listEs(unchecked.map((f) => FIELD_LABEL[f]))} no ${unchecked.length === 1 ? 'se pudo' : 'se pudieron'} comparar (en el estado de cuenta ${unchecked.length === 1 ? 'viene oculto o incompleto' : 'vienen ocultos o incompletos'}, o no lo tenemos registrado)`)
  const head = `Revisamos a quién pertenece la cuenta de tu estado de cuenta: ${parts.join('; ')}.`
  const want = ask.length ? ` ¿Nos confirmas ${listEs(ask.map((f) => FIELD_LABEL[f]))} del titular de la cuenta?` : ''
  return {
    ...base,
    kind: 'identity',
    facts: [
      { name: 'coinciden', value: matched.join(',') || null },
      { name: 'no_coinciden', value: mismatched.join(',') || null },
      { name: 'sin_comparar', value: unchecked.join(',') || null },
      { name: 'pedir', value: ask.join(',') || null },
    ],
    text: head + want,
  }
}

function otherQuestion(id: string, topic: Exclude<AskTopic, 'deposit_classification' | 'charge_classification'>, decision: Decision): Question {
  const gate = gateFor(decision, topic)
  const base = { id, topic, transaction: null, options: [], text_source: 'template' as const }
  switch (topic) {
    case 'main_buyer':
      return buyerQuestion(id)
    case 'account_use':
      return accountUseQuestion(id)
    case 'identity_fields':
      return identityQuestion(base, decision)
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
  const signaled = txRows(statements, c.transactions)
  for (const topic of TOPIC_ORDER) {
    if (!c.topics.includes(topic)) continue
    if (topic === 'deposit_classification' || topic === 'charge_classification') {
      const type = topic === 'deposit_classification' ? 'credit' : 'debit'
      const mine = signaled.filter((r) => r.type === type)
      const rows = mine.length > 0 ? mine : txRows(statements, uncertainRows(statements, decision, type))
      for (const row of rows) out.push(type === 'credit' ? depositQuestion(next(), row) : chargeQuestion(next(), row))
    } else {
      out.push(otherQuestion(next(), topic, decision))
    }
  }
  return out
}
