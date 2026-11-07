/**
 * Recorrido de ejemplo para las pruebas (y para trabajar la pantalla sin API): una solicitud por
 * WhatsApp con datos de factura, extracción de un PDF de 6 páginas (pasada 1, bloques en paralelo,
 * doble lectura), clasificación, decisión ronda 1 que pide aclaración, espera de un día, reanudación,
 * decisión ronda 2, explicación y veredicto. Incluye una decisión de sombra y un aviso. Sin PII.
 */
import type { ApplicationTimeline, TimelineEvent } from '@gow/contracts'

const BASE = Date.parse('2026-11-02T15:00:00.000Z')
const at = (sec: number): string => new Date(BASE + Math.round(sec * 1000)).toISOString()
const DAY = 100_800 // 1 d 4 h de espera al proveedor

/** Capítulos del recorrido de ejemplo. */
const CH = {
  clarification_1: 'c-clarification-1',
  classification: 'c-classification',
  decision_1: 'c-decision-1',
  decision_2: 'c-decision-2',
  explanation: 'c-explanation',
  extraction: 'c-extraction',
  reception: 'c-reception',
  resume: 'c-resume',
  verdict: 'c-verdict',
} as const

type Common = { id: string; lane: TimelineEvent['lane']; start: number; end?: number; precision?: TimelineEvent['precision']; chapter: string; label: string; source?: TimelineEvent['source'] }
const base = (c: Common) => ({
  id: c.id,
  lane: c.lane,
  start: at(c.start),
  end: c.end === undefined ? null : at(c.end),
  precision: c.precision ?? 'exact',
  chapter: c.chapter,
  label: c.label,
  source: c.source ?? null,
})

type CallInput = Omit<Common, 'lane' | 'label'> & {
  label?: string
  purpose: string
  model: string
  prompt?: string
  effort?: string
  pages?: number[]
  doc?: number | null
  cache?: boolean
  error?: string
  cost: number
  tokens?: [number, number]
  exchange?: string | null
}

const callLabel = (c: CallInput): string => c.label ?? `${c.purpose.replace(/_/g, ' ')}${c.cache ? ' (de caché)' : ''}${c.error ? ' (con error)' : ''}`
const callDoc = (c: CallInput): number | null => (c.doc !== undefined ? c.doc : c.pages?.length ? 0 : null)
/** Una llamada de caché no gasta: sin costo, latencia ni tokens. */
const callUsage = (c: CallInput) => {
  const live = !c.cache
  const dur = c.end === undefined ? 0 : Math.round((c.end - c.start) * 1000)
  return { cost_usd: live ? c.cost : 0, latency_ms: live ? dur : 0, input_tokens: live ? (c.tokens?.[0] ?? 0) : 0, output_tokens: live ? (c.tokens?.[1] ?? 0) : 0 }
}

const call = (c: CallInput): TimelineEvent => ({
  ...base({ ...c, lane: 'models', label: callLabel(c) }),
  kind: 'model_call',
  purpose: c.purpose,
  model: c.model,
  prompt: c.prompt ?? null,
  effort: c.effort ?? null,
  pages: c.pages ?? [],
  document_index: callDoc(c),
  cache_hit: c.cache ?? false,
  outcome: c.error ? 'error' : 'ok',
  error_code: c.error ?? null,
  ...callUsage(c),
  exchange_id: c.exchange === undefined ? `ex-${c.id}` : c.exchange,
})

const step = (id: string, chapter: string, s: number, e: number, stepId: Extract<TimelineEvent, { kind: 'workflow_step' }>['step'], round = 0, label?: string): TimelineEvent => ({
  ...base({ id: `step:${id}`, lane: 'workflow', start: s, end: e, chapter, label: label ?? `Paso ${stepId}`, precision: stepId === 'decide' || stepId === 're-decide' ? 'inferred' : 'exact' }),
  kind: 'workflow_step',
  step: stepId,
  round,
})

const GATES_1 = [
  { id: 'min_history_months', outcome: 'pass' as const, effect: 'none' as const },
  { id: 'declared_income_matches', outcome: 'unknown' as const, effect: 'needs_clarification' as const },
  { id: 'no_fraud_flags', outcome: 'pass' as const, effect: 'none' as const },
]
const GATES_2 = [
  { id: 'min_history_months', outcome: 'pass' as const, effect: 'none' as const },
  { id: 'declared_income_matches', outcome: 'pass' as const, effect: 'none' as const },
  { id: 'no_fraud_flags', outcome: 'pass' as const, effect: 'none' as const },
]
const DIMS_1 = [
  { id: 'cash_flow_stability', weight: 0.4, normalized: 0.72, used: true },
  { id: 'balance_buffer', weight: 0.35, normalized: 0.55, used: true },
  { id: 'income_concentration', weight: 0.25, normalized: null, used: false },
]
const DIMS_2 = [
  { id: 'cash_flow_stability', weight: 0.4, normalized: 0.74, used: true },
  { id: 'balance_buffer', weight: 0.35, normalized: 0.58, used: true },
  { id: 'income_concentration', weight: 0.25, normalized: 0.66, used: true },
]

const GEMINI = 'gemini-3.8-flash'
const HAIKU = 'claude-haiku-5-5'
const OPUS = 'claude-opus-5-5'

const events: TimelineEvent[] = [
  // ── Recepción ──
  { ...base({ id: 'applications:app-1', lane: 'queue', start: 0, chapter: CH.reception, label: 'Solicitud creada por WhatsApp', source: { table: 'applications', id: 'app-1' } }), kind: 'application_created', origin: 'whatsapp' },
  { ...base({ id: 'inbound_messages:in-1', lane: 'supplier', start: 1.2, chapter: CH.reception, label: 'El proveedor envía los datos de la factura' }), kind: 'inbound_message', channel: 'whatsapp', resolution: 'intake_amount', has_document: false, media_kind: null, interpreted: false },
  { ...base({ id: 'inbound_messages:in-2', lane: 'supplier', start: 6.4, chapter: CH.reception, label: 'El proveedor envía el estado de cuenta (PDF)' }), kind: 'inbound_message', channel: 'whatsapp', resolution: 'document_received', has_document: true, media_kind: null, interpreted: false },
  { ...base({ id: 'queue:process', lane: 'queue', start: 6.9, end: 8.1, precision: 'derived', chapter: CH.reception, label: 'Espera en la cola (proceso)' }), kind: 'queue_wait', job: 'process' },

  // ── Extracción ──
  step('extract', CH.extraction, 8.1, 52, 'extract', 0, 'Extraer el estado de cuenta'),
  call({ id: 'llm:classify', chapter: CH.extraction, start: 8.4, end: 10.2, purpose: 'classify', model: GEMINI, prompt: 'classify@3', effort: 'low', pages: [1], cost: 0.0009, tokens: [2100, 90] }),
  call({ id: 'llm:summary', chapter: CH.extraction, start: 10.4, end: 16.8, purpose: 'extraction.pass1', model: GEMINI, prompt: 'extraction-summary@7', effort: 'medium', pages: [1, 2, 3, 4, 5, 6], cost: 0.0112, tokens: [18400, 1450] }),
  call({ id: 'llm:tx-a', chapter: CH.extraction, start: 17, end: 29.5, purpose: 'transactions', model: GEMINI, prompt: 'extraction-transactions@9', effort: 'medium', pages: [1, 2, 3], cost: 0.0231, tokens: [9300, 4100] }),
  call({ id: 'llm:tx-b', chapter: CH.extraction, start: 17.05, end: 31.2, purpose: 'transactions', model: GEMINI, prompt: 'extraction-transactions@9', effort: 'medium', pages: [4, 5, 6], cost: 0.0244, tokens: [9300, 4400] }),
  call({ id: 'llm:tx-c', chapter: CH.extraction, start: 17.1, end: 17.1, purpose: 'transactions', model: GEMINI, prompt: 'extraction-transactions@9', effort: 'medium', pages: [2], cache: true, cost: 0 }),
  call({ id: 'llm:retry-5', chapter: CH.extraction, start: 31.4, end: 33.0, purpose: 'retry_page', model: GEMINI, prompt: 'extraction-retry@2', effort: 'high', pages: [5], error: 'schema_invalid', cost: 0.0021, tokens: [3100, 40] }),
  call({ id: 'llm:retry-5b', chapter: CH.extraction, start: 33.2, end: 38.0, purpose: 'retry_page', model: OPUS, prompt: 'extraction-retry@2', effort: 'high', pages: [5], cost: 0.061, tokens: [3300, 1900] }),
  call({ id: 'llm:double', chapter: CH.extraction, start: 38.2, end: 49.5, purpose: 'double_read', model: HAIKU, prompt: 'double-read@4', effort: 'high', pages: [3, 4], cost: 0.0178, tokens: [8800, 2100] }),
  {
    ...base({ id: 'extractions:ex-1', lane: 'workflow', start: 51.5, chapter: CH.extraction, label: 'Verificación de lo leído', source: { table: 'extractions', id: 'ex-1' } }),
    kind: 'verification',
    document_index: 0,
    extraction_status: 'complete',
    verified: 41,
    unverified: 3,
    conflict: 1,
    pages_with_issues: [4],
    flags: ['balance_break'],
  },

  // ── Clasificación ──
  step('classify', CH.classification, 52, 66, 'classify-transactions', 0, 'Clasificar movimientos'),
  call({ id: 'llm:classify-tx', chapter: CH.classification, start: 52.5, end: 64.8, purpose: 'classify_transactions', model: HAIKU, prompt: 'classify-transactions@5', effort: 'low', cost: 0.0094, tokens: [7200, 1600], doc: null }),

  // ── Decisión, ronda 1 ──
  step('decide-1', CH.decision_1, 66, 66.4, 'decide', 0, 'Evaluar con la política'),
  {
    ...base({ id: 'decisions:dec-1', lane: 'engine', start: 66.2, precision: 'inferred', chapter: CH.decision_1, label: 'Decisión: pide una aclaración', source: { table: 'decisions', id: 'dec-1' } }),
    kind: 'decision',
    decision_id: 'dec-1',
    decision_kind: 'active',
    status: 'needs_clarification',
    has_limit: false,
    score: null,
    band_index: null,
    policy_version: 3,
    gates: GATES_1,
    dimensions: DIMS_1,
    asks: ['income_concentration'],
  },
  {
    ...base({ id: 'decisions:dec-1s', lane: 'engine', start: 66.3, precision: 'inferred', chapter: CH.decision_1, label: 'Sombra: política 4 (borrador)', source: { table: 'decisions', id: 'dec-1s' } }),
    kind: 'decision',
    decision_id: 'dec-1s',
    decision_kind: 'shadow',
    status: 'qualified_with_limit',
    has_limit: true,
    score: 61.5,
    band_index: 1,
    policy_version: 4,
    gates: GATES_2,
    dimensions: DIMS_2,
    asks: [],
  },

  // ── Aclaración, ronda 1 ──
  step('ask-1', CH.clarification_1, 66.6, 75, 'ask-owner', 1, 'Preguntar al proveedor'),
  call({ id: 'llm:questions', chapter: CH.clarification_1, start: 66.8, end: 71.2, purpose: 'write_questions', model: OPUS, prompt: 'write-questions@2', effort: 'medium', cost: 0.034, tokens: [2900, 620], doc: null }),
  { ...base({ id: 'clarifications:cl-1', lane: 'workflow', start: 71.5, chapter: CH.clarification_1, label: 'Se abre la aclaración (ronda 1)', source: { table: 'clarifications', id: 'cl-1' } }), kind: 'clarification_opened', clarification_id: 'cl-1', round: 1, channel: 'whatsapp', questions: 1 },
  { ...base({ id: 'outbound_messages:out-1', lane: 'relay', start: 72.6, chapter: CH.clarification_1, label: 'Se envía la pregunta por WhatsApp' }), kind: 'outbound_message', channel: 'whatsapp', message_kind: 'question', delivery: 'sent', attempts: 1 },
  { ...base({ id: 'step:suspended-1', lane: 'workflow', start: 75, end: DAY + 75, precision: 'derived', chapter: CH.clarification_1, label: 'El workflow espera la respuesta' }), kind: 'workflow_suspended', round: 1 },

  // ── Reanudación ──
  { ...base({ id: 'inbound_messages:in-3', lane: 'supplier', start: DAY + 75, chapter: CH.resume, label: 'El proveedor responde' }), kind: 'inbound_message', channel: 'whatsapp', resolution: 'matched', has_document: false, media_kind: null, interpreted: true },
  call({ id: 'llm:interpret', chapter: CH.resume, start: DAY + 75.4, end: DAY + 77.0, purpose: 'interpret_reply', model: HAIKU, prompt: 'interpret-reply@3', effort: 'low', cost: 0.0016, tokens: [900, 120], doc: null }),
  { ...base({ id: 'clarifications:cl-1:answered', lane: 'supplier', start: DAY + 77.4, chapter: CH.resume, label: 'Se contesta la aclaración (ronda 1)', source: { table: 'clarifications', id: 'cl-1' } }), kind: 'clarification_answered', clarification_id: 'cl-1', round: 1, answers: 1 },
  { ...base({ id: 'queue:resume', lane: 'queue', start: DAY + 77.5, end: DAY + 79, precision: 'derived', chapter: CH.resume, label: 'Espera en la cola (reanudar)' }), kind: 'queue_wait', job: 'resume' },
  step('apply', CH.resume, DAY + 79, DAY + 79.6, 'apply-answers', 1, 'Aplicar la respuesta'),

  // ── Decisión, ronda 2 ──
  step('redecide', CH.decision_2, DAY + 79.6, DAY + 80, 're-decide', 1, 'Reevaluar'),
  {
    ...base({ id: 'decisions:dec-2', lane: 'engine', start: DAY + 79.8, precision: 'inferred', chapter: CH.decision_2, label: 'Decisión: califica con línea', source: { table: 'decisions', id: 'dec-2' } }),
    kind: 'decision',
    decision_id: 'dec-2',
    decision_kind: 'active',
    status: 'qualified_with_limit',
    has_limit: true,
    score: 63.2,
    band_index: 1,
    policy_version: 3,
    gates: GATES_2,
    dimensions: DIMS_2,
    asks: [],
  },

  // ── Explicación ──
  step('explain', CH.explanation, DAY + 80, DAY + 85, 'explain', 1, 'Explicar la decisión'),
  call({ id: 'llm:explain', chapter: CH.explanation, start: DAY + 80.2, end: DAY + 84.6, purpose: 'explain', model: OPUS, prompt: 'explain@4', effort: 'medium', cost: 0.041, tokens: [3600, 880], doc: null, exchange: null }),

  // ── Veredicto ──
  step('finalize', CH.verdict, DAY + 85, DAY + 85.4, 'finalize', 1, 'Cerrar la solicitud'),
  { ...base({ id: 'outbound_messages:out-2', lane: 'relay', start: DAY + 86, chapter: CH.verdict, label: 'Se envía el veredicto por WhatsApp' }), kind: 'outbound_message', channel: 'whatsapp', message_kind: 'verdict', delivery: 'sent', attempts: 1 },
  { ...base({ id: 'audit_log:verdict-1', lane: 'relay', start: DAY + 86.6, chapter: CH.verdict, label: 'Veredicto en cola de envío' }), kind: 'verdict_queued', application_status: 'qualified_with_limit' },
  { ...base({ id: 'queue:finished', lane: 'queue', start: DAY + 87, chapter: CH.verdict, label: 'Termina el trabajo' }), kind: 'job_finished', job: 'resume', application_status: 'qualified_with_limit' },
]

const sorted = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
const END = Math.max(...sorted.map((e) => Date.parse(e.end ?? e.start))) - BASE
const calls = sorted.filter((e): e is Extract<TimelineEvent, { kind: 'model_call' }> => e.kind === 'model_call')

const chapter = (id: string, kind: ApplicationTimeline['chapters'][number]['kind'], title: string, round: number, s: number, e: number) => ({ id, kind, title, round, start: at(s), end: at(e) })

export const fixtureTimeline: ApplicationTimeline = {
  application_id: 'app-1',
  status: 'qualified_with_limit',
  created_at: at(0),
  start: at(0),
  end: at(END / 1000),
  documents: [
    {
      document_id: 'doc-1',
      origin: 'submitted',
      page_count: 6,
      route: 'text_and_vision',
      extraction_status: 'complete',
      pages: [
        { page: 1, transactions: 9, issues: 0, verification: 'verified' },
        { page: 2, transactions: 11, issues: 0, verification: 'verified' },
        { page: 3, transactions: 10, issues: 0, verification: 'unverified' },
        { page: 4, transactions: 8, issues: 1, verification: 'conflict' },
        { page: 5, transactions: 7, issues: 0, verification: 'verified' },
        { page: 6, transactions: 0, issues: 0, verification: 'none' },
      ],
    },
  ],
  events: sorted,
  chapters: [
    chapter(CH.reception, 'reception', 'Recepción', 0, 0, 8.1),
    chapter(CH.extraction, 'extraction', 'Extracción', 0, 8.1, 52),
    chapter(CH.classification, 'classification', 'Clasificación', 0, 52, 66),
    chapter(CH.decision_1, 'decision', 'Decisión · ronda 1', 1, 66, 66.6),
    chapter(CH.clarification_1, 'clarification', 'Aclaración · ronda 1', 1, 66.6, 75),
    chapter(CH.resume, 'resume', 'Reanudación · ronda 1', 1, DAY + 75, DAY + 79.6),
    chapter(CH.decision_2, 'decision', 'Decisión · ronda 2', 2, DAY + 79.6, DAY + 80),
    chapter(CH.explanation, 'explanation', 'Explicación', 2, DAY + 80, DAY + 85),
    chapter(CH.verdict, 'verdict', 'Veredicto', 2, DAY + 85, DAY + 87),
  ],
  gaps: [{ start: at(75), end: at(DAY + 75), reason: 'waiting_supplier' }],
  totals: {
    duration_ms: Math.round(END),
    active_ms: Math.round(END - DAY * 1000),
    model_calls: calls.length,
    cache_hits: calls.filter((c) => c.cache_hit).length,
    cost_usd: Number(calls.reduce((a, c) => a + c.cost_usd, 0).toFixed(4)),
  },
  limitations: ['Los pasos de decisión no guardan su hora: se colocaron entre el paso anterior y el siguiente.'],
}
