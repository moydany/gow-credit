/**
 * Respuestas de la API del backoffice (`/bo/v1`, docs/08 §4). Lo que el navegador lee: filas de
 * lista y el detalle compuesto de una solicitud. Las cargas grandes (extracción, veredicto)
 * conservan sus contratos propios; aquí solo se arma el sobre.
 */
import { z } from 'zod'
import { ApplicationStatus, ClarificationStatus, DecisionStatus, PolicyVersionStatus } from './enums.ts'
import { OwnerAnswer, Question } from './clarification.ts'
import { Decision } from './decision.ts'
import { Money, Sha256 } from './primitives.ts'
import { ApplicationRequest } from './request.ts'
import { SimulationReport } from './simulation.ts'
import { StatementExtraction } from './statement.ts'

export const ClarificationChannelName = z.enum(['whatsapp', 'email', 'manual'])
export const OutcomeName = z.enum(['paid', 'late', 'default', 'fraud'])

export const BackofficeMe = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.string() }),
  tenant: z.strictObject({ id: z.uuid(), name: z.string(), whatsapp_number: z.string().nullable() }),
})
export type BackofficeMe = z.infer<typeof BackofficeMe>

export const ApplicationRow = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  failure_reason: z.string().nullable(),
  supplier: z.strictObject({ id: z.uuid(), legal_name: z.string() }),
  request: ApplicationRequest.nullable(),
  decision: z.strictObject({ status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable(), policy_version: z.int().nullable(), reasons: z.array(z.strictObject({ code: z.string(), message: z.string() })) }).nullable(),
  document: z.strictObject({ file_name: z.string().nullable(), bank: z.string().nullable(), page_count: z.int().nullable(), issues: z.int(), flags: z.array(z.string()) }).nullable(),
  open_clarifications: z.int(),
  outcome: OutcomeName.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ApplicationRow = z.infer<typeof ApplicationRow>

export const ClarificationItem = z.strictObject({
  id: z.uuid(),
  application_id: z.uuid(),
  supplier_name: z.string(),
  round: z.int(),
  status: ClarificationStatus,
  channel: ClarificationChannelName,
  questions: z.array(Question),
  answers: z.array(OwnerAnswer),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  answered_by: z.string().nullable().describe('Usuario del backoffice que respondió a nombre del proveedor; null si respondió el proveedor'),
})
export type ClarificationItem = z.infer<typeof ClarificationItem>

export const ApplicationDetail = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  failure_reason: z.string().nullable(),
  request: ApplicationRequest.nullable(),
  as_of: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  supplier: z.strictObject({ id: z.uuid(), legal_name: z.string(), rfc: z.string().nullable(), external_ref: z.string().nullable(), clabes: z.array(z.string()) }),
  documents: z.array(z.strictObject({ id: z.uuid(), sha256: Sha256, size_bytes: z.number(), media_type: z.string() })),
  extraction: StatementExtraction.nullable(),
  decision: z.strictObject({ id: z.uuid(), policy_version: z.int().nullable(), created_at: z.string(), payload: Decision }).nullable(),
  shadow: z.strictObject({ policy_version: z.int().nullable(), status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable() }).nullable(),
  clarifications: z.array(ClarificationItem),
  outcomes: z.array(z.strictObject({ outcome: OutcomeName, observed_at: z.string() })),
})
export type ApplicationDetail = z.infer<typeof ApplicationDetail>

export const PolicyVersionItem = z.strictObject({
  id: z.uuid(),
  version: z.int(),
  status: PolicyVersionStatus,
  document: z.unknown(),
  simulation: SimulationReport.nullable(),
  created_at: z.string(),
  activated_at: z.string().nullable(),
})
export type PolicyVersionItem = z.infer<typeof PolicyVersionItem>

export const AuditEntry = z.strictObject({ id: z.uuid(), actor: z.string(), actor_label: z.string().nullable().describe('Correo del usuario cuando el actor es una persona del backoffice'), action: z.string(), subject: z.string().nullable(), details: z.record(z.string(), z.unknown()), at: z.string() })
export type AuditEntry = z.infer<typeof AuditEntry>
