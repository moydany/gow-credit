/**
 * Datos de la solicitud que no vienen en el PDF (docs/07 A, docs/06 §3). Sin ellos la
 * salida es línea máxima y perfil, no veredicto completo.
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

/** Identidad registrada del proveedor, contra la que se calcula `identity_match`. */
export const SupplierIdentity = z
  .strictObject({
    legal_name: z.string().min(1),
    rfc: z.string().nullable(),
    clabes: z.array(z.string()),
  })
  .meta({ id: 'SupplierIdentity' })
export type SupplierIdentity = z.infer<typeof SupplierIdentity>
