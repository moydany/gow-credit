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
import { Decision, emptyExternalSnapshot, type ExternalSnapshot, type StatementExtraction } from '@gow/contracts'
import { applyOwnerAnswers, decide, maxLine, RULES_VERSION, transactionsForModel, withContradictions, withModelLabels } from '@gow/decision'
import { classifyTransactionRows, type Limiter, type TransactionClassifier } from '@gow/llm'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { ClarificationChannel } from './channels.ts'
import { buildQuestions } from './questions.ts'
import { AppInput, AppState, AskResume, AskSuspend } from './state.ts'
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

function humanReview(decision: Decision, code: string, message: string): Decision {
  return Decision.parse({ ...decision, status: 'human_review', limit: null, clarification: null, reasons: [...decision.reasons, { code, message, features: [] }] })
}

async function runDecision(deps: WorkflowDeps, state: AppState): Promise<AppState> {
  if (state.failure_reason !== null) return state
  const { input } = state
  const external = deps.external ? await deps.external(state) : emptyExternalSnapshot()
  const base = decide({
    policy: input.policy,
    policyId: input.policy_id,
    statements: state.statements,
    request: input.request,
    supplier: state.supplier,
    external,
    computedAt: `${input.as_of}T12:00:00.000Z`,
    clarificationRoundsUsed: state.rounds,
  }).decision
  let decision = withContradictions(base, state.contradictions)
  let questions = decision.status === 'needs_clarification' ? buildQuestions(decision, state.statements) : []
  if (decision.status === 'needs_clarification' && questions.length === 0) {
    decision = humanReview(decision, 'no_concrete_question', 'El motor pide aclaración pero no hay una pregunta concreta que hacerle al dueño: pasa a revisión humana.')
    questions = []
  }
  // Mientras no se redacte, cada next_step lleva la plantilla (siempre pasa el filtro de cifras).
  decision = { ...decision, next_steps: decision.next_steps.map((s) => ({ ...s, message: s.message ?? nextStepTemplate(s) })) }
  const max_line = input.request?.amount == null ? maxLine(input.policy, decision.profile) : null
  return { ...state, decision, questions, max_line }
}

export function createProcessApplication(deps: WorkflowDeps) {
  const extract = createStep({
    id: 'extract',
    inputSchema: AppInput,
    outputSchema: AppState,
    execute: async ({ inputData }) => {
      const s = await deps.extract(inputData.pdf_path)
      let failure: string | null = null
      if (s.extraction.status === 'failed') failure = `la extracción falló: ${s.extraction.failure_reason ?? 'sin detalle'}`
      else if (s.classification.document_type !== 'bank_statement' || s.flags.includes('not_a_bank_statement')) failure = `el documento no es un estado de cuenta bancario (${s.classification.document_type})`
      return {
        input: inputData,
        statements: [s],
        documents: [documentOf(s, 'submitted')],
        supplier: inputData.supplier,
        classification: null,
        decision: null,
        max_line: null,
        questions: [],
        asked: [],
        answers: [],
        rejected_answers: [],
        contradictions: [],
        rounds: 0,
        failure_reason: failure,
        calls: extractionCalls(s),
        notes: [],
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
      const r = applyOwnerAnswers({ statements: state.statements, supplier: state.supplier, request: state.input.request, questions: state.questions, answers: state.answers })
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
      if (d === null || d.next_steps.length === 0) return state
      const r = await deps.writer.nextSteps(d.next_steps.map((s) => ({ ...s, message: null })))
      return {
        ...state,
        decision: { ...d, next_steps: r.next_steps },
        calls: [...state.calls, ...r.calls],
        notes: r.errors.length ? [...state.notes, `el redactor de next_steps falló; se usaron plantillas: ${r.errors.join('; ')}`] : state.notes,
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
