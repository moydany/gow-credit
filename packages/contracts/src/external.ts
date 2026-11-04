/**
 * Lo que responden las fuentes externas del perfil (docs/03 §3, docs/06 §2 y §5, docs/09 §9):
 * créditos vigentes con el prestamista, buró, SAT, cupo del programa del comprador e
 * historial interno. Los adaptadores reales (fase 6) y los dobles simulados (escenarios)
 * producen la misma forma, así que el cálculo del perfil no sabe si está en simulación.
 *
 * Una fuente con `available: false` (sin adaptador, caída, sin datos para consultar) deja
 * sus features en `null`; nunca se rellena con un valor por defecto.
 */
import { z } from 'zod'
import { CFDI_SAT_STATUS, PriorApplication, SAT_LIST_STATUS } from './features.ts'
import { Count, IsoDate, LocalId, Money } from './primitives.ts'

/** Un crédito vigente del proveedor con este prestamista (adaptador `ExistingCredits`). */
export const ExistingCredit = z
  .strictObject({
    product: z.string().min(1),
    balance: Money.describe('Saldo insoluto'),
    monthly_payment: Money,
    days_past_due: Count,
    past_due_amount: Money.nullable().default(null).describe('Monto vencido; null si el core del prestamista no lo informa'),
  })
  .meta({ id: 'ExistingCredit' })
export type ExistingCredit = z.infer<typeof ExistingCredit>

/** Reporte de buró (adaptador `CreditBureau`). */
export const BureauReport = z
  .strictObject({
    score: z.int().nullable(),
    open_accounts: Count.nullable(),
    monthly_payments: Money.nullable().default(null).describe('Pagos mensuales a otras instituciones según buró'),
  })
  .meta({ id: 'BureauReport' })
export type BureauReport = z.infer<typeof BureauReport>

/** Situación del contribuyente ante el SAT (adaptador `TaxAuthority`). */
export const TaxpayerStatus = z
  .strictObject({
    rfc_valid: z.boolean().nullable(),
    compliance_opinion: z.enum(['positive', 'negative']).nullable().describe('Opinión de cumplimiento (32-D)'),
    list_status: z.enum(SAT_LIST_STATUS).nullable().describe('69-B y no localizados; null si no se consultó'),
  })
  .meta({ id: 'TaxpayerStatus' })
export type TaxpayerStatus = z.infer<typeof TaxpayerStatus>

/** Respuesta de "Verifica CFDI" para un UUID. */
export const CfdiCheck = z.strictObject({ uuid: z.string().min(1), status: z.enum(CFDI_SAT_STATUS) }).meta({ id: 'CfdiCheck' })
export type CfdiCheck = z.infer<typeof CfdiCheck>

/** RFC de una contraparte que aparece en una lista del SAT. */
export const ListedRfc = z.strictObject({ rfc: z.string().min(12).max(13), list_status: z.enum(SAT_LIST_STATUS) }).meta({ id: 'ListedRfc' })
export type ListedRfc = z.infer<typeof ListedRfc>

const sourceMeta = {
  available: z.boolean().describe('false si no hay adaptador, falló o faltan datos para consultar'),
  simulated: z.boolean(),
}

export const ExternalSnapshot = z
  .strictObject({
    existing_credits: z.strictObject({ ...sourceMeta, credits: z.array(ExistingCredit) }),
    credit_bureau: z.strictObject({ ...sourceMeta, report: BureauReport.nullable() }),
    tax_authority: z.strictObject({
      ...sourceMeta,
      taxpayer: TaxpayerStatus.nullable().describe('Del RFC del titular; null si no hay RFC completo'),
      cfdi: z.array(CfdiCheck).describe('Un resultado por UUID consultado; un UUID sin datos suficientes no se consulta'),
      listed_counterparties: z.array(ListedRfc).describe('RFC de contrapartes que aparecen en alguna lista'),
    }),
    program: z.strictObject({ ...sourceMeta, available_limit: Money.nullable().describe('Cupo disponible del programa del comprador') }),
    internal: z.strictObject({
      ...sourceMeta,
      prior_applications: z.array(PriorApplication),
      statement_reuse: z.array(z.strictObject({ uuid: z.string().min(1), application_id: LocalId })).describe('Otras solicitudes de este tenant con el mismo UUID'),
      seen_elsewhere: z
        .array(z.strictObject({ uuid: z.string().min(1), seen_on: IsoDate }))
        .describe('Índice de plataforma por HMAC(UUID): solo la fecha en que otro prestamista lo vio (docs/09 §9.2)'),
    }),
  })
  .meta({ id: 'ExternalSnapshot', title: 'Fuentes externas del perfil' })
export type ExternalSnapshot = z.infer<typeof ExternalSnapshot>
export type ExternalSnapshotInput = z.input<typeof ExternalSnapshot>

/** Ninguna fuente externa disponible: lo que ve `standalone` sin adaptadores. */
export function emptyExternalSnapshot(): ExternalSnapshot {
  const off = { available: false, simulated: false }
  return {
    existing_credits: { ...off, credits: [] },
    credit_bureau: { ...off, report: null },
    tax_authority: { ...off, taxpayer: null, cfdi: [], listed_counterparties: [] },
    program: { ...off, available_limit: null },
    internal: { ...off, prior_applications: [], statement_reuse: [], seen_elsewhere: [] },
  }
}
