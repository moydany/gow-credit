/**
 * State carried between workflow steps. It lives in the Mastra snapshot (libSQL in standalone),
 * so a paused request resumes in another process with everything needed: already-classified
 * extractions, verdict, questions and answers.
 */
import { ApplicationRequest, ClassificationSummary, Decision, IsoDate, MaxLine, NO_DECLARATIONS, OwnerAnswer, OwnerDeclarations, Policy, Question, Sha256, StatementAgeSetting, StatementExtraction, SupplierIdentity } from '@gow/contracts'
import { z } from 'zod'

export const AppInput = z.object({
  application_id: z.string().min(1),
  pdf_path: z.string().min(1),
  /**
   * More statements of the same request, sent together (ADR 0072): the other months when the policy
   * evaluates three. They are extracted like the first; one that fails is noted and left out.
   */
  extra_pdf_paths: z.array(z.string().min(1)).optional(),
  as_of: IsoDate,
  request: ApplicationRequest.nullable(),
  supplier: SupplierIdentity.nullable(),
  policy: Policy,
  policy_id: z.string().nullable(),
  /**
   * Tenant's age adjustment, fixed when the run opens: full mode passes it and document age only
   * warns. Absent (standalone), the policy's gate applies.
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
  declarations: OwnerDeclarations.default(NO_DECLARATIONS).describe('Cliente principal y uso de la cuenta que dijo el dueño'),
  classification: ClassificationSummary.nullable(),
  decision: Decision.nullable(),
  max_line: MaxLine.nullable(),
  questions: z.array(Question).describe('Preguntas pendientes que arma el veredicto actual'),
  asked: z.array(Question).describe('Las preguntas que se enviaron en la última ronda, ya redactadas'),
  asked_keys: z.array(z.string()).default([]).describe('Tema y movimiento de todo lo que ya se preguntó en alguna ronda: no se vuelve a preguntar'),
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
  /** Absolute paths of the new PDFs carried by `documents` answers (the CLI resolves them). */
  base_dir: z.string().nullable(),
})
export type AskResume = z.infer<typeof AskResume>
