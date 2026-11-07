/**
 * Antigüedad máxima del estado de cuenta, ajuste del tenant (ADR 0049). En el modo full sustituye a
 * las compuertas de la política sobre `document_age_days`: un estado de cuenta más viejo que el
 * ajuste se analiza igual y el veredicto lleva una advertencia. `null` es "sin límite": no hay
 * advertencia. El modo standalone no tiene ajustes de tenant y aplica la política tal cual.
 */
import { z } from 'zod'

/** Un mes cuenta como 30 días: 3 meses son los 90 días de la compuerta `doc_recent` de la plantilla. */
export const DAYS_PER_MONTH = 30

/** Valor por defecto de un tenant: el mismo umbral que la plantilla base, como advertencia. */
export const DEFAULT_STATEMENT_MAX_AGE_MONTHS = 3

/** Opciones que ofrece el backoffice; la API acepta cualquier entero de 1 a 24. */
export const STATEMENT_MAX_AGE_OPTIONS = [1, 2, 3, 6, 12] as const

export const StatementMaxAgeMonths = z.int().min(1, 'Al menos 1 mes').max(24, 'Como máximo 24 meses').nullable().describe('Meses desde el corte más reciente; null = sin límite')
export type StatementMaxAgeMonths = z.infer<typeof StatementMaxAgeMonths>

/** Lo que el worker pasa al workflow y al motor. Ausente (standalone): la política decide sola. */
export const StatementAgeSetting = z.strictObject({ max_months: StatementMaxAgeMonths })
export type StatementAgeSetting = z.infer<typeof StatementAgeSetting>

/** Código del motivo de la advertencia en `Decision.reasons`: lo buscan el backoffice y la explicación. */
export const DOCUMENT_AGE_WARNING = 'document_age_warning'

export function statementMaxAgeDays(months: number): number {
  return months * DAYS_PER_MONTH
}

/** "3 meses", "1 mes". */
export function monthsText(months: number): string {
  return `${String(months)} ${months === 1 ? 'mes' : 'meses'}`
}
