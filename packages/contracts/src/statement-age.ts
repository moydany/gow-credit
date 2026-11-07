/**
 * Maximum statement age, a tenant setting. In full mode it replaces the policy gates on
 * `document_age_days`: a statement older than the setting is analyzed anyway and the verdict
 * carries a warning. `null` means no limit, so no warning. Standalone has no tenant settings and
 * applies the policy as written.
 */
import { z } from 'zod'

/** A month counts as 30 days: 3 months is the 90 days of the template `doc_recent` gate. */
export const DAYS_PER_MONTH = 30

/** Tenant default: the same threshold as the base template, as a warning. */
export const DEFAULT_STATEMENT_MAX_AGE_MONTHS = 3

/** Options the backoffice offers; the API accepts any integer from 1 to 24. */
export const STATEMENT_MAX_AGE_OPTIONS = [1, 2, 3, 6, 12] as const

export const StatementMaxAgeMonths = z.int().min(1, 'Al menos 1 mes').max(24, 'Como máximo 24 meses').nullable().describe('Meses desde el corte más reciente; null = sin límite')
export type StatementMaxAgeMonths = z.infer<typeof StatementMaxAgeMonths>

/** What the worker passes to the workflow and engine. Absent (standalone): the policy decides alone. */
export const StatementAgeSetting = z.strictObject({ max_months: StatementMaxAgeMonths })
export type StatementAgeSetting = z.infer<typeof StatementAgeSetting>

/** Reason code of the warning in `Decision.reasons`: the backoffice and the explanation look for it. */
export const DOCUMENT_AGE_WARNING = 'document_age_warning'

export function statementMaxAgeDays(months: number): number {
  return months * DAYS_PER_MONTH
}

/** "3 meses", "1 mes". */
export function monthsText(months: number): string {
  return `${String(months)} ${months === 1 ? 'mes' : 'meses'}`
}
