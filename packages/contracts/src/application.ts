/**
 * Resultado de evaluar una solicitud en modo standalone (`pnpm run evaluate`, docs/07 A): un
 * archivo por documento con el estado de la solicitud, el veredicto, la línea máxima cuando no
 * hay monto solicitado, la aclaración pendiente o respondida, qué clasificó los movimientos y
 * cuánto costó. La extracción va en su propio archivo con el contrato `StatementExtraction`.
 */
import { z } from 'zod'
import { ClarificationStatus, ApplicationStatus } from './enums.ts'
import { OwnerAnswer, Question } from './clarification.ts'
import { Decision } from './decision.ts'
import { ApplicationRequest, SupplierIdentity } from './request.ts'
import { Count, IsoDate, IsoDateTime, Money, Sha256 } from './primitives.ts'

export const APPLICATION_RESULT_VERSION = '1.0.0'

/** El mayor monto que, solicitado, la política aprobaría (docs/07 A: sin monto, "línea máxima y perfil"). */
export const MaxLine = z
  .strictObject({
    amount: Money,
    status: z.enum(['qualified', 'qualified_with_limit']),
    score: z.number().min(0).max(100).nullable(),
    conditional_on: z.array(z.string()).describe('Compuertas o aclaraciones pendientes: la línea vale si se resuelven a favor'),
  })
  .meta({ id: 'MaxLine' })
export type MaxLine = z.infer<typeof MaxLine>

/** Quién clasificó los movimientos y cuántos (docs/02 §4c). */
export const ClassificationSummary = z
  .strictObject({
    implementation: z.enum(['jev', 'claude', 'rules']).describe('rules: el modelo no corrió o falló y quedó el respaldo por reglas'),
    model: z.string().nullable(),
    fallback: z.boolean().describe('true si no había llave de Jev y clasificó Haiku'),
    rules_version: z.string(),
    transactions: Count,
    sent_to_model: Count.describe('Movimientos que las reglas no resolvían con confianza'),
    classified_by_model: Count,
    error: z.string().nullable(),
  })
  .meta({ id: 'ClassificationSummary' })
export type ClassificationSummary = z.infer<typeof ClassificationSummary>

export const CostLine = z.strictObject({
  purpose: z.string(),
  model: z.string(),
  calls: Count,
  cache_hits: Count,
  cost_usd: z.number().nonnegative(),
})
export type CostLine = z.infer<typeof CostLine>

export const ApplicationResult = z
  .strictObject({
    schema_version: z.literal(APPLICATION_RESULT_VERSION),
    application_id: z.string().min(1).describe('Nombre del PDF sin extensión'),
    status: ApplicationStatus,
    failure_reason: z.string().nullable(),
    as_of: IsoDate.describe('Fecha de cálculo del perfil: el "hoy" de la antigüedad del documento'),
    documents: z.array(
      z.strictObject({
        file_name: z.string(),
        sha256: Sha256,
        extraction_status: z.enum(['complete', 'partial', 'failed']),
        origin: z.enum(['submitted', 'owner_answer']),
      }),
    ),
    request: ApplicationRequest.nullable(),
    supplier: SupplierIdentity.nullable().describe('Identidad declarada (solicitud o respuesta del dueño) contra la que se compara el documento'),
    policy: z.strictObject({ id: z.string().nullable(), version: z.int().min(1) }),
    decision: Decision.nullable(),
    max_line: MaxLine.nullable().describe('Solo sin monto solicitado'),
    clarification: z
      .strictObject({
        status: ClarificationStatus,
        rounds_used: Count,
        questions: z.array(Question),
        answers: z.array(OwnerAnswer),
        rejected_answers: z.array(z.strictObject({ question_id: z.string(), reason: z.string() })),
      })
      .nullable(),
    classification: ClassificationSummary.nullable(),
    run: z.strictObject({
      workflow: z.string(),
      run_id: z.string(),
      status: z.enum(['success', 'suspended', 'failed']),
      suspended_step: z.array(z.string()).nullable().describe('Ruta del paso suspendido, para reanudar'),
    }),
    costs: z.strictObject({ total_usd: z.number().nonnegative(), lines: z.array(CostLine) }),
    generated_at: IsoDateTime,
  })
  .meta({ id: 'ApplicationResult', title: 'Resultado de una solicitud (modo standalone)' })
export type ApplicationResult = z.infer<typeof ApplicationResult>
