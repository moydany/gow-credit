/**
 * What the external profile sources return: existing credits with the lender, bureau, SAT, the
 * buyer program limit and internal history. Real adapters and simulated doubles produce the same
 * shape, so the profile calculation does not know whether it is simulating.
 *
 * A source with `available: false` (no adapter, down, nothing to look up) leaves its features
 * `null`; they are never filled with a default.
 */
import { z } from 'zod'
import { CFDI_SAT_STATUS, PriorApplication, SAT_LIST_STATUS } from './features.ts'
import { Count, IsoDate, LocalId, Money } from './primitives.ts'

/** An existing credit of the supplier with this lender (`ExistingCredits` adapter). */
export const ExistingCredit = z
  .strictObject({
    product: z.string().min(1),
    balance: Money.describe('Saldo insoluto'),
    monthly_payment: Money,
    days_past_due: Count,
    past_due_amount: Money.nullable().default(null).describe('Monto vencido; null si el core de la institución crediticia no lo informa'),
  })
  .meta({ id: 'ExistingCredit' })
export type ExistingCredit = z.infer<typeof ExistingCredit>

/** Bureau report (`CreditBureau` adapter). */
export const BureauReport = z
  .strictObject({
    score: z.int().nullable(),
    open_accounts: Count.nullable(),
    monthly_payments: Money.nullable().default(null).describe('Pagos mensuales a otras instituciones según buró'),
  })
  .meta({ id: 'BureauReport' })
export type BureauReport = z.infer<typeof BureauReport>

/** Taxpayer status with the SAT (`TaxAuthority` adapter). */
export const TaxpayerStatus = z
  .strictObject({
    rfc_valid: z.boolean().nullable(),
    compliance_opinion: z.enum(['positive', 'negative']).nullable().describe('Opinión de cumplimiento (32-D)'),
    list_status: z.enum(SAT_LIST_STATUS).nullable().describe('69-B y no localizados; null si no se consultó'),
  })
  .meta({ id: 'TaxpayerStatus' })
export type TaxpayerStatus = z.infer<typeof TaxpayerStatus>

/** "Verifica CFDI" response for a UUID. */
export const CfdiCheck = z.strictObject({ uuid: z.string().min(1), status: z.enum(CFDI_SAT_STATUS) }).meta({ id: 'CfdiCheck' })
export type CfdiCheck = z.infer<typeof CfdiCheck>

/** RFC of a counterparty found on a SAT list. */
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
        .describe('Índice de plataforma por HMAC(UUID): solo la fecha en que otra institución crediticia lo vio (docs/09 §9.2)'),
    }),
  })
  .meta({ id: 'ExternalSnapshot', title: 'Fuentes externas del perfil' })
export type ExternalSnapshot = z.infer<typeof ExternalSnapshot>
export type ExternalSnapshotInput = z.input<typeof ExternalSnapshot>

/** No external source available: what `standalone` sees without adapters. */
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
