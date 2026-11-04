/**
 * Estados y términos canónicos de docs/README.md. Se usan tal cual en código, base de
 * datos y documentación; cualquier cambio aquí es un cambio de contrato.
 */
import { z } from 'zod'

/** Ciclo de vida de la solicitud (`application.status`). */
export const ApplicationStatus = z.enum([
  'received',
  'extracting',
  'extracted',
  'deciding',
  'needs_clarification',
  'human_review',
  'qualified',
  'qualified_with_limit',
  'not_qualified',
  'failed',
])
export type ApplicationStatus = z.infer<typeof ApplicationStatus>

/** Veredicto del motor (`decision.status`). Los tres primeros son finales. */
export const DecisionStatus = z.enum(['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review'])
export type DecisionStatus = z.infer<typeof DecisionStatus>

/** Estados finales del veredicto: los que pueden salir de una banda. */
export const FinalDecisionStatus = z.enum(['qualified', 'qualified_with_limit', 'not_qualified'])
export type FinalDecisionStatus = z.infer<typeof FinalDecisionStatus>

/** Orden de los estados finales, del mejor al peor. Lo usan los topes (`caps`). */
export const FINAL_STATUS_RANK: Readonly<Record<FinalDecisionStatus, number>> = {
  qualified: 2,
  qualified_with_limit: 1,
  not_qualified: 0,
}

/** Versión de política (`policy_version.status`). */
export const PolicyVersionStatus = z.enum(['draft', 'shadow', 'active', 'archived'])
export type PolicyVersionStatus = z.infer<typeof PolicyVersionStatus>

/** Aclaración (`clarification.status`). */
export const ClarificationStatus = z.enum(['open', 'answered', 'expired', 'rejected'])
export type ClarificationStatus = z.infer<typeof ClarificationStatus>

/** Verificación de un campo extraído. */
export const Verification = z.enum(['verified', 'unverified', 'conflict'])
export type Verification = z.infer<typeof Verification>

/** Procedencia de un valor. */
export const Provenance = z.enum(['extracted', 'owner_answer', 'analyst_answer', 'external'])
export type Provenance = z.infer<typeof Provenance>

/** Clasificación de documento. */
export const DocumentType = z.enum(['bank_statement', 'credit_card_statement', 'invoice', 'other'])
export type DocumentType = z.infer<typeof DocumentType>

/**
 * Clasificación de movimiento. `loan_payment` (pago a un crédito: cuota, tarjeta, préstamo)
 * se agregó en la fase 4 (ADR 0013): sin ella `debt_service_monthly` no se podía calcular.
 */
export const TransactionCategory = z.enum([
  'customer_payment',
  'own_transfer',
  'loan_disbursement',
  'loan_payment',
  'payroll',
  'supplier_payment',
  'tax',
  'fee',
  'interest',
  'other',
])
export type TransactionCategory = z.infer<typeof TransactionCategory>

/** Sentido del movimiento. El monto siempre es positivo; el signo vive aquí. */
export const TransactionType = z.enum(['credit', 'debit'])
export type TransactionType = z.infer<typeof TransactionType>
