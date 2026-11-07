/**
 * Perfil crediticio: una entrada por feature del catálogo, cada una con valor, confianza,
 * verificación, procedencia y evidencia (docs/03 §3). El esquema se deriva del catálogo,
 * así que no puede haber una feature en el perfil que no exista en el catálogo ni al revés.
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

// Object.fromEntries pierde las llaves; el tipo se restituye desde el catálogo.
const shape = Object.fromEntries(Object.entries(FEATURE_CATALOG).map(([name, def]) => [name, featureValue(def.schema)])) as unknown as FeatureShape

export const ProfileFeatures = z.strictObject(shape).meta({ id: 'ProfileFeatures' })
export type ProfileFeatures = z.infer<typeof ProfileFeatures>
export type FeatureValue<K extends keyof FeatureCatalog> = ProfileFeatures[K]

export const ExternalSourceUse = z.strictObject({
  source: z.enum(['existing_credits', 'credit_bureau', 'tax_authority', 'program', 'internal']),
  simulated: z.boolean(),
  available: z.boolean(),
})

/** Parámetros con los que se calculó el perfil; se guardan con él para poder re-explicarlo. */
export const ProfileParameters = z
  .strictObject({
    low_balance_threshold: Money.describe('Umbral de saldo bajo para low_balance_days'),
    min_classification_confidence: Confidence.describe('Debajo de esto un movimiento clasificado cuenta como no clasificado'),
    debt_capacity_months: z.int().min(1).max(36).describe('Meses de flujo libre que soporta la línea: debt_capacity = flujo libre mensual × este número'),
  })
  .meta({ id: 'ProfileParameters' })
export type ProfileParameters = z.infer<typeof ProfileParameters>

export const Profile = z
  .strictObject({
    catalog_version: z.literal(FEATURE_CATALOG_VERSION),
    computed_at: IsoDateTime,
    inputs: z.strictObject({
      document_sha256: z.array(Sha256),
      request: ApplicationRequest.nullable().describe('La solicitud con la que se calculó: si no traía comprador y el dueño dijo su cliente principal, ese es el comprador (ver declarations)'),
      external: z.array(ExternalSourceUse),
      declarations: OwnerDeclarations.default(NO_DECLARATIONS).describe('Lo que el dueño declaró al aclarar (ADR 0050)'),
    }),
    parameters: ProfileParameters,
    features: ProfileFeatures,
  })
  .meta({ id: 'Profile', title: 'Perfil crediticio', description: 'Catálogo fijo de features (docs/03 §3)' })
export type Profile = z.infer<typeof Profile>
