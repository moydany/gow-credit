import type { ApplicationRequest, ProfileParameters, SupplierIdentity } from '@gow/contracts'
import type { Ledger } from '../ledger.ts'

export interface StatementContext {
  ledger: Ledger
  request: ApplicationRequest | null
  supplier: SupplierIdentity | null
  params: ProfileParameters
  asOfDay: number
  /** El comprador lo dijo el dueño al aclarar; la solicitud no lo traía (ADR 0050). */
  buyerDeclared?: boolean
}
