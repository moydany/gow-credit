import type { ApplicationRequest, ProfileParameters, SupplierIdentity } from '@gow/contracts'
import type { Ledger } from '../ledger.ts'

export interface StatementContext {
  ledger: Ledger
  request: ApplicationRequest | null
  supplier: SupplierIdentity | null
  params: ProfileParameters
  asOfDay: number
  /** The buyer was stated by the owner when clarifying; the request had none. */
  buyerDeclared?: boolean
}
