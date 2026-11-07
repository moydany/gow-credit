/**
 * Spanish journey texts: label tables. They never carry document or supplier data; event texts
 * come from here and from counts.
 */
import type { ApplicationStatus } from './enums.ts'
import type { TimelineJob, WorkflowStepId } from './timeline.ts'

/** Call purposes with their own handling. */
export const P_CLASSIFY_TX = 'classify_transactions'
export const P_QUESTIONS = 'clarification_questions'

export const STATUS_ES: Record<ApplicationStatus, string> = {
  received: 'recibida',
  extracting: 'extrayendo',
  extracted: 'extraída',
  deciding: 'decidiendo',
  needs_clarification: 'necesita aclaración',
  human_review: 'revisión humana',
  qualified: 'califica',
  qualified_with_limit: 'califica con límite',
  not_qualified: 'no califica',
  failed: 'falla',
}

export const JOB_ES: Record<TimelineJob, string> = { process: 'Procesamiento', resume: 'Reanudación', redecide: 'Reevaluación' }
export const JOB_DONE_ES: Record<TimelineJob, string> = { process: 'Procesamiento terminado', resume: 'Reanudación terminada', redecide: 'Reevaluación terminada' }

export const STEP_ES: Record<WorkflowStepId, string> = {
  extract: 'Extraer el documento',
  'classify-transactions': 'Clasificar movimientos',
  decide: 'Decidir',
  'ask-owner': 'Preguntar al proveedor',
  'apply-answers': 'Aplicar las respuestas',
  're-decide': 'Decidir de nuevo',
  explain: 'Explicar el resultado',
  finalize: 'Guardar el resultado',
}

export const INBOUND_ES: Record<string, string> = {
  matched: 'Respuesta del proveedor a una pregunta',
  completed: 'Respuesta que completa la aclaración',
  no_link: 'Mensaje de un número sin vínculo',
  no_open_clarification: 'Mensaje sin aclaración abierta',
  unparsed: 'Respuesta que no se entendió',
  already_processed: 'Mensaje ya procesado',
  document_received: 'Estado de cuenta recibido',
  document_duplicate: 'Documento repetido',
  document_rejected: 'Documento rechazado',
  document_ambiguous: 'Documento con varias solicitudes posibles',
  document_answer: 'Documento enviado como respuesta',
  awaiting_document: 'Mensaje mientras se espera el documento',
  registration_started: 'Inicio del registro del proveedor',
  registration_step: 'Dato del registro',
  registration_invalid: 'Dato del registro que no se entendió',
  registration_completed: 'Registro completado',
  registration_waiting: 'Mensaje mientras se espera el registro',
  registered_idle: 'Mensaje de un proveedor ya registrado',
  intake_step: 'Dato de la factura',
  intake_invalid: 'Dato de la factura que no se entendió',
  intake_completed: 'Datos de la factura completos',
  offer_accepted: 'Monto que el proveedor pidió',
  offer_invalid: 'Monto que no se entendió',
  offer_skipped: 'El proveedor omitió el monto',
  summary: 'Resumen de las respuestas',
  revising: 'El proveedor quiere corregir una respuesta',
  corrected: 'Corrección del proveedor',
  confirmed: 'Confirmación del proveedor',
  awaiting_confirmation: 'Mensaje mientras se espera la confirmación',
  awaiting_analyst: 'Mensaje mientras el analista revisa',
  media_unsupported: 'Foto, audio o video (solo se leen PDF)',
}

export const OUTBOUND_ES: Record<string, string> = {
  question: 'Pregunta al proveedor',
  reask: 'Repregunta al proveedor',
  invoice: 'Petición de datos de la factura',
  verdict: 'Aviso del resultado',
  document: 'Respuesta sobre el documento',
  registration: 'Mensaje del registro',
  media: 'Aviso: solo se leen PDF',
  generic: 'Mensaje al proveedor',
}

export const PURPOSE_ES: Record<string, string> = {
  classify: 'Clasificación del documento',
  summary: 'Lectura del encabezado y los periodos',
  transactions: 'Lectura de movimientos',
  retry_page: 'Relectura de una página',
  double_read: 'Doble lectura del encabezado',
  citations: 'Citas del documento',
  classify_transactions: 'Clasificación de movimientos',
  clarification_questions: 'Redacción de las preguntas',
  explanation: 'Redacción de la explicación',
  next_steps: 'Redacción de los próximos pasos',
  interpret_reply: 'Lectura de la respuesta del proveedor',
}

/** Calls the document reads: they belong to extraction. */
export const EXTRACTION_PURPOSES: ReadonlySet<string> = new Set(['classify', 'summary', 'transactions', 'retry_page', 'double_read', 'citations'])
export const EXPLAIN_PURPOSES: ReadonlySet<string> = new Set(['explanation', 'next_steps'])

export const ANALYST_ES: Record<string, string> = {
  'application.viewed': 'El analista abrió la solicitud',
  'application.discarded': 'El analista descartó el documento',
  'clarification.answered': 'El analista respondió la aclaración',
  'llm_exchange.viewed': 'El analista abrió una llamada al modelo',
  'outcome.recorded': 'El analista registró el resultado del crédito',
}

export const JOB_END_ACTIONS: ReadonlySet<string> = new Set(['application.success', 'application.suspended', 'application.failed', 'application.redecided'])


export const pagesText = (pages: readonly number[]): string => {
  if (pages.length === 0) return ''
  const a = Math.min(...pages)
  const b = Math.max(...pages)
  return a === b ? ` (pág. ${String(a)})` : ` (págs. ${String(a)}-${String(b)})`
}

export const ORIGIN_ES = { whatsapp: ' por WhatsApp', email: ' por correo', api: ' por la API', backoffice: ' desde el backoffice', unknown: '' } as const
