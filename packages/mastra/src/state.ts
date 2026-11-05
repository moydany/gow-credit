/**
 * Estado que viaja entre los pasos del workflow. Vive en el snapshot de Mastra (libSQL en
 * standalone), así que una solicitud pausada se reanuda en otro proceso con todo lo necesario:
 * extracciones ya clasificadas, veredicto, preguntas y respuestas.
 */
import { ApplicationRequest, ClassificationSummary, Decision, IsoDate, MaxLine, OwnerAnswer, Policy, Question, Sha256, StatementExtraction, SupplierIdentity } from '@gow/contracts'
import { z } from 'zod'

export const AppInput = z.object({
  application_id: z.string().min(1),
  pdf_path: z.string().min(1),
  as_of: IsoDate,
  request: ApplicationRequest.nullable(),
  supplier: SupplierIdentity.nullable(),
  policy: Policy,
  policy_id: z.string().nullable(),
})
export type AppInput = z.infer<typeof AppInput>

export const CallRecordSchema = z.object({ purpose: z.string(), model: z.string(), cost_usd: z.number(), cache_hit: z.boolean() })

export const Issue = z.object({ question_id: z.string(), reason: z.string() })

export const AppState = z.object({
  input: AppInput,
  statements: z.array(StatementExtraction),
  documents: z.array(z.object({ file_name: z.string(), sha256: Sha256, extraction_status: z.enum(['complete', 'partial', 'failed']), origin: z.enum(['submitted', 'owner_answer']) })),
  supplier: SupplierIdentity.nullable(),
  classification: ClassificationSummary.nullable(),
  decision: Decision.nullable(),
  max_line: MaxLine.nullable(),
  questions: z.array(Question),
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
