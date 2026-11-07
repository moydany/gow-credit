/**
 * Input of `buildTimeline`: the rows the API reads from the `app` schema for one request, already
 * filtered by tenant (RLS) and request, with dates as `Date`. An internal type between the API
 * and the builder, not a network boundary, hence TypeScript types and not a Zod schema.
 *
 * Deliberately NOT carried: message text, phone numbers and emails, the invoice draft, registry
 * names and RFC, the prompt and response of calls. The API does not select them.
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
  /** The stored extraction of the document, if it exists (immutable). */
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
  /** PII-free by construction of the log: ids, codes and statuses. */
  details: Record<string, unknown>
  at: Date
}

export interface TimelineExchangeRow {
  id: string
  /** null if the call belongs to an incoming message (interpreter) and not to a job. */
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
  /** When the call started (`RecordingStructuredLlm` takes it before calling): end = createdAt + latencyMs. */
  createdAt: Date
}

export interface TimelineDecisionRow {
  id: string
  kind: 'active' | 'shadow'
  status: string
  policyVersion: number | null
  /** Full `Decision` as stored; the builder validates it and discards what it cannot read. */
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
  /** Only the type of the corrected value (e.g. `holder.rfc`, `transaction`), never the value. */
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
