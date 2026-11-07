/**
 * Request journey: the timeline the backoffice "Recorrido" tab draws in 3D. Not stored: rebuilt on
 * request from what is already in the `app` schema (messages, log, extractions, model calls,
 * decisions, clarifications, corrections).
 *
 * Each event says how certain its time is (`precision`):
 * - `exact`: the time column of its own row (`received_at`, `created_at + latency_ms`, ...).
 * - `derived`: computed from two rows that have a time (queue wait: from enqueue to the job
 *   first activity).
 * - `inferred`: the step leaves no time of its own (`decide`, `re-decide`, a call from before
 *   exchange recording) and is placed between those that do.
 *
 * No PII or document figures: ids, statuses, models, pages, counts, times and costs. Message
 * text, phone numbers, amounts and read values stay in the screens that already show them.
 */
import { z } from 'zod'
import { ApplicationStatus, DecisionStatus } from './enums.ts'
import { Count, IsoDateTime } from './primitives.ts'

/** System layer where the event happens; in the 3D scene it is the plate (top to bottom). */
export const TimelineLane = z.enum(['supplier', 'relay', 'queue', 'workflow', 'models', 'engine', 'analyst'])
export type TimelineLane = z.infer<typeof TimelineLane>

export const TimelinePrecision = z.enum(['exact', 'derived', 'inferred'])
export type TimelinePrecision = z.infer<typeof TimelinePrecision>

/** Row the event comes from, to link to the existing detail (e.g. the model call). */
export const TimelineSource = z.strictObject({
  table: z.enum([
    'applications',
    'inbound_messages',
    'outbound_messages',
    'audit_log',
    'extractions',
    'llm_exchanges',
    'decisions',
    'clarifications',
    'corrections',
    'outcomes',
  ]),
  id: z.string().min(1),
})
export type TimelineSource = z.infer<typeof TimelineSource>

/** Steps of the `process-application` workflow (packages/mastra/src/workflow.ts). */
export const WorkflowStepId = z.enum(['extract', 'classify-transactions', 'decide', 'ask-owner', 'apply-answers', 're-decide', 'explain', 'finalize'])
export type WorkflowStepId = z.infer<typeof WorkflowStepId>

/** pg-boss job (packages/platform/src/queue.ts). */
export const TimelineJob = z.enum(['process', 'resume', 'redecide'])
export type TimelineJob = z.infer<typeof TimelineJob>

const EventBase = {
  /** Stable across calls: `<table>:<id>[:<suffix>]`. */
  id: z.string().min(1),
  lane: TimelineLane,
  start: IsoDateTime,
  /** null: point event. */
  end: IsoDateTime.nullable(),
  precision: TimelinePrecision,
  /** Chapter it belongs to (`TimelineChapter.id`). */
  chapter: z.string().min(1),
  /** Short Spanish text for the timeline and panel, without document or supplier data. */
  label: z.string().min(1).max(160),
  source: TimelineSource.nullable(),
}

export const TimelineEvent = z.discriminatedUnion('kind', [
  z.strictObject({ ...EventBase, kind: z.literal('application_created'), origin: z.enum(['whatsapp', 'email', 'api', 'backoffice', 'unknown']) }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('inbound_message'),
    channel: z.string(),
    /** `inbound_messages.resolution` (matched, document_received, intake_amount, summary, ...); null if unprocessed. */
    resolution: z.string().nullable(),
    has_document: z.boolean(),
    media_kind: z.enum(['image', 'audio', 'video', 'sticker']).nullable(),
    /** true if the Haiku interpreter read the reply. */
    interpreted: z.boolean(),
  }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('outbound_message'),
    channel: z.string(),
    /** `outbound_messages.kind`: question, reask, invoice, verdict, document, registration, generic, ... */
    message_kind: z.string(),
    delivery: z.enum(['pending', 'sent', 'failed']),
    attempts: Count,
  }),
  z.strictObject({ ...EventBase, kind: z.literal('queue_wait'), job: TimelineJob }),
  z.strictObject({ ...EventBase, kind: z.literal('job_finished'), job: TimelineJob.nullable(), application_status: ApplicationStatus }),
  z.strictObject({ ...EventBase, kind: z.literal('workflow_step'), step: WorkflowStepId, round: Count }),
  z.strictObject({ ...EventBase, kind: z.literal('workflow_suspended'), round: z.int().min(1) }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('model_call'),
    /** classify, summary, transactions, retry_page, double_read, citations, classify_transactions, write_questions, explain, interpret_reply, ... */
    purpose: z.string(),
    model: z.string(),
    prompt: z.string().nullable(),
    effort: z.string().nullable(),
    /** PDF pages it read; empty if it does not read the document. */
    pages: z.array(z.int().min(1)),
    /** Index into `ApplicationTimeline.documents`; null if the call is not about a document. */
    document_index: Count.nullable(),
    cache_hit: z.boolean(),
    outcome: z.enum(['ok', 'error']),
    error_code: z.string().nullable(),
    cost_usd: z.number().nonnegative(),
    latency_ms: Count,
    input_tokens: Count,
    output_tokens: Count,
    /** To open the existing detail (`GET /bo/v1/llm-exchanges/:id`); null if there is no row (before exchange recording). */
    exchange_id: z.string().nullable(),
  }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('verification'),
    document_index: Count,
    extraction_status: z.enum(['complete', 'partial', 'failed']),
    verified: Count,
    unverified: Count,
    conflict: Count,
    /** Pages with an extraction issue (broken balance, totals, format, ...). */
    pages_with_issues: z.array(z.int().min(1)),
    flags: z.array(z.string()),
  }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('decision'),
    decision_id: z.string(),
    decision_kind: z.enum(['active', 'shadow']),
    status: DecisionStatus,
    /** Without the amount: only whether there is a line. */
    has_limit: z.boolean(),
    score: z.number().min(0).max(100).nullable(),
    band_index: Count.nullable(),
    policy_version: z.int().min(1).nullable(),
    gates: z.array(z.strictObject({ id: z.string(), outcome: z.enum(['pass', 'fail', 'unknown']), effect: z.enum(['none', 'needs_clarification', 'human_review', 'not_qualified']) })),
    dimensions: z.array(z.strictObject({ id: z.string(), weight: z.number(), normalized: z.number().min(0).max(1).nullable(), used: z.boolean() })),
    /** Topics it asks about, if it requests clarification. */
    asks: z.array(z.string()),
  }),
  z.strictObject({ ...EventBase, kind: z.literal('clarification_opened'), clarification_id: z.string(), round: z.int().min(1), channel: z.string(), questions: Count }),
  z.strictObject({ ...EventBase, kind: z.literal('clarification_answered'), clarification_id: z.string(), round: z.int().min(1), answers: Count }),
  z.strictObject({ ...EventBase, kind: z.literal('verdict_queued'), application_status: ApplicationStatus }),
  z.strictObject({ ...EventBase, kind: z.literal('correction'), document_index: Count.nullable(), page: z.int().min(1).nullable(), target: z.string() }),
  z.strictObject({ ...EventBase, kind: z.literal('analyst_action'), action: z.string() }),
])
export type TimelineEvent = z.infer<typeof TimelineEvent>
export type TimelineEventKind = TimelineEvent['kind']

/** Groups events into what the user advances with "previous / next step". */
export const TimelineChapter = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['registration', 'intake', 'reception', 'extraction', 'classification', 'decision', 'clarification', 'resume', 'explanation', 'verdict', 'offer', 'redecide', 'analyst', 'failure']),
  title: z.string().min(1).max(80),
  round: Count,
  start: IsoDateTime,
  end: IsoDateTime,
})
export type TimelineChapter = z.infer<typeof TimelineChapter>

/** Inactive stretch that the timeline compresses and labels with its real duration. */
export const TimelineGap = z.strictObject({
  start: IsoDateTime,
  end: IsoDateTime,
  reason: z.enum(['waiting_supplier', 'waiting_analyst', 'waiting_queue', 'idle']),
})
export type TimelineGap = z.infer<typeof TimelineGap>

/** A request PDF, to draw its pages. */
export const TimelineDocument = z.strictObject({
  document_id: z.string(),
  origin: z.enum(['submitted', 'owner_answer']),
  page_count: z.int().min(1).nullable(),
  route: z.enum(['text_and_vision', 'vision_only']).nullable(),
  extraction_status: z.enum(['complete', 'partial', 'failed']).nullable(),
  pages: z.array(
    z.strictObject({
      page: z.int().min(1),
      transactions: Count,
      issues: Count,
      /** The worst state among the values cited on that page. */
      verification: z.enum(['verified', 'unverified', 'conflict', 'none']),
    }),
  ),
})
export type TimelineDocument = z.infer<typeof TimelineDocument>

export const ApplicationTimeline = z
  .strictObject({
    application_id: z.string(),
    status: ApplicationStatus,
    created_at: IsoDateTime,
    start: IsoDateTime,
    end: IsoDateTime,
    documents: z.array(TimelineDocument),
    /** Ordered by `start`; ties by the order they happened. */
    events: z.array(TimelineEvent),
    chapters: z.array(TimelineChapter),
    gaps: z.array(TimelineGap),
    totals: z.strictObject({
      duration_ms: Count,
      /** Without the `gaps` stretches. */
      active_ms: Count,
      model_calls: Count,
      cache_hits: Count,
      cost_usd: z.number().nonnegative(),
    }),
    /** Spanish warnings about what could not be known (e.g. calls placed by inference). */
    limitations: z.array(z.string()),
  })
  .meta({ id: 'ApplicationTimeline', title: 'Recorrido de una solicitud', description: 'Línea de tiempo reconstruida de lo guardado' })
export type ApplicationTimeline = z.infer<typeof ApplicationTimeline>
