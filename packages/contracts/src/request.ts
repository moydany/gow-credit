/**
 * Request data that is not in the PDF. Without it the output is max line and profile, not a full
 * verdict.
 */
import { z } from 'zod'
import { IsoDate, Money } from './primitives.ts'

export const ApplicationRequest = z
  .strictObject({
    amount: Money.refine((n) => n > 0, { error: 'el monto solicitado debe ser mayor a cero' }).nullable(),
    maturity: IsoDate.nullable().describe('Vencimiento de la factura o cuenta por cobrar'),
    buyer: z
      .strictObject({
        name: z.string().min(1).describe('Razón social o nombre comercial del comprador o cadena'),
        rfc: z.string().nullable(),
        aliases: z.array(z.string()).describe('Otros nombres con los que puede aparecer en el estado de cuenta'),
      })
      .nullable(),
  })
  .meta({ id: 'ApplicationRequest', title: 'Datos de la solicitud' })
export type ApplicationRequest = z.infer<typeof ApplicationRequest>

/** Registered identity of the supplier, against which `identity_match` is computed. */
export const SupplierIdentity = z
  .strictObject({
    legal_name: z.string().min(1),
    rfc: z.string().nullable(),
    clabes: z.array(z.string()),
  })
  .meta({ id: 'SupplierIdentity' })
export type SupplierIdentity = z.infer<typeof SupplierIdentity>

/**
 * Account use declared by the owner when the holder is a natural person: `business_only` for the
 * business alone; `mixed` also for personal expenses.
 */
export const AccountUse = z.enum(['business_only', 'mixed'])
export type AccountUse = z.infer<typeof AccountUse>

/**
 * What the owner declared while clarifying that is in neither the PDF nor the request. The profile
 * stores it with its provenance so the analyst knows what came from an answer.
 */
export const OwnerDeclarations = z
  .strictObject({
    buyer: z.string().min(1).nullable().describe('Cliente principal que dijo el dueño cuando la solicitud no traía comprador; se usa como comprador del análisis'),
    account_use: AccountUse.nullable().describe('Uso de la cuenta (persona física); null si no se preguntó o no contestó'),
    answered: z.array(z.enum(['main_buyer', 'account_use'])).default([]).describe('Temas ya preguntados y contestados, aunque sea con "no sé": no se vuelven a preguntar'),
  })
  .meta({ id: 'OwnerDeclarations', title: 'Declaraciones del dueño' })
export type OwnerDeclarations = z.infer<typeof OwnerDeclarations>

export const NO_DECLARATIONS: OwnerDeclarations = { buyer: null, account_use: null, answered: [] }
