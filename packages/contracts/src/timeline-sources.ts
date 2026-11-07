/**
 * Entrada de `buildTimeline` (ADR 0067): las filas que la API lee del esquema `app` para una solicitud,
 * ya filtradas por tenant (RLS) y por solicitud, con las fechas como `Date`. Es un tipo interno entre la
 * API y el constructor, no un límite de red: por eso son tipos de TypeScript y no un esquema Zod.
 *
 * Lo que NO viaja aquí, a propósito: el texto de los mensajes, los números de teléfono y correos, el
 * borrador de la factura, los nombres y RFC del registro, el prompt y la respuesta de las llamadas.
 * La API no los selecciona.
 */
import type { ApplicationStatus } from './enums.ts'
import type { StatementExtraction } from './statement.ts'

export interface TimelineApplicationRow {
  id: string
  status: ApplicationStatus
  createdAt: Date
  updatedAt: Date
  failureReason: string | null
}

export interface TimelineDocumentRow {
  documentId: string
  origin: 'submitted' | 'owner_answer'
  createdAt: Date
  sha256: string
  /** La extracción guardada del documento, si ya existe (inmutable). */
  extraction: { id: string; createdAt: Date; payload: StatementExtraction } | null
}

export interface TimelineInboundRow {
  id: string
  channel: 'whatsapp' | 'email' | 'manual'
  receivedAt: Date
  processedAt: Date | null
  resolution: string | null
  clarificationId: string | null
  hasDocument: boolean
  mediaKind: string | null
}

export interface TimelineOutboundRow {
  id: string
  channel: 'whatsapp' | 'email' | 'manual'
  kind: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  clarificationId: string | null
  createdAt: Date
  sentAt: Date | null
}

export interface TimelineAuditRow {
  id: string
  actor: string
  action: string
  subject: string | null
  /** Ya sin PII por construcción de la bitácora: ids, códigos y estados. */
  details: Record<string, unknown>
  at: Date
}

export interface TimelineExchangeRow {
  id: string
  /** null si la llamada es de un mensaje entrante (intérprete, ADR 0040) y no de un trabajo. */
  applicationId: string | null
  inboundMessageId: string | null
  purpose: string
  model: string
  promptVersion: string
  effort: string
  documentSha256: string | null
  outcome: 'ok' | 'error'
  errorCode: string | null
  responseCacheHit: boolean
  usage: { input_tokens: number; output_tokens: number } | null
  costUsd: number
  latencyMs: number
  /** El instante en que empezó la llamada (`RecordingStructuredLlm` lo toma antes de llamar): fin = createdAt + latencyMs. */
  createdAt: Date
}

export interface TimelineDecisionRow {
  id: string
  kind: 'active' | 'shadow'
  status: string
  policyVersion: number | null
  /** `Decision` completa tal como se guardó; el constructor la valida y descarta lo que no lea. */
  payload: unknown
  createdAt: Date
}

export interface TimelineClarificationRow {
  id: string
  round: number
  status: 'open' | 'answered' | 'expired' | 'rejected'
  channel: 'whatsapp' | 'email' | 'manual'
  step: string
  questions: number
  answers: number
  createdAt: Date
  answeredAt: Date | null
}

export interface TimelineCorrectionRow {
  id: string
  documentId: string
  /** Solo el tipo de valor corregido (por ejemplo `holder.rfc`, `transaction`), nunca el valor. */
  target: string
  page: number | null
  createdAt: Date
}

export interface TimelineOutcomeRow {
  id: string
  createdAt: Date
}

export interface TimelineSources {
  application: TimelineApplicationRow
  documents: TimelineDocumentRow[]
  inbound: TimelineInboundRow[]
  outbound: TimelineOutboundRow[]
  audit: TimelineAuditRow[]
  exchanges: TimelineExchangeRow[]
  decisions: TimelineDecisionRow[]
  clarifications: TimelineClarificationRow[]
  corrections: TimelineCorrectionRow[]
  outcomes: TimelineOutcomeRow[]
}
