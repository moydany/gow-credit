/**
 * Workflow `processApplication` (docs/02 §3) en modo standalone:
 *
 *   extract → classifyTransactions → decide → dountil(clarificationLoop) → explain → finalize
 *   clarificationLoop = askOwner (suspende) → applyAnswers → reDecide
 *
 * Mastra guarda el snapshot en cada paso; una solicitud suspendida en `askOwner` se reanuda en otra
 * invocación del CLI con `run.resume()` (spike 4). Lo determinístico vive en `@gow/decision`; aquí
 * solo se orquesta y se llama a los modelos (Jev o Haiku para movimientos, Haiku para redactar).
 * Las dependencias entran por la fábrica para que los tests usen dobles sin red.
 */
import { resolve } from 'node:path'
import { Decision, emptyExternalSnapshot, extractionFailure, multipleStatementsFailure, NO_DECLARATIONS, notBankStatementReason, type ExternalSnapshot, type HolderType, type Question, type StatementExtraction } from '@gow/contracts'
import { applyOwnerAnswers, decide, maxLine, RULES_VERSION, transactionsForModel, withContradictions, withModelLabels } from '@gow/decision'
import { classifyTransactionRows, type Limiter, type TransactionClassifier } from '@gow/llm'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { ClarificationChannel } from './channels.ts'
import { pesos } from './figures.ts'
import { buildQuestions } from './questions.ts'
import { AppInput, AppState, AskResume, AskSuspend } from './state.ts'
import { explanationDraft } from './explanation.ts'
import { nextStepTemplate, type CallRecord, type Writer } from './writer.ts'

export const WORKFLOW_ID = 'process-application'

export interface WorkflowDeps {
  /** Extrae un PDF; nunca lanza (una falla vuelve como extracción `failed`). */
  extract(path: string): Promise<StatementExtraction>
  /** null: sin modelo para movimientos (solo reglas). */
  transactionClassifier: TransactionClassifier | null
  writer: Writer
  channel: ClarificationChannel
  limit: Limiter
  /** Fuentes externas; en standalone no hay (perfil sin crédito vigente, buró ni SAT). */
  external?: (state: AppState) => Promise<ExternalSnapshot>
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error').slice(0, 300) : String(err)
}

function extractionCalls(s: StatementExtraction): CallRecord[] {
  return s.extraction.calls.map((c) => ({ purpose: `extraction.${c.purpose}`, model: c.model, cost_usd: c.cost_usd, cache_hit: c.response_cache_hit }))
}

/**
 * Aviso de que se analizó un documento que el clasificador (o el extractor) no llamó estado de cuenta
 * (ADR 0042, cambios). La clasificación queda tal cual en la extracción. Sin datos del documento.
 */
function classificationNotes(s: StatementExtraction): string[] {
  const { document_type: type, confidence } = s.classification
  if (type !== 'bank_statement') return [`El clasificador marcó el documento como ${type} con confianza ${confidence.toFixed(2)}; se analizó igual`]
  if (s.flags.includes('not_a_bank_statement')) return ['El extractor marcó el documento como posible no estado de cuenta (bandera not_a_bank_statement); se analizó igual']
  return []
}

function documentOf(s: StatementExtraction, origin: 'submitted' | 'owner_answer'): AppState['documents'][number] {
  return { file_name: s.document.file_name, sha256: s.document.sha256, extraction_status: s.extraction.status, origin }
}

/** Movimientos con Jev o Haiku encima de las reglas; si el modelo falla, quedan las reglas. */
async function classifyStatements(deps: WorkflowDeps, state: AppState, statements: StatementExtraction[]): Promise<{ statements: StatementExtraction[]; summary: NonNullable<AppState['classification']>; calls: CallRecord[] }> {
  const request = state.input.request
  const c = deps.transactionClassifier
  const total = statements.reduce((n, s) => n + s.accounts.reduce((m, a) => m + a.periods.reduce((k, p) => k + p.transactions.length, 0), 0), 0)
  const prev = state.classification
  const summary: NonNullable<AppState['classification']> = {
    implementation: c?.implementation ?? 'rules',
    model: c?.model ?? null,
    fallback: c?.fallback ?? false,
    rules_version: RULES_VERSION,
    transactions: (prev?.transactions ?? 0) + total,
    sent_to_model: prev?.sent_to_model ?? 0,
    classified_by_model: prev?.classified_by_model ?? 0,
    error: prev?.error ?? null,
  }
  if (c === null) return { statements, summary, calls: [] }
  const out: StatementExtraction[] = []
  const calls: CallRecord[] = []
  for (const s of statements) {
    const candidates = transactionsForModel(s, request)
    summary.sent_to_model += candidates.length
    if (candidates.length === 0) {
      out.push(s)
      continue
    }
    try {
      const rows = candidates.map((x) => ({ id: x.tx.id, date: x.tx.date, type: x.tx.type, amount: x.tx.amount, description: x.tx.description, reference: x.tx.reference }))
      const res = await classifyTransactionRows(c, rows, { bank: s.bank_name.value ?? s.classification.bank, limit: deps.limit })
      calls.push(...res.batches.map((b) => ({ purpose: 'classify_transactions', model: b.model, cost_usd: b.costUsd, cache_hit: b.responseCacheHit })))
      const labels = res.labels.map((l) => ({ transaction_id: l.id, category: l.category, confidence: l.confidence }))
      summary.classified_by_model += labels.length
      out.push(withModelLabels(s, request, labels, { model: c.model, calibrated: c.calibrated }))
    } catch (err) {
      summary.implementation = 'rules'
      summary.model = null
      summary.error = `el clasificador de movimientos falló; quedan las reglas: ${errorText(err)}`
      out.push(s)
    }
  }
  return { statements: out, summary, calls }
}

const FINAL: ReadonlySet<string> = new Set(['qualified', 'qualified_with_limit', 'not_qualified'])

/**
 * Tipo de titular del primer estado de cuenta, para la explicación (ADR 0045). Si no se leyó, el RFC
 * lo dice: 13 caracteres es persona física y 12, moral (ADR 0050).
 */
export function holderTypeOf(state: Pick<AppState, 'statements'>): HolderType | null {
  const holder = state.statements[0]?.holder
  if (!holder) return null
  if (holder.holder_type.value !== null) return holder.holder_type.value
  const rfc = holder.rfc.value?.replace(/[\s-]/g, '') ?? ''
  return rfc.length === 13 ? 'individual' : rfc.length === 12 ? 'legal_entity' : null
}

/**
 * Qué se pregunta, sin el texto ni el id (que se repiten entre rondas): el tema y, si cita un
 * movimiento, cuál. Una segunda ronda no repite lo que ya se preguntó (ADR 0051).
 */
export function questionKey(q: Pick<Question, 'topic' | 'transaction'>): string {
  return q.transaction ? `${q.topic}:${q.transaction.document_sha256}#${q.transaction.transaction_id}` : q.topic
}

/** Un run suspendido antes de ADR 0051 no trae `asked_keys`: el default del esquema lo deja vacío. */
function askedKeys(state: AppState): string[] {
  return AppState.shape.asked_keys.parse(state.asked_keys)
}

function humanReview(decision: Decision, code: string, message: string): Decision {
  return Decision.parse({ ...decision, status: 'human_review', limit: null, clarification: null, reasons: [...decision.reasons, { code, message, features: [] }] })
}

/**
 * El veredicto de un estado, puro y sin modelos: perfil + motor, contradicciones de las respuestas,
 * preguntas concretas y `next_steps` con plantilla. Lo usan el workflow y la reevaluación tras una
 * corrección del analista (ADR 0020), que no pasa por el workflow.
 */
export function decideState(state: AppState, external: ExternalSnapshot): AppState {
  if (state.failure_reason !== null) return state
  const { input } = state
  const age = input.statement_age ? { statementAge: input.statement_age } : {}
  const run = (request: AppState['input']['request']) =>
    withContradictions(
      decide({
        policy: input.policy,
        policyId: input.policy_id,
        statements: state.statements,
        request,
        supplier: state.supplier,
        declarations: state.declarations,
        external,
        computedAt: `${input.as_of}T12:00:00.000Z`,
        clarificationRoundsUsed: state.rounds,
        ...age,
      }).decision,
      state.contradictions,
    )
  let decision = run(input.request)
  // Sin monto solicitado, la capacidad no tiene contra qué medirse y el veredicto saldría peor de lo
  // que es (ADR 0045): un veredicto final se decide con la línea máxima, el mayor monto que la
  // política aprueba; si no hay ninguno, se dice así.
  const noAmount = input.request?.amount == null
  const lineAtStart = noAmount ? maxLine(input.policy, decision.profile, age) : null
  if (noAmount && FINAL.has(decision.status)) {
    if (lineAtStart !== null) {
      const atLine = run({ amount: lineAtStart.amount, maturity: input.request?.maturity ?? null, buyer: input.request?.buyer ?? null })
      decision = Decision.parse({ ...atLine, reasons: [{ code: 'evaluated_at_max_line', message: `Sin monto solicitado: se evaluó con la línea máxima (${pesos(lineAtStart.amount)}), el mayor monto que la política aprueba con este perfil.`, features: ['requested_amount'] }, ...atLine.reasons] })
    } else if (decision.status === 'not_qualified') {
      decision = Decision.parse({ ...decision, reasons: [{ code: 'no_amount_no_line', message: 'Sin monto solicitado: con ningún monto la política aprueba este perfil.', features: ['requested_amount'] }, ...decision.reasons] })
    }
  }
  const built = decision.status === 'needs_clarification' ? buildQuestions(decision, state.statements) : []
  // Lo que ya se preguntó en una ronda anterior no se repite (ADR 0051): si el dueño no supo o su
  // respuesta no alcanzó, preguntar lo mismo no lo cambia.
  const before = new Set(askedKeys(state))
  let questions = built.filter((q) => !before.has(questionKey(q)))
  if (decision.status === 'needs_clarification' && questions.length === 0) {
    decision =
      built.length > 0
        ? humanReview(decision, 'clarification_already_asked', 'Lo que falta aclarar ya se le preguntó al dueño en una ronda anterior: pasa a revisión humana.')
        : humanReview(decision, 'no_concrete_question', 'El motor pide aclaración pero no hay una pregunta concreta que hacerle al dueño: pasa a revisión humana.')
    questions = []
  }
  // Mientras no se redacte, cada next_step lleva la plantilla (siempre pasa el filtro de cifras).
  decision = { ...decision, next_steps: decision.next_steps.map((s) => ({ ...s, message: s.message ?? nextStepTemplate(s) })) }
  const max_line = noAmount ? lineAtStart : null
  // Igual la explicación: la plantilla ya pasa el filtro; el paso `explain` la redacta con Haiku.
  decision = { ...decision, explanation: { text: explanationDraft(decision, max_line, { holderType: holderTypeOf(state) }).template, text_source: 'template' } }
  return { ...state, decision, questions, max_line }
}

async function runDecision(deps: WorkflowDeps, state: AppState): Promise<AppState> {
  if (state.failure_reason !== null) return state
  const external = deps.external ? await deps.external(state) : emptyExternalSnapshot()
  return decideState(state, external)
}

export function createProcessApplication(deps: WorkflowDeps) {
  const extract = createStep({
    id: 'extract',
    inputSchema: AppInput,
    outputSchema: AppState,
    execute: async ({ inputData }) => {
      const s = await deps.extract(inputData.pdf_path)
      // La clasificación solo falla la solicitud cuando la extracción no se hizo: el corte temprano del
      // modo full (ADR 0042) vuelve `failed` con la bandera y falla por no ser estado de cuenta, no por
      // la extracción. Cualquier otra falla es de la extracción (un PDF con contraseña o escaneado e
      // ilegible lo dice, ADR 0049). Una extracción terminada (`complete` o `partial`) sigue con perfil y
      // veredicto aunque el clasificador no la llamara estado de cuenta: solo deja una nota.
      const cutBeforeExtracting = s.extraction.status === 'failed' && s.flags.includes('not_a_bank_statement')
      // Varios estados de cuenta en un PDF se rechazan antes que cualquier otra regla, hayan cortado la
      // extracción (modo full) o no (standalone): hace falta cada estado de cuenta en su archivo.
      const failure = multipleStatementsFailure(s) ?? (cutBeforeExtracting ? notBankStatementReason(s.classification.document_type) : extractionFailure(s))
      return {
        input: inputData,
        statements: [s],
        documents: [documentOf(s, 'submitted')],
        supplier: inputData.supplier,
        declarations: NO_DECLARATIONS,
        classification: null,
        decision: null,
        max_line: null,
        questions: [],
        asked: [],
        answers: [],
        asked_keys: [],
        rejected_answers: [],
        contradictions: [],
        rounds: 0,
        failure_reason: failure,
        calls: extractionCalls(s),
        notes: failure === null ? classificationNotes(s) : [],
      }
    },
  })

  const classify = createStep({
    id: 'classify-transactions',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: async ({ inputData: state }) => {
      if (state.failure_reason !== null) return state
      const r = await classifyStatements(deps, state, state.statements)
      return { ...state, statements: r.statements, classification: r.summary, calls: [...state.calls, ...r.calls], notes: r.summary.error ? [...state.notes, r.summary.error] : state.notes }
    },
  })

  const decideStep = createStep({ id: 'decide', inputSchema: AppState, outputSchema: AppState, execute: ({ inputData }) => runDecision(deps, inputData) })

  const askOwner = createStep({
    id: 'ask-owner',
    inputSchema: AppState,
    outputSchema: AppState,
    suspendSchema: AskSuspend,
    resumeSchema: AskResume,
    execute: async ({ inputData: state, resumeData, suspendData, suspend }) => {
      // `.dountil()` corre el cuerpo al menos una vez (spike 4): sin nada que aclarar no se pregunta.
      if (state.decision?.status !== 'needs_clarification') return state
      if (resumeData) {
        // El estado de la suspensión trae lo que pasó en la primera ejecución (la redacción y su costo).
        const base = suspendData?.state ?? state
        return { ...base, questions: base.asked.length > 0 ? base.asked : base.questions, answers: resumeData.answers }
      }
      const written = await deps.writer.questions(state.questions)
      const round = state.rounds + 1
      await deps.channel.send(state.input.application_id, round, written.questions)
      const next: AppState = {
        ...state,
        questions: written.questions,
        asked: written.questions,
        asked_keys: [...askedKeys(state), ...written.questions.map(questionKey)],
        calls: [...state.calls, ...written.calls],
        notes: written.errors.length ? [...state.notes, `el redactor de preguntas falló; se usaron plantillas: ${written.errors.join('; ')}`] : state.notes,
      }
      return suspend({ application_id: state.input.application_id, round, questions: written.questions, state: next })
    },
  })

  const applyAnswers = createStep({
    id: 'apply-answers',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: async ({ inputData: state }) => {
      if (state.decision?.status !== 'needs_clarification') return state
      const r = applyOwnerAnswers({ statements: state.statements, supplier: state.supplier, request: state.input.request, questions: state.questions, answers: state.answers, declarations: state.declarations })
      let statements = r.statements
      let documents = state.documents
      let calls = state.calls
      let classification = state.classification
      const notes = [...state.notes]
      if (r.documents.length > 0) {
        const extracted: StatementExtraction[] = []
        for (const path of r.documents) {
          const s = await deps.extract(path)
          calls = [...calls, ...extractionCalls(s)]
          documents = [...documents, documentOf(s, 'owner_answer')]
          if (s.extraction.status === 'failed') notes.push(`un documento de la respuesta no se pudo extraer (${s.document.file_name})`)
          else extracted.push(s)
        }
        const c = await classifyStatements(deps, state, extracted)
        statements = [...statements, ...c.statements]
        classification = c.summary
        calls = [...calls, ...c.calls]
      }
      return {
        ...state,
        statements,
        documents,
        supplier: r.supplier,
        declarations: r.declarations,
        classification,
        calls,
        notes,
        rejected_answers: [...state.rejected_answers, ...r.rejected],
        contradictions: [...state.contradictions, ...r.contradictions],
        rounds: state.rounds + 1,
      }
    },
  })

  const reDecide = createStep({
    id: 're-decide',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: ({ inputData }) => (inputData.rounds > 0 && inputData.decision?.status === 'needs_clarification' ? runDecision(deps, inputData) : Promise.resolve(inputData)),
  })

  const clarificationLoop = createWorkflow({ id: 'clarification-loop', description: 'Una ronda de aclaración con el dueño del documento', inputSchema: AppState, outputSchema: AppState })
    .then(askOwner)
    .then(applyAnswers)
    .then(reDecide)
    .commit()

  const explain = createStep({
    id: 'explain',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: async ({ inputData: state }) => {
      const d = state.decision
      if (d === null) return state
      const steps = d.next_steps.length > 0 ? await deps.writer.nextSteps(d.next_steps.map((s) => ({ ...s, message: null }))) : { next_steps: d.next_steps, calls: [], errors: [] }
      // La explicación en prosa (ADR 0045): Haiku sobre los hechos de la decisión, con filtro de cifras.
      const ex = await deps.writer.explanation(explanationDraft(d, state.max_line, { holderType: holderTypeOf(state) }))
      const notes = [...state.notes]
      if (steps.errors.length) notes.push(`el redactor de next_steps falló; se usaron plantillas: ${steps.errors.join('; ')}`)
      if (ex.errors.length) notes.push(`el redactor de la explicación falló; se usó la plantilla: ${ex.errors.join('; ')}`)
      return {
        ...state,
        decision: { ...d, next_steps: steps.next_steps, explanation: { text: ex.text, text_source: ex.source } },
        calls: [...state.calls, ...steps.calls, ...ex.calls],
        notes,
      }
    },
  })

  return (
    createWorkflow({ id: WORKFLOW_ID, inputSchema: AppInput, outputSchema: AppState })
      .then(extract)
      .then(classify)
      .then(decideStep)
      // Tras un sub-workflow la condición recibe `any` (spike 4): cast al esquema conocido.
      .dountil(clarificationLoop, ({ inputData }) => Promise.resolve((inputData as AppState).decision?.status !== 'needs_clarification'))
      .then(explain)
      .commit()
  )
}

/** Resuelve las rutas de respuestas `documents` contra la carpeta del archivo de respuestas. */
export function resolveAnswerPaths(resume: AskResume): AskResume {
  if (resume.base_dir === null) return resume
  const base = resume.base_dir
  return { ...resume, answers: resume.answers.map((a) => (a.kind === 'documents' ? { ...a, paths: a.paths.map((p) => resolve(base, p)) } : a)) }
}
