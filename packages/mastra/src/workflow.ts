/**
 * `processApplication` workflow in standalone mode:
 *
 *   extract → classifyTransactions → decide → dountil(clarificationLoop) → explain → finalize
 *   clarificationLoop = askOwner (suspends) → applyAnswers → reDecide
 *
 * Mastra snapshots every step; a request suspended in `askOwner` resumes in another CLI
 * invocation with `run.resume()`. Deterministic logic lives in `@gow/decision`; here we only
 * orchestrate and call the models (Jev or Haiku for transactions, Haiku for writing).
 * Dependencies enter through the factory so tests use doubles with no network.
 */
import { resolve } from 'node:path'
import { Decision, emptyExternalSnapshot, extractionFailure, NO_DECLARATIONS, notBankStatementReason, type ExternalSnapshot, type HolderType, type Question, type StatementExtraction } from '@gow/contracts'
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
/** The nested clarification loop: it keeps its own state under the same run id. */
export const CLARIFICATION_LOOP_ID = 'clarification-loop'

export interface WorkflowDeps {
  /** Extracts a PDF; never throws (a failure comes back as a `failed` extraction). */
  extract(path: string): Promise<StatementExtraction>
  /** null: no model for transactions (rules only). */
  transactionClassifier: TransactionClassifier | null
  writer: Writer
  channel: ClarificationChannel
  limit: Limiter
  /** External sources; none in standalone (no live credit, bureau or SAT in the profile). */
  external?: (state: AppState) => Promise<ExternalSnapshot>
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error').slice(0, 300) : String(err)
}

function extractionCalls(s: StatementExtraction): CallRecord[] {
  return s.extraction.calls.map((c) => ({ purpose: `extraction.${c.purpose}`, model: c.model, cost_usd: c.cost_usd, cache_hit: c.response_cache_hit }))
}

/**
 * Notice that a document was analyzed that the classifier (or extractor) did not call a bank
 * statement. The classification stays as is in the extraction. Carries no document data.
 */
function classificationNotes(s: StatementExtraction): string[] {
  const { document_type: type, confidence } = s.classification
  if (type !== 'bank_statement') return [`El clasificador marcó el documento como ${type} con confianza ${confidence.toFixed(2)}; se analizó igual`]
  if (s.flags.includes('not_a_bank_statement')) return ['El extractor marcó el documento como posible no estado de cuenta (bandera not_a_bank_statement); se analizó igual']
  return []
}

/** Does any answer in this round bring a document for that topic's question? */
function answeredWithDocument(state: AppState, topic: Question['topic']): boolean {
  return state.answers.some((a) => a.kind === 'documents' && state.questions.some((q) => q.id === a.question_id && q.topic === topic))
}

const answeredMissingPages = (state: AppState): boolean => answeredWithDocument(state, 'missing_pages')

const hasAddress = (s: StatementExtraction): boolean => (s.holder.address.value ?? '').trim().length > 0

/** Days the statement's periods cover, as `[start, end]` intervals (ISO, comparable as text). */
function coveredRanges(s: StatementExtraction): [string, string][] {
  const out: [string, string][] = []
  for (const p of s.accounts.flatMap((a) => a.periods)) if (p.period_start.value && p.period_end.value) out.push([p.period_start.value, p.period_end.value])
  return out
}

/**
 * What remains of earlier statements when an answer brings new PDFs:
 * - The complete PDF answering `missing_pages` replaces the incomplete one: if both stayed, the
 *   profile would see the old one's missing pages and the repeated period, and ask again.
 * - The one with an address answering `statement_with_address` replaces those covering the same
 *   days without it; one from another month stays. Keeping both would count the period twice.
 */
function withoutReplaced(state: AppState, statements: StatementExtraction[], incoming: readonly StatementExtraction[], notes: string[]): StatementExtraction[] {
  if (incoming.length === 0) return statements
  let kept = statements
  if (answeredMissingPages(state)) {
    const replaced = kept.filter((s) => s.flags.includes('pages_missing'))
    kept = kept.filter((s) => !s.flags.includes('pages_missing'))
    if (replaced.length > 0) notes.push(`${String(replaced.length)} documento(s) con páginas faltantes se reemplazaron por el PDF completo de la respuesta`)
  }
  if (answeredWithDocument(state, 'statement_with_address')) {
    const replaced = new Set(replacedByAddress(kept, incoming))
    kept = kept.filter((s) => !replaced.has(s))
    if (replaced.size > 0) notes.push(`${String(replaced.size)} documento(s) sin domicilio se reemplazaron por el estado de cuenta con domicilio del mismo periodo`)
  }
  return kept
}

export function replacedByAddress(statements: readonly StatementExtraction[], incoming: readonly StatementExtraction[]): StatementExtraction[] {
  const ranges = incoming.filter(hasAddress).flatMap(coveredRanges)
  return statements.filter((s) => !hasAddress(s) && coveredRanges(s).some(([a, b]) => ranges.some(([c, d]) => a <= d && c <= b)))
}

function documentOf(s: StatementExtraction, origin: 'submitted' | 'owner_answer'): AppState['documents'][number] {
  return { file_name: s.document.file_name, sha256: s.document.sha256, extraction_status: s.extraction.status, origin }
}

async function classifySingleStatement(
  s: StatementExtraction,
  request: AppState['input']['request'],
  c: NonNullable<WorkflowDeps['transactionClassifier']>,
  limit: WorkflowDeps['limit'],
  summary: NonNullable<AppState['classification']>,
  calls: CallRecord[],
): Promise<StatementExtraction> {
  const candidates = transactionsForModel(s, request)
  summary.sent_to_model += candidates.length
  if (candidates.length === 0) return s
  try {
    const rows = candidates.map((x) => ({ id: x.tx.id, date: x.tx.date, type: x.tx.type, amount: x.tx.amount, description: x.tx.description, reference: x.tx.reference }))
    const res = await classifyTransactionRows(c, rows, { bank: s.bank_name.value ?? s.classification.bank, limit })
    calls.push(...res.batches.map((b) => ({ purpose: 'classify_transactions', model: b.model, cost_usd: b.costUsd, cache_hit: b.responseCacheHit })))
    const labels = res.labels.map((l) => ({ transaction_id: l.id, category: l.category, confidence: l.confidence }))
    summary.classified_by_model += labels.length
    return withModelLabels(s, request, labels, { model: c.model, calibrated: c.calibrated })
  } catch (err) {
    summary.implementation = 'rules'
    summary.model = null
    summary.error = `el clasificador de movimientos falló; quedan las reglas: ${errorText(err)}`
    return s
  }
}

function initClassificationSummary(
  c: WorkflowDeps['transactionClassifier'],
  prev: AppState['classification'],
  total: number,
): NonNullable<AppState['classification']> {
  return {
    implementation: c ? c.implementation : 'rules',
    model: c ? c.model : null,
    fallback: c ? c.fallback : false,
    rules_version: RULES_VERSION,
    transactions: (prev ? prev.transactions : 0) + total,
    sent_to_model: prev ? prev.sent_to_model : 0,
    classified_by_model: prev ? prev.classified_by_model : 0,
    error: prev ? prev.error : null,
  }
}

/** Transactions with Jev or Haiku on top of the rules; if the model fails, the rules remain. */
async function classifyStatements(deps: WorkflowDeps, state: AppState, statements: StatementExtraction[]): Promise<{ statements: StatementExtraction[]; summary: NonNullable<AppState['classification']>; calls: CallRecord[] }> {
  const c = deps.transactionClassifier
  const total = statements.reduce((n, s) => n + s.accounts.reduce((m, a) => m + a.periods.reduce((k, p) => k + p.transactions.length, 0), 0), 0)
  const summary = initClassificationSummary(c, state.classification, total)
  if (c === null) return { statements, summary, calls: [] }
  const out: StatementExtraction[] = []
  const calls: CallRecord[] = []
  for (const s of statements) {
    out.push(await classifySingleStatement(s, state.input.request, c, deps.limit, summary, calls))
  }
  return { statements: out, summary, calls }
}

const FINAL: ReadonlySet<string> = new Set(['qualified', 'qualified_with_limit', 'not_qualified'])

/**
 * Holder type of the first statement, for the explanation. If not read, the RFC tells: 13
 * characters is an individual and 12 a company.
 */
export function holderTypeOf(state: Pick<AppState, 'statements'>): HolderType | null {
  const holder = state.statements[0]?.holder
  if (!holder) return null
  if (holder.holder_type.value !== null) return holder.holder_type.value
  const rfc = holder.rfc.value?.replace(/[\s-]/g, '') ?? ''
  return rfc.length === 13 ? 'individual' : rfc.length === 12 ? 'legal_entity' : null
}

/**
 * What is asked, without the text or id (which repeat across rounds): the topic and, if it cites
 * a transaction, which one. A second round does not repeat what was already asked.
 */
export function questionKey(q: Pick<Question, 'topic' | 'transaction'> & { facts?: Question['facts'] }): string {
  if (q.transaction) return `${q.topic}:${q.transaction.document_sha256}#${q.transaction.transaction_id}`
  // The missing months are asked again only if the answer brought months: the key carries
  // how many there were.
  if (q.topic === 'additional_months') return `${q.topic}:${String(q.facts?.find((f) => f.name === 'meses_recibidos')?.value ?? '')}`
  return q.topic
}

/** A run suspended before `asked_keys` existed has none: the schema default leaves it empty. */
function askedKeys(state: AppState): string[] {
  return AppState.shape.asked_keys.parse(state.asked_keys)
}

function humanReview(decision: Decision, code: string, message: string): Decision {
  return Decision.parse({ ...decision, status: 'human_review', limit: null, clarification: null, reasons: [...decision.reasons, { code, message, features: [] }] })
}

function adjustDecisionForMaxLine(
  decision: Decision,
  input: AppState['input'],
  lineAtStart: ReturnType<typeof maxLine> | null,
  run: (request: AppState['input']['request'], askMainBuyer?: boolean) => Decision,
): Decision {
  if (lineAtStart !== null) {
    const atLine = run({ amount: lineAtStart.amount, maturity: input.request?.maturity ?? null, buyer: input.request?.buyer ?? null }, input.request !== null)
    return Decision.parse({ ...atLine, reasons: [{ code: 'evaluated_at_max_line', message: `Sin monto solicitado: se evaluó con la línea máxima (${pesos(lineAtStart.amount)}), el mayor monto que la política aprueba con este perfil.`, features: ['requested_amount'] }, ...atLine.reasons] })
  }
  if (decision.status === 'not_qualified') {
    return Decision.parse({ ...decision, reasons: [{ code: 'no_amount_no_line', message: 'Sin monto solicitado: con ningún monto la política aprueba este perfil.', features: ['requested_amount'] }, ...decision.reasons] })
  }
  return decision
}

function resolveDecisionQuestions(
  decision: Decision,
  state: AppState,
): { decision: Decision; questions: Question[] } {
  const built = decision.status === 'needs_clarification' ? buildQuestions(decision, state.statements) : []
  const before = new Set(askedKeys(state))
  const questions = built.filter((q) => !before.has(questionKey(q)))
  if (decision.status === 'needs_clarification' && questions.length === 0) {
    const code = built.length > 0 ? 'clarification_already_asked' : 'no_concrete_question'
    const msg = built.length > 0
      ? 'Lo que falta aclarar ya se le preguntó al dueño en una ronda anterior: pasa a revisión humana.'
      : 'El motor pide aclaración pero no hay una pregunta concreta que hacerle al dueño: pasa a revisión humana.'
    return { decision: humanReview(decision, code, msg), questions: [] }
  }
  return { decision, questions }
}

/**
 * A statement's verdict, pure and model-free: profile + engine, contradictions in the answers,
 * concrete questions and `next_steps` from a template. Used by the workflow and by re-evaluation
 * after an analyst correction, which does not go through the workflow.
 */
export function decideState(state: AppState, external: ExternalSnapshot): AppState {
  if (state.failure_reason !== null) return state
  const { input } = state
  const age = input.statement_age ? { statementAge: input.statement_age } : {}
  const run = (request: AppState['input']['request'], askMainBuyer = true) =>
    withContradictions(
      decide({
        policy: input.policy,
        policyId: input.policy_id,
        statements: state.statements,
        request,
        askMainBuyer,
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
  const noAmount = input.request?.amount == null
  const lineAtStart = noAmount ? maxLine(input.policy, decision.profile, age) : null
  if (noAmount && FINAL.has(decision.status)) {
    decision = adjustDecisionForMaxLine(decision, input, lineAtStart, run)
  }
  const resolved = resolveDecisionQuestions(decision, state)
  decision = resolved.decision
  const questions = resolved.questions
  decision = { ...decision, next_steps: decision.next_steps.map((s) => ({ ...s, message: s.message ?? nextStepTemplate(s) })) }
  const max_line = noAmount ? lineAtStart : null
  decision = { ...decision, explanation: { text: explanationDraft(decision, max_line, { holderType: holderTypeOf(state) }).template, text_source: 'template' } }
  return { ...state, decision, questions, max_line }
}

async function runDecision(deps: WorkflowDeps, state: AppState): Promise<AppState> {
  if (state.failure_reason !== null) return state
  const external = deps.external ? await deps.external(state) : emptyExternalSnapshot()
  return decideState(state, external)
}

function buildExtractStep(deps: WorkflowDeps) {
  return createStep({
    id: 'extract',
    inputSchema: AppInput,
    outputSchema: AppState,
    execute: async ({ inputData }) => {
      const all: StatementExtraction[] = []
      for (const path of [inputData.pdf_path, ...(inputData.extra_pdf_paths ?? [])]) all.push(await deps.extract(path))
      const [s, ...extras] = all
      if (!s) throw new Error('la solicitud no trae documento')
      const cutBeforeExtracting = s.extraction.status === 'failed' && s.flags.includes('not_a_bank_statement')
      const first = cutBeforeExtracting ? notBankStatementReason(s.classification.document_type) : extractionFailure(s)
      const usable = all.filter((x) => x.extraction.status !== 'failed')
      const failure = usable.length > 0 && extras.length > 0 ? null : first
      const skipped = extras.length > 0 && failure === null ? all.filter((x) => x.extraction.status === 'failed').map((x) => `el documento ${x.document.file_name} no se pudo usar (${x.extraction.failure_reason ?? 'sin detalle'}); se analizan los demás`) : []
      return {
        input: inputData,
        statements: extras.length > 0 ? usable : [s],
        documents: all.map((x) => documentOf(x, 'submitted')),
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
        calls: all.flatMap(extractionCalls),
        notes: failure === null ? [...skipped, ...usable.flatMap(classificationNotes)] : [],
      }
    },
  })
}

function buildClassifyStep(deps: WorkflowDeps) {
  return createStep({
    id: 'classify-transactions',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: async ({ inputData: state }) => {
      if (state.failure_reason !== null) return state
      const r = await classifyStatements(deps, state, state.statements)
      return { ...state, statements: r.statements, classification: r.summary, calls: [...state.calls, ...r.calls], notes: r.summary.error ? [...state.notes, r.summary.error] : state.notes }
    },
  })
}

function buildAskOwnerStep(deps: WorkflowDeps) {
  return createStep({
    id: 'ask-owner',
    inputSchema: AppState,
    outputSchema: AppState,
    suspendSchema: AskSuspend,
    resumeSchema: AskResume,
    execute: async ({ inputData: state, resumeData, suspendData, suspend }) => {
      if (state.decision?.status !== 'needs_clarification') return state
      if (resumeData) {
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
}

function buildApplyAnswersStep(deps: WorkflowDeps) {
  return createStep({
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
        statements = [...withoutReplaced(state, statements, c.statements, notes), ...c.statements]
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
}

function buildExplainStep(deps: WorkflowDeps) {
  return createStep({
    id: 'explain',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: async ({ inputData: state }) => {
      const d = state.decision
      if (d === null) return state
      const steps = d.next_steps.length > 0 ? await deps.writer.nextSteps(d.next_steps.map((s) => ({ ...s, message: null }))) : { next_steps: d.next_steps, calls: [], errors: [] }
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
}

export function createProcessApplication(deps: WorkflowDeps) {
  const extract = buildExtractStep(deps)
  const classify = buildClassifyStep(deps)
  const decideStep = createStep({ id: 'decide', inputSchema: AppState, outputSchema: AppState, execute: ({ inputData }) => runDecision(deps, inputData) })
  const askOwner = buildAskOwnerStep(deps)
  const applyAnswers = buildApplyAnswersStep(deps)
  const reDecide = createStep({
    id: 're-decide',
    inputSchema: AppState,
    outputSchema: AppState,
    execute: ({ inputData }) => (inputData.rounds > 0 && inputData.decision?.status === 'needs_clarification' ? runDecision(deps, inputData) : Promise.resolve(inputData)),
  })

  const clarificationLoop = createWorkflow({ id: CLARIFICATION_LOOP_ID, description: 'Una ronda de aclaración con el dueño del documento', inputSchema: AppState, outputSchema: AppState })
    .then(askOwner)
    .then(applyAnswers)
    .then(reDecide)
    .commit()

  const explain = buildExplainStep(deps)

  return (
    createWorkflow({ id: WORKFLOW_ID, inputSchema: AppInput, outputSchema: AppState })
      .then(extract)
      .then(classify)
      .then(decideStep)
      // After a sub-workflow the condition receives `any`: cast to the known schema.
      .dountil(clarificationLoop, ({ inputData }) => Promise.resolve((inputData as AppState).decision?.status !== 'needs_clarification'))
      .then(explain)
      .commit()
  )
}

/** Resolves `documents` answer paths against the answers file's folder. */
export function resolveAnswerPaths(resume: AskResume): AskResume {
  if (resume.base_dir === null) return resume
  const base = resume.base_dir
  return { ...resume, answers: resume.answers.map((a) => (a.kind === 'documents' ? { ...a, paths: a.paths.map((p) => resolve(base, p)) } : a)) }
}
