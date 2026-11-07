/**
 * Filas sintéticas para probar `buildTimeline` (ADR 0067) sin base de datos. Todo es inventado:
 * ningún dato sale de `data/`. Los montos, el RFC y el nombre del titular que trae el estado de
 * cuenta de ejemplo están en `FIXTURE_SECRETS` para que las pruebas comprueben que no se filtran.
 *
 * Cinco recorridos:
 * - `whatsapp`: WhatsApp con datos de la factura, una ronda de aclaración (contestada al día
 *   siguiente), reanudación y veredicto `qualified_with_limit`.
 * - `api`: llegada por la API, sin aclaración, con todos los intercambios grabados.
 * - `legacy`: extracción anterior a ADR 0064: sin filas de intercambio.
 * - `failed`: falla por no ser estado de cuenta.
 * - `offer`: el proveedor acepta la oferta del monto y la solicitud se reevalúa.
 */
import type { ApplicationStatus } from '../enums.ts'
import type { StatementExtraction } from '../statement.ts'
import type {
  TimelineAuditRow,
  TimelineClarificationRow,
  TimelineDecisionRow,
  TimelineExchangeRow,
  TimelineInboundRow,
  TimelineOutboundRow,
  TimelineSources,
} from '../timeline-sources.ts'
import { sampleStatement } from './fixtures.ts'

export type TimelineSampleKind = 'whatsapp' | 'api' | 'legacy' | 'failed' | 'offer'

export const TIMELINE_SAMPLE_KINDS: readonly TimelineSampleKind[] = ['whatsapp', 'api', 'legacy', 'failed', 'offer']

/** Lo que jamás debe aparecer en un texto del recorrido. */
export const FIXTURE_SECRETS = ['XAXX010101000', 'COMERCIALIZADORA', '5000', '1250.5', '90000', '521555', 'REFORMA', 'BANCO FICTICIO'] as const

/** Instante de partida de los recorridos de ejemplo. */
export const T0 = Date.parse('2026-11-05T15:00:00.000Z')
export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const DAY = 24 * 60 * MINUTE

/** `T0 + offset` como Date. */
export const at = (offsetMs: number): Date => new Date(T0 + offsetMs)

const HAIKU = 'claude-haiku-5-5'
const FROM_WHATSAPP = 'inbound:whatsapp'
const APP_RECEIVED = 'application.received'
const JOB_SUCCESS = 'application.success'
const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const TENANT_SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)

// ---------------------------------------------------------------- piezas

export interface CallSpec {
  purpose: string
  model?: string
  pages?: number[]
  latencyMs: number
  cacheHit?: boolean
  costUsd?: number
}

/** Extracción de ejemplo con las llamadas dadas (en el orden en que terminaron). */
export function extractionPayload(opts: { sha?: string; startMs: number; finishMs: number; calls: CallSpec[]; status?: 'complete' | 'partial' | 'failed'; failed?: boolean }): StatementExtraction {
  const s = sampleStatement()
  s.document.sha256 = opts.sha ?? TENANT_SHA
  const conflicted = s.accounts[0]?.periods[1]?.transactions[0]
  if (conflicted) conflicted.verification = 'conflict'
  s.issues = [{ id: 'i1', code: 'running_balance_break', severity: 'warning', message: 'El saldo de una fila no cuadra.', page: 2, path: null, account_id: null, period_id: null, transaction_id: null, details: {} }]
  s.extraction.started_at = at(opts.startMs).toISOString()
  s.extraction.finished_at = at(opts.finishMs).toISOString()
  s.extraction.duration_ms = opts.finishMs - opts.startMs
  s.extraction.status = opts.status ?? 'complete'
  s.extraction.calls = opts.calls.map((c) => ({
    purpose: c.purpose,
    model: c.model ?? 'gemini-3.8-flash',
    prompt: `extract_${c.purpose}.v1`,
    effort: 'low' as const,
    pages: c.pages ?? [],
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    cost_usd: c.costUsd ?? 0.01,
    latency_ms: c.latencyMs,
    response_cache_hit: c.cacheHit ?? false,
  }))
  if (opts.failed) {
    s.flags = ['not_a_bank_statement']
    s.accounts = []
    s.issues = []
    s.classification = { document_type: 'credit_card_statement', confidence: 0.97, bank: null }
    s.extraction.failure_reason = 'no es un estado de cuenta bancario (credit_card_statement); no se extrajo'
  }
  return s
}

/** Llamada grabada del modelo: `createdAt` es el inicio (así lo guarda el worker, ver `EXCHANGE_CREATED_AT_MARKS`). */
export function exchange(id: string, o: { startMs: number; purpose: string; latencyMs: number; sha?: string | null; model?: string; application?: boolean; inboundId?: string; cacheHit?: boolean; outcome?: 'ok' | 'error'; costUsd?: number }): TimelineExchangeRow {
  return {
    id,
    applicationId: o.application === false ? null : APP_ID,
    inboundMessageId: o.inboundId ?? null,
    purpose: o.purpose,
    model: o.model ?? 'gemini-3.8-flash',
    promptVersion: `${o.purpose}.v1`,
    effort: 'low',
    documentSha256: o.sha ?? null,
    outcome: o.outcome ?? 'ok',
    errorCode: o.outcome === 'error' ? 'invalid_output' : null,
    responseCacheHit: o.cacheHit ?? false,
    usage: o.outcome === 'error' ? null : { input_tokens: 1200, output_tokens: 300 },
    costUsd: o.costUsd ?? 0.01,
    latencyMs: o.latencyMs,
    createdAt: at(o.startMs),
  }
}

let auditSeq = 0
export function auditRow(o: { id?: string; actor: string; action: string; subject?: string | null; details?: Record<string, unknown>; atMs: number }): TimelineAuditRow {
  auditSeq += 1
  return { id: o.id ?? `audit-${String(auditSeq).padStart(3, '0')}`, actor: o.actor, action: o.action, subject: o.subject === undefined ? APP_ID : o.subject, details: o.details ?? {}, at: at(o.atMs) }
}

export function inbound(id: string, o: { receivedMs: number; resolution: string; processedMs?: number; clarificationId?: string | null; hasDocument?: boolean; channel?: 'whatsapp' | 'email' | 'manual'; mediaKind?: string | null }): TimelineInboundRow {
  return {
    id,
    channel: o.channel ?? 'whatsapp',
    receivedAt: at(o.receivedMs),
    processedAt: at(o.processedMs ?? o.receivedMs + 2 * SECOND),
    resolution: o.resolution,
    clarificationId: o.clarificationId ?? null,
    hasDocument: o.hasDocument ?? false,
    mediaKind: o.mediaKind ?? null,
  }
}

export function outbound(id: string, o: { createdMs: number; kind: string; clarificationId?: string | null; sentMs?: number | null; status?: 'pending' | 'sent' | 'failed' }): TimelineOutboundRow {
  const sentMs = o.sentMs === undefined ? o.createdMs + SECOND : o.sentMs
  return { id, channel: 'whatsapp', kind: o.kind, status: o.status ?? (sentMs === null ? 'pending' : 'sent'), attempts: sentMs === null ? 0 : 1, clarificationId: o.clarificationId ?? null, createdAt: at(o.createdMs), sentAt: sentMs === null ? null : at(sentMs) }
}

export function clarification(id: string, o: { round: number; createdMs: number; answeredMs?: number | null; questions?: number; answers?: number }): TimelineClarificationRow {
  const answered = o.answeredMs ?? null
  return { id, round: o.round, status: answered === null ? 'open' : 'answered', channel: 'whatsapp', step: 'questions', questions: o.questions ?? 2, answers: answered === null ? 0 : (o.answers ?? 2), createdAt: at(o.createdMs), answeredAt: answered === null ? null : at(answered) }
}

/** Decisión guardada tal como la deja el motor (recortada a lo que importa), con montos que no deben salir. */
export function decisionRow(id: string, o: { status: string; kind?: 'active' | 'shadow'; atMs: number; asks?: string[]; limit?: number | null; policyVersion?: number | null }): TimelineDecisionRow {
  const qualifies = o.status === 'qualified' || o.status === 'qualified_with_limit'
  return {
    id,
    kind: o.kind ?? 'active',
    status: o.status,
    policyVersion: o.policyVersion === undefined ? 3 : o.policyVersion,
    createdAt: at(o.atMs),
    payload: {
      status: o.status,
      limit: o.limit === undefined ? (qualifies ? 90000 : null) : o.limit,
      score: qualifies ? 62.5 : 31,
      band: qualifies ? { index: 1, min: 50, status: o.status } : null,
      policy: { id: 'gow-base', version: 3 },
      evaluation: {
        gates: [
          { id: 'no_arrears', feature: 'existing_exposure_days_past_due', op: '<=', threshold: 0, value: 0, outcome: 'pass', effect: 'none', ask: null },
          { id: 'recent_statement', feature: 'statement_age_months', op: '<=', threshold: 3, value: 1, outcome: o.asks ? 'unknown' : 'pass', effect: o.asks ? 'needs_clarification' : 'none', ask: null },
        ],
        dimensions: [{ id: 'capacity', feature: 'operating_income_monthly', relative_to: null, value: 360000, normalized: 0.6, weight: 35, points: 21, used: true, excluded_reason: null }],
        caps: [],
        limit: null,
      },
      clarification: o.asks ? { topics: o.asks, issue_ids: [], transactions: [] } : null,
      decided_at: '2026-11-04T12:00:00.000Z',
    },
  }
}

function application(status: ApplicationStatus, createdMs: number, updatedMs: number): TimelineSources['application'] {
  return { id: APP_ID, status, createdAt: at(createdMs), updatedAt: at(updatedMs), failureReason: status === 'failed' ? 'no es un estado de cuenta bancario (credit_card_statement); no se extrajo' : null }
}

function empty(app: TimelineSources['application']): TimelineSources {
  return { application: app, documents: [], inbound: [], outbound: [], audit: [], exchanges: [], decisions: [], clarifications: [], corrections: [], outcomes: [] }
}

/** Llamadas de la extracción del documento, en el orden en que terminaron (summary, classify, 2 bloques). */
const EXTRACTION_CALLS: CallSpec[] = [
  { purpose: 'classify', latencyMs: 2000 },
  { purpose: 'summary', latencyMs: 8000 },
  { purpose: 'transactions', pages: [1, 2], latencyMs: 15000 },
  { purpose: 'transactions', pages: [3], latencyMs: 18000 },
]

/** Los intercambios de esas llamadas (las dos de movimientos empiezan a la vez). */
function extractionExchanges(prefix: string, startMs: number, sha: string): TimelineExchangeRow[] {
  return [
    exchange(`${prefix}-classify`, { startMs, purpose: 'classify', latencyMs: 2000, sha }),
    exchange(`${prefix}-summary`, { startMs: startMs + 2000, purpose: 'summary', latencyMs: 8000, sha }),
    exchange(`${prefix}-tx-b`, { startMs: startMs + 10000, purpose: 'transactions', latencyMs: 18000, sha }),
    exchange(`${prefix}-tx-a`, { startMs: startMs + 10000, purpose: 'transactions', latencyMs: 15000, sha }),
  ]
}

// ---------------------------------------------------------------- (a) WhatsApp con aclaración

export function whatsappSources(): TimelineSources {
  const s = empty(application('qualified_with_limit', 2 * SECOND, DAY + 45 * SECOND))
  const resumeStart = DAY + 3 * SECOND + 150 * SECOND
  const end2 = resumeStart + 14 * SECOND
  s.documents = [{ documentId: 'doc-1', origin: 'submitted', createdAt: at(2 * SECOND), sha256: TENANT_SHA, extraction: { id: 'ext-1', createdAt: at(139 * SECOND), payload: extractionPayload({ startMs: 100 * SECOND, finishMs: 130 * SECOND, calls: EXTRACTION_CALLS }) } }]
  s.inbound = [
    inbound('in-1', { receivedMs: 0, resolution: 'document_received', hasDocument: true }),
    inbound('in-2', { receivedMs: 45 * SECOND, resolution: 'intake_step' }),
    inbound('in-3', { receivedMs: 85 * SECOND, resolution: 'intake_completed' }),
    inbound('in-4', { receivedMs: DAY, resolution: 'completed', clarificationId: 'cl-1' }),
  ]
  s.outbound = [
    outbound('out-1', { createdMs: 2 * SECOND, kind: 'invoice' }),
    outbound('out-2', { createdMs: 47 * SECOND, kind: 'invoice' }),
    outbound('out-3', { createdMs: 87 * SECOND, kind: 'invoice' }),
    outbound('out-4', { createdMs: 138 * SECOND, kind: 'question', clarificationId: 'cl-1' }),
    outbound('out-5', { createdMs: end2, kind: 'verdict', sentMs: end2 + 2 * SECOND }),
  ]
  s.clarifications = [clarification('cl-1', { round: 1, createdMs: 138 * SECOND, answeredMs: DAY + 3 * SECOND })]
  s.exchanges = [
    exchange('x-interpret', { startMs: 45 * SECOND, purpose: 'interpret_reply', latencyMs: 800, application: false, inboundId: 'in-2', model: HAIKU }),
    ...extractionExchanges('x-ext', 100 * SECOND, TENANT_SHA),
    exchange('x-classify-tx', { startMs: 130 * SECOND, purpose: 'classify_transactions', latencyMs: 3000, model: HAIKU }),
    exchange('x-questions', { startMs: 134 * SECOND, purpose: 'clarification_questions', latencyMs: 3000, model: HAIKU }),
    exchange('x-next-steps', { startMs: resumeStart, purpose: 'next_steps', latencyMs: 4000, model: HAIKU }),
    exchange('x-explanation', { startMs: resumeStart + 5 * SECOND, purpose: 'explanation', latencyMs: 3500, model: HAIKU }),
  ]
  s.audit = [
    auditRow({ id: 'au-in-1', actor: FROM_WHATSAPP, action: 'inbound.document_received', subject: 'in-1', details: { clarification_id: null, application_id: APP_ID }, atMs: 2 * SECOND }),
    auditRow({ id: 'au-recv', actor: FROM_WHATSAPP, action: APP_RECEIVED, subject: APP_ID, details: { inbound_message_id: 'in-1' }, atMs: 2 * SECOND }),
    auditRow({ id: 'au-in-2', actor: FROM_WHATSAPP, action: 'inbound.intake_step', subject: 'in-2', details: { clarification_id: null, interpreted: 'haiku' }, atMs: 47 * SECOND }),
    auditRow({ id: 'au-in-3', actor: FROM_WHATSAPP, action: 'inbound.intake_completed', subject: 'in-3', details: { clarification_id: null, application_id: APP_ID }, atMs: 87 * SECOND }),
    auditRow({ id: 'au-job-1', actor: 'worker', action: 'application.suspended', details: { status: 'needs_clarification' }, atMs: 138500 }),
    auditRow({ id: 'au-in-4', actor: FROM_WHATSAPP, action: 'inbound.completed', subject: 'in-4', details: { clarification_id: 'cl-1' }, atMs: DAY + 3 * SECOND }),
    auditRow({ id: 'au-job-2', actor: 'worker', action: JOB_SUCCESS, details: { status: 'qualified_with_limit' }, atMs: end2 }),
    auditRow({ id: 'au-verdict', actor: 'worker', action: 'verdict.queued', details: { status: 'qualified_with_limit', channel: 'whatsapp' }, atMs: end2 }),
    auditRow({ id: 'au-view', actor: 'user:u-1', action: 'application.viewed', details: {}, atMs: end2 + 20 * MINUTE }),
  ]
  s.decisions = [
    decisionRow('dec-1', { status: 'needs_clarification', atMs: 138500, asks: ['deposit_classification'], limit: null }),
    decisionRow('dec-2', { status: 'qualified_with_limit', atMs: end2 }),
    decisionRow('dec-2s', { status: 'qualified', kind: 'shadow', atMs: end2, policyVersion: 4 }),
  ]
  return s
}

// ---------------------------------------------------------------- (b) API sin aclaración

export function apiSources(): TimelineSources {
  const s = empty(application('qualified', 0, 80 * SECOND))
  s.documents = [{ documentId: 'doc-1', origin: 'submitted', createdAt: at(0), sha256: TENANT_SHA, extraction: { id: 'ext-1', createdAt: at(80 * SECOND), payload: extractionPayload({ startMs: 5 * SECOND, finishMs: 35 * SECOND, calls: EXTRACTION_CALLS }) } }]
  s.exchanges = [
    ...extractionExchanges('x-ext', 5 * SECOND, TENANT_SHA),
    exchange('x-classify-tx', { startMs: 35 * SECOND, purpose: 'classify_transactions', latencyMs: 3000, model: HAIKU }),
    exchange('x-next-steps', { startMs: 39 * SECOND, purpose: 'next_steps', latencyMs: 4000, model: HAIKU, cacheHit: true, costUsd: 0 }),
    exchange('x-explanation', { startMs: 44 * SECOND, purpose: 'explanation', latencyMs: 3500, model: HAIKU }),
  ]
  s.audit = [
    auditRow({ id: 'au-recv', actor: 'apikey:k1', action: APP_RECEIVED, subject: APP_ID, atMs: 0 }),
    auditRow({ id: 'au-job-1', actor: 'worker', action: JOB_SUCCESS, details: { status: 'qualified' }, atMs: 80 * SECOND }),
  ]
  s.decisions = [decisionRow('dec-1', { status: 'qualified', atMs: 80 * SECOND })]
  return s
}

// ---------------------------------------------------------------- (c) anterior a ADR 0064

export function legacySources(): TimelineSources {
  const s = empty(application('qualified', 0, 70 * SECOND))
  const calls: CallSpec[] = [...EXTRACTION_CALLS, { purpose: 'retry_page', pages: [2], latencyMs: 6000, model: 'claude-opus-5-5' }]
  s.documents = [{ documentId: 'doc-1', origin: 'submitted', createdAt: at(0), sha256: TENANT_SHA, extraction: { id: 'ext-1', createdAt: at(70 * SECOND), payload: extractionPayload({ startMs: 4 * SECOND, finishMs: 50 * SECOND, calls }) } }]
  s.audit = [
    auditRow({ id: 'au-recv', actor: 'apikey:k1', action: APP_RECEIVED, subject: APP_ID, atMs: 0 }),
    auditRow({ id: 'au-job-1', actor: 'worker', action: JOB_SUCCESS, details: { status: 'qualified' }, atMs: 70 * SECOND }),
  ]
  s.decisions = [decisionRow('dec-1', { status: 'qualified', atMs: 70 * SECOND })]
  return s
}

// ---------------------------------------------------------------- (d) falla: no es estado de cuenta

export function failedSources(): TimelineSources {
  const s = empty(application('failed', 0, 12 * SECOND))
  s.documents = [{ documentId: 'doc-1', origin: 'submitted', createdAt: at(0), sha256: OTHER_SHA, extraction: { id: 'ext-1', createdAt: at(12 * SECOND), payload: extractionPayload({ sha: OTHER_SHA, startMs: 3 * SECOND, finishMs: 8 * SECOND, calls: [{ purpose: 'classify', latencyMs: 4000 }], status: 'failed', failed: true }) } }]
  s.exchanges = [exchange('x-classify', { startMs: 3 * SECOND, purpose: 'classify', latencyMs: 4000, sha: OTHER_SHA })]
  s.audit = [
    auditRow({ id: 'au-recv', actor: 'apikey:k1', action: APP_RECEIVED, subject: APP_ID, atMs: 0 }),
    auditRow({ id: 'au-job-1', actor: 'worker', action: JOB_SUCCESS, details: { status: 'failed' }, atMs: 12 * SECOND }),
  ]
  return s
}

// ---------------------------------------------------------------- (e) oferta aceptada → reevaluación

export function offerSources(): TimelineSources {
  const offerAt = 10 * MINUTE
  const redecideEnd = offerAt + 4 * SECOND
  const s = empty(application('qualified', 2 * SECOND, redecideEnd))
  s.documents = [{ documentId: 'doc-1', origin: 'submitted', createdAt: at(2 * SECOND), sha256: TENANT_SHA, extraction: { id: 'ext-1', createdAt: at(60 * SECOND), payload: extractionPayload({ startMs: 8 * SECOND, finishMs: 38 * SECOND, calls: EXTRACTION_CALLS }) } }]
  s.inbound = [inbound('in-1', { receivedMs: 0, resolution: 'document_received', hasDocument: true }), inbound('in-2', { receivedMs: offerAt, resolution: 'offer_accepted' })]
  s.outbound = [outbound('out-1', { createdMs: 2 * SECOND, kind: 'generic' }), outbound('out-2', { createdMs: 60 * SECOND, kind: 'verdict' }), outbound('out-3', { createdMs: redecideEnd, kind: 'verdict' })]
  s.exchanges = [
    ...extractionExchanges('x-ext', 8 * SECOND, TENANT_SHA),
    exchange('x-classify-tx', { startMs: 38 * SECOND, purpose: 'classify_transactions', latencyMs: 3000, model: HAIKU }),
    exchange('x-explanation', { startMs: 42 * SECOND, purpose: 'explanation', latencyMs: 3500, model: HAIKU }),
  ]
  s.audit = [
    auditRow({ id: 'au-in-1', actor: FROM_WHATSAPP, action: 'inbound.document_received', subject: 'in-1', details: { clarification_id: null, application_id: APP_ID }, atMs: 2 * SECOND }),
    auditRow({ id: 'au-recv', actor: FROM_WHATSAPP, action: APP_RECEIVED, subject: APP_ID, details: { inbound_message_id: 'in-1' }, atMs: 2 * SECOND }),
    auditRow({ id: 'au-job-1', actor: 'worker', action: JOB_SUCCESS, details: { status: 'qualified' }, atMs: 60 * SECOND }),
    auditRow({ id: 'au-verdict-1', actor: 'worker', action: 'verdict.queued', details: { status: 'qualified', channel: 'whatsapp' }, atMs: 60 * SECOND }),
    auditRow({ id: 'au-in-2', actor: FROM_WHATSAPP, action: 'inbound.offer_accepted', subject: 'in-2', details: { clarification_id: null, application_id: APP_ID }, atMs: offerAt + 2 * SECOND }),
    auditRow({ id: 'au-job-2', actor: 'worker', action: 'application.redecided', details: { status: 'qualified', corrections: 0 }, atMs: redecideEnd }),
    auditRow({ id: 'au-verdict-2', actor: 'worker', action: 'verdict.queued', details: { status: 'qualified', channel: 'whatsapp' }, atMs: redecideEnd }),
  ]
  s.decisions = [decisionRow('dec-1', { status: 'qualified', atMs: 60 * SECOND }), decisionRow('dec-2', { status: 'qualified', atMs: redecideEnd })]
  return s
}

const BUILDERS: Record<TimelineSampleKind, () => TimelineSources> = {
  whatsapp: whatsappSources,
  api: apiSources,
  legacy: legacySources,
  failed: failedSources,
  offer: offerSources,
}

/** Las filas de uno de los recorridos de ejemplo (nuevas en cada llamada). */
export function sampleTimelineSources(kind: TimelineSampleKind): TimelineSources {
  auditSeq = 0
  return BUILDERS[kind]()
}

export const SAMPLE_APPLICATION_ID = APP_ID
