/** Types for inbound message resolution (see `inbound.ts`). */
import type { DocumentStorage, ProcessJob, RedecideJob, ResumeJob } from '@gow/platform'
import type { MessageInterpreter } from './interpret.ts'

export type Resolution =
  | 'matched'
  | 'completed'
  | 'no_link'
  | 'no_open_clarification'
  | 'unparsed'
  | 'already_processed'
  | 'document_received'
  | 'document_duplicate'
  | 'document_rejected'
  | 'document_ambiguous'
  // The complete PDF requested because of missing pages (document robustness).
  | 'document_answer'
  | 'awaiting_document'
  | 'registration_started'
  | 'registration_step'
  | 'registration_invalid'
  | 'registration_completed'
  | 'registration_waiting'
  // A PDF that arrived before the name and amount: kept until both are given.
  | 'registration_document_kept'
  | 'registered_idle'
  | 'intake_step'
  | 'intake_invalid'
  | 'intake_completed'
  | 'offer_accepted'
  | 'offer_invalid'
  | 'offer_skipped'
  // Clarification over chat.
  | 'summary'
  | 'revising'
  | 'corrected'
  | 'confirmed'
  | 'awaiting_confirmation'
  | 'awaiting_analyst'
  | 'media_unsupported'

export interface InboundOptions {
  /** Needed to accept documents; without it, a document is rejected. */
  storage?: DocumentStorage
  /**
   * Demo: an unlinked WhatsApp number registers by chatting and becomes a supplier verified by
   * possession of the number. Off, an unlinked number opens nothing.
   */
  selfRegistration?: boolean
  /** "Today" (YYYY-MM-DD) to reject an already-past due date. */
  today?: () => string
  /**
   * Haiku for what the rules cannot read. It proposes; the deterministic reader validates. Without
   * it, or if it fails, the conversation continues with the rules only.
   */
  interpreter?: MessageInterpreter
  /**
   * Ask for the invoice amount, buyer and due date before analyzing. Off (the demo), the statement
   * is analyzed on arrival and the result is the maximum line.
   */
  askInvoice?: boolean
}

export interface InboundResult {
  resolution: Resolution
  resume: ResumeJob | null
  /** Only if the message carried a document that opened a request: the job to enqueue. */
  process?: { job: ProcessJob; sha256: string }
  /** Whether the Haiku interpreter stepped in on this message. */
  interpreted?: boolean
  /** The supplier said how much they want to advance: re-evaluate with that amount. */
  redecide?: RedecideJob
}
