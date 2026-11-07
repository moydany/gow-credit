/**
 * Estado que viaja entre los pasos del workflow. Vive en el snapshot de Mastra (libSQL en
 * standalone), así que una solicitud pausada se reanuda en otro proceso con todo lo necesario:
 * extracciones ya clasificadas, veredicto, preguntas y respuestas.
 */
import { ApplicationRequest, ClassificationSummary, Decision, IsoDate, MaxLine, NO_DECLARATIONS, OwnerAnswer, OwnerDeclarations, Policy, Question, Sha256, StatementAgeSetting, StatementExtraction, SupplierIdentity } from '@gow/contracts'
import { z } from 'zod'

export const AppInput = z.object({
  application_id: z.string().min(1),
  pdf_path: z.string().min(1),
  as_of: IsoDate,
  request: ApplicationRequest.nullable(),
  supplier: SupplierIdentity.nullable(),
  policy: Policy,
  policy_id: z.string().nullable(),
  /**
   * Ajuste de antigüedad del tenant (ADR 0049), fijado al abrir la corrida: el modo full lo pasa y la
   * antigüedad del documento solo advierte. Ausente (standalone), aplica la compuerta de la política.
   */
  statement_age: StatementAgeSetting.optional(),
})
export type AppInput = z.infer<typeof AppInput>

export const CallRecordSchema = z.object({ purpose: z.string(), model: z.string(), cost_usd: z.number(), cache_hit: z.boolean() })

export const Issue = z.object({ question_id: z.string(), reason: z.string() })

export const AppState = z.object({
  input: AppInput,
  statements: z.array(StatementExtraction),
  documents: z.array(z.object({ file_name: z.string(), sha256: Sha256, extraction_status: z.enum(['complete', 'partial', 'failed']), origin: z.enum(['submitted', 'owner_answer']) })),
  supplier: SupplierIdentity.nullable(),
  declarations: OwnerDeclarations.default(NO_DECLARATIONS).describe('Cliente principal y uso de la cuenta que dijo el dueño (ADR 0050)'),
  classification: ClassificationSummary.nullable(),
  decision: Decision.nullable(),
  max_line: MaxLine.nullable(),
  questions: z.array(Question).describe('Preguntas pendientes que arma el veredicto actual'),
  asked: z.array(Question).describe('Las preguntas que se enviaron en la última ronda, ya redactadas'),
  asked_keys: z.array(z.string()).default([]).describe('Tema y movimiento de todo lo que ya se preguntó en alguna ronda: no se vuelve a preguntar (ADR 0051)'),
  answers: z.array(OwnerAnswer),
  rejected_answers: z.array(Issue),
  contradictions: z.array(Issue),
  rounds: z.int().min(0),
  failure_reason: z.string().nullable(),
  calls: z.array(CallRecordSchema),
  notes: z.array(z.string()).describe('Avisos sin datos del documento: fallas del clasificador o del redactor'),
})
export type AppState = z.infer<typeof AppState>

export const AskSuspend = z.object({ application_id: z.string(), round: z.int(), questions: z.array(Question), state: AppState })
export type AskSuspend = z.infer<typeof AskSuspend>
export const AskResume = z.object({
  answers: z.array(OwnerAnswer),
  /** Rutas absolutas de los PDFs nuevos que traen las respuestas `documents` (el CLI las resuelve). */
  base_dir: z.string().nullable(),
})
export type AskResume = z.infer<typeof AskResume>
