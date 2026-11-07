/**
 * Canonical statuses and terms. Used verbatim in code, database and docs; any change here is a
 * contract change.
 */
import { z } from 'zod'

/** Request lifecycle (`application.status`). */
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

/** Engine verdict (`decision.status`). The first three are final. */
export const DecisionStatus = z.enum(['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review'])
export type DecisionStatus = z.infer<typeof DecisionStatus>

/** Final verdict statuses: the ones a band can produce. */
export const FinalDecisionStatus = z.enum(['qualified', 'qualified_with_limit', 'not_qualified'])
export type FinalDecisionStatus = z.infer<typeof FinalDecisionStatus>

/** Final statuses ordered best to worst. Used by the caps (`caps`). */
export const FINAL_STATUS_RANK: Readonly<Record<FinalDecisionStatus, number>> = {
  qualified: 2,
  qualified_with_limit: 1,
  not_qualified: 0,
}

/** Policy version (`policy_version.status`). */
export const PolicyVersionStatus = z.enum(['draft', 'shadow', 'active', 'archived'])
export type PolicyVersionStatus = z.infer<typeof PolicyVersionStatus>

/** Clarification (`clarification.status`). */
export const ClarificationStatus = z.enum(['open', 'answered', 'expired', 'rejected'])
export type ClarificationStatus = z.infer<typeof ClarificationStatus>

/** Verification of an extracted field. */
export const Verification = z.enum(['verified', 'unverified', 'conflict'])
export type Verification = z.infer<typeof Verification>

/** Provenance of a value. */
export const Provenance = z.enum(['extracted', 'owner_answer', 'analyst_answer', 'external'])
export type Provenance = z.infer<typeof Provenance>

/** Document classification. */
export const DocumentType = z.enum(['bank_statement', 'credit_card_statement', 'invoice', 'other'])
export type DocumentType = z.infer<typeof DocumentType>

/**
 * Transaction classification. `loan_payment` (payment on a credit: installment, card, loan) was
 * added because `debt_service_monthly` could not be computed without it.
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

/** Transaction direction. The amount is always positive; the sign lives here. */
export const TransactionType = z.enum(['credit', 'debit'])
export type TransactionType = z.infer<typeof TransactionType>
