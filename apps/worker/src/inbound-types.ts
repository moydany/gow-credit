/** Tipos de la resolución de mensajes entrantes (ver `inbound.ts`). */
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
  // El PDF completo que se pidió por páginas faltantes (robustez documental, sección W).
  | 'document_answer'
  | 'awaiting_document'
  | 'registration_started'
  | 'registration_step'
  | 'registration_invalid'
  | 'registration_completed'
  | 'registration_waiting'
  | 'registered_idle'
  | 'intake_step'
  | 'intake_invalid'
  | 'intake_completed'
  | 'offer_accepted'
  | 'offer_invalid'
  | 'offer_skipped'
  // Aclaración por el chat (ADR 0051).
  | 'summary'
  | 'revising'
  | 'corrected'
  | 'confirmed'
  | 'awaiting_confirmation'
  | 'awaiting_analyst'
  | 'media_unsupported'

export interface InboundOptions {
  /** Hace falta para aceptar documentos; sin él, un documento se rechaza. */
  storage?: DocumentStorage
  /**
   * Demo (ADR 0038): un número de WhatsApp sin vínculo se registra conversando y queda como
   * proveedor verificado por posesión del número. Apagado, un número sin vínculo no abre nada.
   */
  selfRegistration?: boolean
  /** "Hoy" (AAAA-MM-DD) para rechazar un vencimiento ya pasado. */
  today?: () => string
  /**
   * Haiku para lo que las reglas no leen (ADR 0040). Propone; el lector determinista valida. Sin él,
   * o si falla, la conversación sigue solo con las reglas.
   */
  interpreter?: MessageInterpreter
  /**
   * Pedir monto, comprador y vencimiento de la factura antes de analizar (ADR 0039). Apagado (lo de
   * la demo), el estado de cuenta se analiza al llegar y el resultado es la línea máxima.
   */
  askInvoice?: boolean
}

export interface InboundResult {
  resolution: Resolution
  resume: ResumeJob | null
  /** Solo si el mensaje trajo un documento que abrió una solicitud: el trabajo a encolar. */
  process?: { job: ProcessJob; sha256: string }
  /** Si el intérprete con Haiku intervino en este mensaje. */
  interpreted?: boolean
  /** El proveedor dijo cuánto quiere adelantar (ADR 0053): reevaluar con ese monto. */
  redecide?: RedecideJob
}
