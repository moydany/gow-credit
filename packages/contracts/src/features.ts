/**
 * Catálogo fijo de features del perfil crediticio (docs/03 §3 y docs/06 §5). Es la única
 * fuente de verdad de qué features existen, de qué tipo son y de dónde salen. De aquí se
 * derivan el esquema del perfil y la validación de la política: una regla que compara una
 * feature con un operador incompatible con su tipo se rechaza al parsear la política.
 *
 * Un valor desconocido se representa siempre como `value: null` en el perfil. Por eso los
 * enums no incluyen `unknown` (docs/03 lo lista en `identity_match`; aquí es `null`).
 */
import { z } from 'zod'
import { IsoDate, LocalId, Money, Ratio, SignedMoney } from './primitives.ts'

/** De dónde sale una feature. */
export const FeatureSource = z.enum(['statement', 'request', 'existing_credits', 'credit_bureau', 'tax_authority', 'program', 'internal'])
export type FeatureSource = z.infer<typeof FeatureSource>

export const IDENTITY_MATCH = ['match', 'partial', 'mismatch'] as const
export const RED_FLAGS = ['overdraft', 'returned_check', 'garnishment', 'judicial_order', 'tax_requirement'] as const
export const SAT_STATUS = ['compliant', 'non_compliant'] as const
/** Claves de régimen fiscal del SAT que acepta `fiscal_regime` (docs/09 §5); otra clave es `other`. */
export const FISCAL_REGIMES = ['601', '603', '605', '606', '607', '608', '610', '611', '612', '614', '615', '616', '620', '621', '622', '623', '624', '625', '626', 'other'] as const
/** Estado del CFDI ante el servicio "Verifica CFDI" del SAT (docs/09 §6). Faltan datos → null, nunca not_found. */
export const CFDI_SAT_STATUS = ['valid', 'cancelled', 'not_found'] as const
/** Situación del RFC del titular en las listas públicas del SAT: 69-B (EFOS) y no localizados (docs/09 §9.4). */
export const SAT_LIST_STATUS = ['clear', 'efos_presumed', 'efos_definitive', 'not_located'] as const

export const PriorApplication = z
  .strictObject({
    application_id: LocalId,
    submitted_on: IsoDate,
    status: z.enum(['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review', 'failed']),
    same_document: z.boolean().describe('Mismo hash de documento que la solicitud actual'),
  })
  .meta({ id: 'PriorApplication' })

interface Meta {
  readonly source: FeatureSource
  readonly unit: 'months' | 'days' | 'count' | 'MXN' | 'ratio' | 'score' | 'none'
  readonly description: string
}

const int = (meta: Meta) => ({ kind: 'int', schema: z.int(), ...meta }) as const
const money = (meta: Meta) => ({ kind: 'money', schema: Money, ...meta }) as const
const signedMoney = (meta: Meta) => ({ kind: 'money', schema: SignedMoney, ...meta }) as const
const ratio = (meta: Meta) => ({ kind: 'ratio', schema: Ratio, ...meta }) as const
const bool = (meta: Meta) => ({ kind: 'bool', schema: z.boolean(), ...meta }) as const
const enumOf = <const V extends readonly [string, ...string[]]>(values: V, meta: Meta) =>
  ({ kind: 'enum', values, schema: z.enum(values), ...meta }) as const
const enumList = <const V extends readonly [string, ...string[]]>(values: V, meta: Meta) =>
  ({ kind: 'enum_list', values, schema: z.array(z.enum(values)), ...meta }) as const

export const FEATURE_CATALOG = {
  months_of_history: int({ source: 'statement', unit: 'months', description: 'Meses completos cubiertos por los documentos' }),
  document_age_days: int({ source: 'statement', unit: 'days', description: 'Días desde la fecha de corte más reciente' }),
  identity_match: enumOf(IDENTITY_MATCH, { source: 'statement', unit: 'none', description: 'Titular, RFC y CLABE contra el proveedor registrado' }),
  integrity_ok: bool({ source: 'statement', unit: 'none', description: 'Saldo inicial + abonos − cargos = saldo final y movimientos = totales' }),
  red_flags: enumList(RED_FLAGS, { source: 'statement', unit: 'none', description: 'Señales graves vistas en el estado de cuenta' }),
  activity_count: int({ source: 'statement', unit: 'count', description: 'Movimientos en el periodo' }),
  operating_income_monthly: money({ source: 'statement', unit: 'MXN', description: 'Abonos clasificados como pago de cliente, promedio mensual' }),
  operating_expenses_monthly: money({ source: 'statement', unit: 'MXN', description: 'Cargos operativos (proveedores, nómina, impuestos, comisiones), promedio mensual' }),
  debt_service_monthly: money({ source: 'statement', unit: 'MXN', description: 'Pagos a créditos, promedio mensual' }),
  new_debt_in_period: money({ source: 'statement', unit: 'MXN', description: 'Préstamos recibidos en el periodo' }),
  free_cash_flow_monthly: signedMoney({ source: 'statement', unit: 'MXN', description: 'Ingresos operativos − gastos operativos − servicio de deuda' }),
  payment_capacity_pct: ratio({ source: 'statement', unit: 'ratio', description: 'Flujo libre / ingresos operativos ("capacidad de pago")' }),
  debt_capacity: money({ source: 'statement', unit: 'MXN', description: 'Línea que el flujo libre soporta ("capacidad de endeudamiento")' }),
  avg_daily_balance: signedMoney({ source: 'statement', unit: 'MXN', description: 'Saldo promedio diario' }),
  low_balance_days: int({ source: 'statement', unit: 'days', description: 'Días con saldo bajo el umbral configurado' }),
  income_trend: ratio({ source: 'statement', unit: 'ratio', description: 'Pendiente de ingresos mes a mes; requiere 3+ meses' }),
  buyer_payments_count: int({ source: 'statement', unit: 'count', description: 'Pagos del comprador identificados' }),
  buyer_payments_amount: money({ source: 'statement', unit: 'MXN', description: 'Monto de pagos del comprador identificados' }),
  recurring_income_share: ratio({ source: 'statement', unit: 'ratio', description: 'Parte de los ingresos marcada como recurrente' }),
  top_payer_concentration: ratio({ source: 'statement', unit: 'ratio', description: 'Participación del mayor pagador en los ingresos' }),
  existing_exposure_balance: money({ source: 'existing_credits', unit: 'MXN', description: 'Saldo de créditos vigentes con este prestamista' }),
  existing_exposure_days_past_due: int({ source: 'existing_credits', unit: 'days', description: 'Días de atraso en créditos vigentes con este prestamista' }),
  existing_exposure_payment_ratio: ratio({ source: 'existing_credits', unit: 'ratio', description: 'Cuota vigente / flujo libre' }),
  existing_exposure_past_due_amount: money({ source: 'existing_credits', unit: 'MXN', description: 'Monto vencido en créditos vigentes con este prestamista: lo que hay que pagar para quedar al corriente' }),
  external_debt_signal: money({ source: 'statement', unit: 'MXN', description: 'Préstamos recibidos y pagos a otras instituciones; buró los confirma cuando exista' }),
  program_available_limit: money({ source: 'program', unit: 'MXN', description: 'Cupo disponible del programa del comprador, configurado por el tenant' }),
  prior_applications: { kind: 'record_list', schema: z.array(PriorApplication), source: 'internal', unit: 'none', description: 'Solicitudes previas del proveedor con este tenant' } as const,
  requested_amount: money({ source: 'request', unit: 'MXN', description: 'Monto solicitado; null si la solicitud no lo trae' }),
  buro_score: int({ source: 'credit_bureau', unit: 'score', description: 'Score de buró; null mientras no exista el adaptador' }),
  sat_status: enumOf(SAT_STATUS, { source: 'tax_authority', unit: 'none', description: 'Opinión de cumplimiento del SAT; null mientras no exista el adaptador' }),
  // Catálogo 1.1.0: el bloque fiscal (CFDI) como ancla (docs/09 §5 y §9).
  fiscal_regime: enumOf(FISCAL_REGIMES, { source: 'statement', unit: 'none', description: 'Régimen fiscal del receptor del CFDI del estado de cuenta; null si no hay CFDI o no lo imprime' }),
  cfdi_sat_status: enumOf(CFDI_SAT_STATUS, { source: 'tax_authority', unit: 'none', description: 'Estado del CFDI ante el SAT; el peor de los comprobantes; null si no se consultó o faltan datos' }),
  fiscal_anchor_ok: bool({ source: 'statement', unit: 'none', description: 'Comisiones e IVA del CFDI (firmado por el SAT) contra las filas de comisión del estado de cuenta' }),
  statement_reuse_count: int({ source: 'internal', unit: 'count', description: 'Otras solicitudes de este tenant con el mismo UUID de CFDI' }),
  statement_seen_elsewhere_days: int({ source: 'internal', unit: 'days', description: 'Días desde que otro prestamista vio el mismo UUID; null si nunca' }),
  sat_list_status: enumOf(SAT_LIST_STATUS, { source: 'tax_authority', unit: 'none', description: 'Situación del RFC del titular en las listas 69-B y de no localizados' }),
  income_from_listed_rfc_share: ratio({ source: 'tax_authority', unit: 'ratio', description: 'Parte de los ingresos operativos que viene de pagadores en 69-B definitivo' }),
  regime_income_plausible: bool({ source: 'statement', unit: 'none', description: 'Ingresos anualizados dentro del tope del régimen (RESICO 626: 3.5 millones)' }),
} as const

export type FeatureCatalog = typeof FEATURE_CATALOG
export type FeatureName = keyof FeatureCatalog
export type FeatureKind = FeatureCatalog[FeatureName]['kind']

export const FEATURE_NAMES = Object.keys(FEATURE_CATALOG) as [FeatureName, ...FeatureName[]]

/** Versión del catálogo: sube cuando se agrega, quita o cambia una feature. */
export const FEATURE_CATALOG_VERSION = '1.1.0'

export const FeatureName = z.enum(FEATURE_NAMES, {
  error: (issue) => `feature desconocida ${JSON.stringify(issue.input)}; el catálogo (docs/03 §3) no la tiene`,
})

export const NUMERIC_KINDS = ['int', 'money', 'ratio'] as const
export type NumericKind = (typeof NUMERIC_KINDS)[number]

export function featureKind(name: FeatureName): FeatureKind {
  return FEATURE_CATALOG[name].kind
}

export function isNumericFeature(name: FeatureName): boolean {
  return (NUMERIC_KINDS as readonly string[]).includes(featureKind(name))
}

/** Valores permitidos de una feature `enum` o `enum_list`; `null` para las demás. */
export function featureEnumValues(name: FeatureName): readonly string[] | null {
  const def = FEATURE_CATALOG[name]
  return 'values' in def ? def.values : null
}

/** Descripción del tipo para mensajes de error ("enum (match, partial, mismatch)"). */
export function describeFeatureType(name: FeatureName): string {
  const values = featureEnumValues(name)
  const kind = featureKind(name)
  return values ? `${kind} (${values.join(', ')})` : kind
}
