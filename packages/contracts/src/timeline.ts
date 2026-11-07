/**
 * Recorrido de una solicitud (ADR 0067): la línea de tiempo que la pestaña "Recorrido" del backoffice
 * dibuja en 3D. No se guarda: se reconstruye al pedirla, solo con lo que ya está en el esquema `app`
 * (mensajes, bitácora, extracciones, llamadas al modelo, decisiones, aclaraciones, correcciones).
 *
 * Cada evento dice qué tan seguro es su tiempo (`precision`):
 * - `exact`: la columna de tiempo de su propia fila (`received_at`, `created_at + latency_ms`, …).
 * - `derived`: calculado de dos filas que sí tienen tiempo (la espera en cola: de que se encoló a la
 *   primera actividad del trabajo).
 * - `inferred`: el paso no deja tiempo propio (`decide`, `re-decide`, una llamada anterior a ADR 0064)
 *   y se coloca entre lo que sí lo tiene.
 *
 * Sin PII ni cifras del documento: ids, estados, modelos, páginas, conteos, tiempos y costos. El texto
 * de los mensajes, los números de teléfono, los montos y los valores leídos se quedan en las pantallas
 * que ya los muestran.
 */
import { z } from 'zod'
import { ApplicationStatus, DecisionStatus } from './enums.ts'
import { Count, IsoDateTime } from './primitives.ts'

/** Capa del sistema donde ocurre el evento; en la escena 3D es la placa (de arriba hacia abajo). */
export const TimelineLane = z.enum(['supplier', 'relay', 'queue', 'workflow', 'models', 'engine', 'analyst'])
export type TimelineLane = z.infer<typeof TimelineLane>

export const TimelinePrecision = z.enum(['exact', 'derived', 'inferred'])
export type TimelinePrecision = z.infer<typeof TimelinePrecision>

/** Fila de donde sale el evento, para enlazar al detalle que ya existe (por ejemplo, la llamada al modelo). */
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

/** Pasos del workflow `process-application` (packages/mastra/src/workflow.ts). */
export const WorkflowStepId = z.enum(['extract', 'classify-transactions', 'decide', 'ask-owner', 'apply-answers', 're-decide', 'explain', 'finalize'])
export type WorkflowStepId = z.infer<typeof WorkflowStepId>

/** Trabajo de pg-boss (packages/platform/src/queue.ts). */
export const TimelineJob = z.enum(['process', 'resume', 'redecide'])
export type TimelineJob = z.infer<typeof TimelineJob>

const EventBase = {
  /** Estable entre llamadas: `<tabla>:<id>[:<sufijo>]`. */
  id: z.string().min(1),
  lane: TimelineLane,
  start: IsoDateTime,
  /** null: evento puntual. */
  end: IsoDateTime.nullable(),
  precision: TimelinePrecision,
  /** Capítulo al que pertenece (`TimelineChapter.id`). */
  chapter: z.string().min(1),
  /** Texto corto en español para la línea de tiempo y el panel, sin datos del documento ni del proveedor. */
  label: z.string().min(1).max(160),
  source: TimelineSource.nullable(),
}

export const TimelineEvent = z.discriminatedUnion('kind', [
  z.strictObject({ ...EventBase, kind: z.literal('application_created'), origin: z.enum(['whatsapp', 'email', 'api', 'backoffice', 'unknown']) }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('inbound_message'),
    channel: z.string(),
    /** `inbound_messages.resolution` (matched, document_received, intake_amount, summary, …); null sin procesar. */
    resolution: z.string().nullable(),
    has_document: z.boolean(),
    media_kind: z.enum(['image', 'audio', 'video', 'sticker']).nullable(),
    /** true si el intérprete de Haiku leyó la respuesta (ADR 0040). */
    interpreted: z.boolean(),
  }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('outbound_message'),
    channel: z.string(),
    /** `outbound_messages.kind`: question, reask, invoice, verdict, document, registration, generic, … */
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
    /** classify, summary, transactions, retry_page, double_read, citations, classify_transactions, write_questions, explain, interpret_reply, … */
    purpose: z.string(),
    model: z.string(),
    prompt: z.string().nullable(),
    effort: z.string().nullable(),
    /** Páginas del PDF que leyó; vacío si no lee el documento. */
    pages: z.array(z.int().min(1)),
    /** Índice en `ApplicationTimeline.documents`; null si la llamada no es sobre un documento. */
    document_index: Count.nullable(),
    cache_hit: z.boolean(),
    outcome: z.enum(['ok', 'error']),
    error_code: z.string().nullable(),
    cost_usd: z.number().nonnegative(),
    latency_ms: Count,
    input_tokens: Count,
    output_tokens: Count,
    /** Para abrir el detalle existente (`GET /bo/v1/llm-exchanges/:id`); null si no hay fila (anterior a ADR 0064). */
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
    /** Páginas con un issue de la extracción (saldo roto, totales, formato…). */
    pages_with_issues: z.array(z.int().min(1)),
    flags: z.array(z.string()),
  }),
  z.strictObject({
    ...EventBase,
    kind: z.literal('decision'),
    decision_id: z.string(),
    decision_kind: z.enum(['active', 'shadow']),
    status: DecisionStatus,
    /** Sin el monto: solo si hay línea. */
    has_limit: z.boolean(),
    score: z.number().min(0).max(100).nullable(),
    band_index: Count.nullable(),
    policy_version: z.int().min(1).nullable(),
    gates: z.array(z.strictObject({ id: z.string(), outcome: z.enum(['pass', 'fail', 'unknown']), effect: z.enum(['none', 'needs_clarification', 'human_review', 'not_qualified']) })),
    dimensions: z.array(z.strictObject({ id: z.string(), weight: z.number(), normalized: z.number().min(0).max(1).nullable(), used: z.boolean() })),
    /** Temas que pregunta, si pide aclaración. */
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

/** Agrupa eventos en lo que el usuario avanza con "paso anterior / siguiente". */
export const TimelineChapter = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['registration', 'intake', 'reception', 'extraction', 'classification', 'decision', 'clarification', 'resume', 'explanation', 'verdict', 'offer', 'redecide', 'analyst', 'failure']),
  title: z.string().min(1).max(80),
  round: Count,
  start: IsoDateTime,
  end: IsoDateTime,
})
export type TimelineChapter = z.infer<typeof TimelineChapter>

/** Tramo sin actividad que la línea de tiempo comprime y rotula con su duración real. */
export const TimelineGap = z.strictObject({
  start: IsoDateTime,
  end: IsoDateTime,
  reason: z.enum(['waiting_supplier', 'waiting_analyst', 'waiting_queue', 'idle']),
})
export type TimelineGap = z.infer<typeof TimelineGap>

/** Un PDF de la solicitud, para dibujar sus páginas. */
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
      /** El peor estado de los valores citados en esa página. */
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
    /** Ordenados por `start`; empates por el orden en que ocurrieron. */
    events: z.array(TimelineEvent),
    chapters: z.array(TimelineChapter),
    gaps: z.array(TimelineGap),
    totals: z.strictObject({
      duration_ms: Count,
      /** Sin los tramos de `gaps`. */
      active_ms: Count,
      model_calls: Count,
      cache_hits: Count,
      cost_usd: z.number().nonnegative(),
    }),
    /** Avisos en español de lo que no se pudo saber (por ejemplo, llamadas colocadas por inferencia). */
    limitations: z.array(z.string()),
  })
  .meta({ id: 'ApplicationTimeline', title: 'Recorrido de una solicitud', description: 'Línea de tiempo reconstruida de lo guardado (ADR 0067)' })
export type ApplicationTimeline = z.infer<typeof ApplicationTimeline>
