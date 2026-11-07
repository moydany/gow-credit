/**
 * Perfil crediticio (docs/03 §3): las features del catálogo calculadas desde los estados de
 * cuenta, la solicitud y las fuentes externas. Puro y determinístico: la fecha de cálculo
 * entra como parámetro y es el reloj de `document_age_days`.
 */
import {
  emptyExternalSnapshot,
  FEATURE_CATALOG_VERSION,
  FEATURE_NAMES,
  NO_DECLARATIONS,
  Profile,
  type ApplicationRequest,
  type OwnerDeclarations,
  type ExternalSnapshot,
  type ProfileParameters,
  type StatementExtraction,
  type SupplierIdentity,
} from '@gow/contracts'
import { unknown, type Entries } from './features/entry.ts'
import { externalFeatures } from './features/external.ts'
import { statementFeatures, type Coverage } from './features/statement.ts'
import { buildLedger, type Ledger } from './ledger.ts'
import { toDay } from './util/dates.ts'

export const DEFAULT_PROFILE_PARAMETERS: ProfileParameters = {
  low_balance_threshold: 1000,
  min_classification_confidence: 0.7,
  debt_capacity_months: 3,
}

export interface ProfileInput {
  statements: readonly StatementExtraction[]
  request: ApplicationRequest | null
  supplier: SupplierIdentity | null
  external?: ExternalSnapshot
  parameters?: Partial<ProfileParameters>
  /** Fecha y hora de cálculo (ISO con zona); su fecha es el "hoy" del perfil. */
  computedAt: string
  /** Lo que el dueño declaró al aclarar: cliente principal y uso de la cuenta (ADR 0050). */
  declarations?: OwnerDeclarations
}

/**
 * La solicitud con la que se calcula: si no trae comprador y el dueño dijo su cliente principal,
 * ese es el comprador del análisis (sin RFC ni alias: se reconoce por nombre en el estado de cuenta).
 */
export function effectiveRequest(request: ApplicationRequest | null, declarations: OwnerDeclarations | undefined): ApplicationRequest | null {
  const buyer = declarations?.buyer ?? null
  if (buyer === null || request?.buyer) return request
  return { amount: request?.amount ?? null, maturity: request?.maturity ?? null, buyer: { name: buyer, rfc: null, aliases: [] } }
}

export interface ProfileResult {
  profile: Profile
  ledger: Ledger
  coverage: Coverage
}

export function buildProfileWithLedger(input: ProfileInput): ProfileResult {
  const params: ProfileParameters = { ...DEFAULT_PROFILE_PARAMETERS, ...input.parameters }
  const external = input.external ?? emptyExternalSnapshot()
  const asOfDay = toDay(input.computedAt.slice(0, 10))
  const declarations = input.declarations ?? NO_DECLARATIONS
  const request = effectiveRequest(input.request, declarations)
  const ledger = buildLedger(input.statements, { request, minConfidence: params.min_classification_confidence, accountUse: declarations.account_use })

  const st = statementFeatures({ ledger, request, supplier: input.supplier, params, asOfDay, buyerDeclared: request?.buyer != null && input.request?.buyer == null })
  const ex = externalFeatures({ snapshot: external, request, ledger, statement: st.entries, minConfidence: params.min_classification_confidence, asOfDay })
  const entries: Entries = { ...st.entries, ...ex }

  const noDocs = ledger.documents.length === 0 ? `sin estados de cuenta utilizables${ledger.skipped.length > 0 ? `: ${ledger.skipped.join('; ')}` : ''}` : 'no calculada'
  const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, entries[name] ?? unknown(noDocs)]))

  const profile = Profile.parse({
    catalog_version: FEATURE_CATALOG_VERSION,
    computed_at: input.computedAt,
    inputs: {
      document_sha256: ledger.documents.map((d) => d.sha256),
      request,
      external: (['existing_credits', 'credit_bureau', 'tax_authority', 'program', 'internal'] as const).map((source) => ({
        source,
        simulated: external[source].simulated,
        available: external[source].available,
      })),
      declarations,
    },
    parameters: params,
    features,
  })
  return { profile, ledger, coverage: st.coverage }
}

export function buildProfile(input: ProfileInput): Profile {
  return buildProfileWithLedger(input).profile
}
