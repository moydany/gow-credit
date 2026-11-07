/**
 * Credit profile: one entry per catalog feature, each with value, confidence, verification,
 * provenance and evidence. The schema derives from the catalog, so the profile cannot hold a
 * feature missing from the catalog or the reverse.
 */
import { z } from 'zod'
import { Provenance, Verification } from './enums.ts'
import { FEATURE_CATALOG, FEATURE_CATALOG_VERSION, type FeatureCatalog } from './features.ts'
import { ApplicationRequest, NO_DECLARATIONS, OwnerDeclarations } from './request.ts'
import { Confidence, IsoDateTime, Money, Sha256 } from './primitives.ts'

const featureMeta = {
  confidence: Confidence,
  verification: Verification,
  provenance: Provenance,
  evidence: z.array(z.string()).describe('Ids de movimientos o JSON Pointers que sustentan el valor'),
  note: z.string().nullable().describe('Por qué es desconocido o cómo se calculó, para el analista'),
}

function featureValue<T extends z.ZodType>(schema: T) {
  return z.strictObject({ value: schema.nullable().describe('null = desconocido'), ...featureMeta })
}

type FeatureValueSchema<T extends z.ZodType> = z.ZodObject<{ value: z.ZodNullable<T> } & typeof featureMeta, z.core.$strict>
type FeatureShape = { [K in keyof FeatureCatalog]: FeatureValueSchema<FeatureCatalog[K]['schema']> }

/** Catalog versions this contract reads: the current one and earlier ones whose profiles are still stored. */
export const READABLE_CATALOG_VERSIONS = ['1.1.0', '1.2.0', FEATURE_CATALOG_VERSION] as const
/**
 * Features missing from an earlier catalog (1.2.0: pages and signals; 1.3.0: address): a stored
 * profile without them reads them as unknown.
 */
const ADDED_AFTER_1_1_0: ReadonlySet<string> = new Set(['document_pages_missing', 'document_tamper_signals', 'holder_address_present'])
const notInOlderCatalog = () => ({ value: null, confidence: 0, verification: 'unverified' as const, provenance: 'extracted' as const, evidence: [] as string[], note: 'perfil calculado con un catálogo anterior: la feature no existía' })

// Object.fromEntries loses the keys; the type is restored from the catalog.
const shape = Object.fromEntries(
  Object.entries(FEATURE_CATALOG).map(([name, def]) => {
    const entry = featureValue(def.schema)
    return [name, ADDED_AFTER_1_1_0.has(name) ? entry.default(notInOlderCatalog) : entry]
  }),
) as unknown as FeatureShape

export const ProfileFeatures = z.strictObject(shape).meta({ id: 'ProfileFeatures' })
export type ProfileFeatures = z.infer<typeof ProfileFeatures>
export type FeatureValue<K extends keyof FeatureCatalog> = ProfileFeatures[K]

export const ExternalSourceUse = z.strictObject({
  source: z.enum(['existing_credits', 'credit_bureau', 'tax_authority', 'program', 'internal']),
  simulated: z.boolean(),
  available: z.boolean(),
})

/** Parameters the profile was computed with; stored with it so it can be re-explained. */
export const ProfileParameters = z
  .strictObject({
    low_balance_threshold: Money.describe('Umbral de saldo bajo para low_balance_days'),
    min_classification_confidence: Confidence.describe('Debajo de esto un movimiento clasificado cuenta como no clasificado'),
    debt_capacity_months: z.int().min(1).max(36).describe('Meses de flujo libre que soporta la línea: debt_capacity = flujo libre mensual × este número'),
    evaluation_months: z.int().min(1).max(12).default(1).describe('Meses que se evalúan, contados hacia atrás desde el corte más reciente (history.months de la política, ADR 0072); lo anterior no entra al perfil'),
  })
  .meta({ id: 'ProfileParameters' })
export type ProfileParameters = z.infer<typeof ProfileParameters>

export const Profile = z
  .strictObject({
    catalog_version: z.enum(READABLE_CATALOG_VERSIONS).describe('Versión del catálogo con la que se calculó; las features que no existían entonces quedan desconocidas'),
    computed_at: IsoDateTime,
    inputs: z.strictObject({
      document_sha256: z.array(Sha256),
      request: ApplicationRequest.nullable().describe('La solicitud con la que se calculó: si no traía comprador y el dueño dijo su cliente principal, ese es el comprador (ver declarations)'),
      external: z.array(ExternalSourceUse),
      declarations: OwnerDeclarations.default(NO_DECLARATIONS).describe('Lo que el dueño declaró al aclarar'),
    }),
    parameters: ProfileParameters,
    features: ProfileFeatures,
  })
  .meta({ id: 'Profile', title: 'Perfil crediticio', description: 'Catálogo fijo de features (docs/03 §3)' })
export type Profile = z.infer<typeof Profile>
