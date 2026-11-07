/**
 * Tenant policy: a JSON document validated by a closed schema. It runs no code; it only composes
 * catalog features with known operators. A rule comparing a feature with an operator
 * incompatible with its type, a nonexistent feature or a line formula outside the grammar is
 * rejected at parse time, with the exact error path.
 *
 * Operators by feature type:
 *   int | money | ratio  ->  <  <=  >  >=  ==  !=   (numeric value)
 *   bool                 ->  ==  !=                 (boolean value)
 *   enum                 ->  in  not_in             (list of enum values)
 *   enum_list | record_list -> empty  not_empty     (no value)
 */
import { z } from 'zod'
import { FINAL_STATUS_RANK, FinalDecisionStatus } from './enums.ts'
import { describeFeatureType, FEATURE_CATALOG, featureEnumValues, featureKind, FeatureName, isNumericFeature } from './features.ts'
import { parseLimitFormula } from './limit-formula.ts'
import { Confidence, LocalId } from './primitives.ts'

export const ComparisonOp = z.enum(['<', '<=', '>', '>=', '==', '!='])
export const MembershipOp = z.enum(['in', 'not_in'])
export const EmptinessOp = z.enum(['empty', 'not_empty'])
export const ConditionOp = z.enum([...ComparisonOp.options, ...MembershipOp.options, ...EmptinessOp.options])
export type ConditionOp = z.infer<typeof ConditionOp>

/** What is asked of the supplier when a gate sends the request to clarification. */
export const AskTopic = z.enum([
  'recent_statement',
  'identity_fields',
  'deposit_classification',
  'reconciliation_gap',
  'additional_months',
  'missing_pages',
  // A statement that carries the holder address, if the policy requires it.
  'statement_with_address',
  // Doubtful charges, main client and account use.
  'charge_classification',
  'main_buyer',
  'account_use',
])
export type AskTopic = z.infer<typeof AskTopic>

const OPS_BY_KIND = {
  int: ComparisonOp.options,
  money: ComparisonOp.options,
  ratio: ComparisonOp.options,
  bool: ['==', '!='],
  enum: MembershipOp.options,
  enum_list: EmptinessOp.options,
  record_list: EmptinessOp.options,
} as const satisfies Record<string, readonly ConditionOp[]>

export const Condition = z
  .strictObject({
    feature: FeatureName,
    op: ConditionOp,
    value: z.union([z.number(), z.boolean(), z.array(z.string()).min(1)]).optional(),
  })
  .superRefine((c, ctx) => {
    const kind = featureKind(c.feature)
    const allowed: readonly string[] = OPS_BY_KIND[kind]
    if (!allowed.includes(c.op)) {
      ctx.addIssue({
        code: 'custom',
        path: ['op'],
        message: `el operador "${c.op}" no aplica a "${c.feature}", que es ${describeFeatureType(c.feature)}; para ese tipo usa ${allowed.map((o) => `"${o}"`).join(', ')}`,
      })
      return
    }
    if (kind === 'enum_list' || kind === 'record_list') {
      if (c.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: `"${c.op}" no lleva valor` })
      return
    }
    if (isNumericFeature(c.feature) && typeof c.value !== 'number') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `"${c.feature}" es ${kind}: el valor debe ser un número` })
      return
    }
    if (kind === 'bool' && typeof c.value !== 'boolean') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `"${c.feature}" es bool: el valor debe ser true o false` })
      return
    }
    if (kind === 'enum') {
      const values = featureEnumValues(c.feature) ?? []
      if (!Array.isArray(c.value)) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: `"${c.op}" necesita una lista de valores de ${values.join(', ')}` })
        return
      }
      c.value.forEach((v, i) => {
        if (!values.includes(v)) ctx.addIssue({ code: 'custom', path: ['value', i], message: `"${v}" no es un valor de "${c.feature}"; los valores son ${values.join(', ')}` })
      })
    }
  })
  .meta({ id: 'Condition' })
export type Condition = z.infer<typeof Condition>

export const Gate = z
  .strictObject({
    id: LocalId,
    description: z.string().optional(),
    when: Condition.describe('La compuerta pasa si la condición se cumple'),
    onFail: z.strictObject({
      status: z.enum(['needs_clarification', 'human_review', 'not_qualified']),
      ask: AskTopic.optional(),
    }),
    onUnknown: z.enum(['ask', 'pass', 'fail', 'human_review']).default('fail').describe('Qué hacer si la feature es desconocida (null)'),
  })
  .superRefine((g, ctx) => {
    if (g.onFail.status === 'needs_clarification' && g.onFail.ask === undefined) {
      ctx.addIssue({ code: 'custom', path: ['onFail', 'ask'], message: 'una compuerta que manda a needs_clarification debe decir qué preguntar (ask)' })
    }
    if (g.onFail.status !== 'needs_clarification' && g.onFail.ask !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['onFail', 'ask'], message: `ask solo aplica cuando status es needs_clarification, no ${g.onFail.status}` })
    }
    if (g.onUnknown === 'ask' && g.onFail.ask === undefined) {
      ctx.addIssue({ code: 'custom', path: ['onUnknown'], message: 'onUnknown "ask" requiere onFail.ask para saber qué preguntar' })
    }
  })
  .meta({ id: 'Gate' })
export type Gate = z.infer<typeof Gate>

export const Dimension = z
  .strictObject({
    id: LocalId,
    description: z.string().optional(),
    weight: z.number().positive().max(100),
    feature: FeatureName,
    relativeTo: FeatureName.optional().describe('Si existe, la dimensión mide feature / relativeTo'),
    zeroAt: z.number().describe('Valor (o razón) donde la dimensión da 0 puntos'),
    fullAt: z.number().describe('Valor (o razón) donde la dimensión da todos sus puntos'),
    inverse: z.boolean().default(false).describe('true si menos es mejor; exige zeroAt > fullAt'),
  })
  .superRefine((d, ctx) => {
    if (!isNumericFeature(d.feature)) {
      ctx.addIssue({ code: 'custom', path: ['feature'], message: `una dimensión necesita una feature numérica; "${d.feature}" es ${describeFeatureType(d.feature)}` })
    }
    if (d.relativeTo !== undefined && !isNumericFeature(d.relativeTo)) {
      ctx.addIssue({ code: 'custom', path: ['relativeTo'], message: `relativeTo necesita una feature numérica; "${d.relativeTo}" es ${describeFeatureType(d.relativeTo)}` })
    }
    if (d.zeroAt === d.fullAt) {
      ctx.addIssue({ code: 'custom', path: ['fullAt'], message: 'zeroAt y fullAt no pueden ser iguales' })
    } else if (d.inverse !== d.zeroAt > d.fullAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['inverse'],
        message: d.inverse ? 'inverse: true exige zeroAt > fullAt (menos es mejor)' : 'zeroAt > fullAt describe una dimensión inversa: agrega inverse: true o invierte los valores',
      })
    }
  })
  .meta({ id: 'Dimension' })
export type Dimension = z.infer<typeof Dimension>

const MoneyFeatureName = FeatureName.refine((f) => FEATURE_CATALOG[f].kind === 'money', {
  error: (iss) => `"${String(iss.input)}" no es de tipo money; el límite de una banda se calcula sobre un monto`,
})

export const Band = z
  .strictObject({
    min: z.number().min(0).max(100).describe('Puntaje mínimo (0 a 100) para caer en esta banda'),
    status: FinalDecisionStatus,
    limit: z.strictObject({ pctOf: MoneyFeatureName, pct: z.number().positive().max(100) }).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status !== 'not_qualified' && b.limit === undefined) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: `una banda ${b.status} necesita limit (pctOf y pct)` })
    }
    if (b.status === 'not_qualified' && b.limit !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'una banda not_qualified no lleva limit' })
    }
  })
  .meta({ id: 'Band' })
export type Band = z.infer<typeof Band>

export const Cap = z
  .strictObject({
    when: Condition.describe('Si la condición se cumple, el estado no puede ser mejor que maxStatus'),
    maxStatus: z.enum(['qualified_with_limit', 'not_qualified']),
  })
  .meta({ id: 'Cap' })
export type Cap = z.infer<typeof Cap>

export const DecisionRules = z
  .strictObject({
    bands: z.array(Band).min(1),
    caps: z.array(Cap).default([]),
    limitFormula: z.string().describe('min(band, ...) con términos band, feature o feature - feature (docs/03 §4)'),
  })
  .superRefine((d, ctx) => {
    d.bands.forEach((b, i) => {
      const prev = d.bands[i - 1]
      if (!prev) return
      if (b.min >= prev.min) {
        ctx.addIssue({ code: 'custom', path: ['bands', i, 'min'], message: `las bandas van de mayor a menor puntaje: ${String(b.min)} no es menor que ${String(prev.min)}` })
      }
      if (FINAL_STATUS_RANK[b.status] > FINAL_STATUS_RANK[prev.status]) {
        ctx.addIssue({ code: 'custom', path: ['bands', i, 'status'], message: `una banda de menor puntaje no puede dar un estado mejor (${b.status} después de ${prev.status})` })
      }
    })
    const last = d.bands.at(-1)
    if (last && last.min !== 0) {
      ctx.addIssue({ code: 'custom', path: ['bands', d.bands.length - 1, 'min'], message: 'la última banda debe empezar en 0 para que todo puntaje tenga banda' })
    }
    const formula = parseLimitFormula(d.limitFormula)
    if (!formula.ok) ctx.addIssue({ code: 'custom', path: ['limitFormula'], message: formula.error })
  })
  .meta({ id: 'DecisionRules' })

/** Months of statements evaluated: the most recent one, or the three most recent in a row (ADR 0072). */
export const HISTORY_MONTHS = [1, 3] as const
export type HistoryMonths = (typeof HISTORY_MONTHS)[number]
/** Id of the gate the engine adds when the policy evaluates more than one month. */
export const HISTORY_GATE_ID = 'history_months'

export const History = z
  .strictObject({
    months: z
      .literal(HISTORY_MONTHS)
      .describe('1: se evalúa solo el mes más reciente. 3: los tres meses más recientes, seguidos; si faltan o hay un hueco, se le piden al proveedor y por WhatsApp los manda juntos en un solo envío'),
  })
  .meta({ id: 'History' })
export type History = z.infer<typeof History>

export const Policy = z
  .strictObject({
    version: z.int().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    history: History.default({ months: 1 }).describe('Cuántos meses de estados de cuenta se evalúan'),
    gates: z.array(Gate),
    score: z.strictObject({
      dimensions: z.array(Dimension).min(1),
      minConfidence: Confidence.describe('Una feature con menor confianza no se usa en la dimensión'),
    }),
    decision: DecisionRules,
    clarification: z.strictObject({
      maxRounds: z.int().min(0).max(3).describe('Rondas de preguntas al proveedor; el producto usa 1'),
      askWhenAmountAbovePctOfIncome: z.number().min(0).max(1000).describe('Pregunta por abonos mayores a este % de los ingresos del periodo'),
    }),
  })
  .superRefine((p, ctx) => {
    const ids = new Map<string, string>()
    const claim = (id: string, path: (string | number)[]) => {
      const other = ids.get(id)
      if (other) ctx.addIssue({ code: 'custom', path, message: `id repetido "${id}" (ya se usa en ${other})` })
      else ids.set(id, path.join('.'))
    }
    p.gates.forEach((g, i) => {
      claim(g.id, ['gates', i, 'id'])
      if (g.id === HISTORY_GATE_ID) ctx.addIssue({ code: 'custom', path: ['gates', i, 'id'], message: `"${HISTORY_GATE_ID}" es la compuerta que agrega el motor con history.months; usa otro id` })
    })
    p.score.dimensions.forEach((d, i) => {
      claim(d.id, ['score', 'dimensions', i, 'id'])
    })
    const total = p.score.dimensions.reduce((s, d) => s + d.weight, 0)
    if (Math.abs(total - 100) > 1e-9) {
      ctx.addIssue({ code: 'custom', path: ['score', 'dimensions'], message: `los pesos de las dimensiones deben sumar 100 (suman ${String(total)})` })
    }
  })
  .meta({ id: 'Policy', title: 'Política de crédito del tenant', description: 'DSL cerrado validado contra el catálogo de features (docs/03 §4)' })
export type Policy = z.infer<typeof Policy>
/** What the tenant writes: fields with a default may be omitted. */
export type PolicyInput = z.input<typeof Policy>

export interface PolicyError {
  /** Readable path, e.g. `gates[1].when.op`. */
  path: string
  message: string
}

export type ParsePolicyResult = { ok: true; policy: Policy } | { ok: false; errors: PolicyError[]; message: string }

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[${String(key)}]` : acc ? `${acc}.${String(key)}` : String(key)), '')
}

/** Parses a policy and returns readable errors instead of throwing. */
export function parsePolicy(input: unknown): ParsePolicyResult {
  const res = Policy.safeParse(input)
  if (res.success) return { ok: true, policy: res.data }
  const errors = res.error.issues.map((i) => ({ path: formatPath(i.path) || '(raíz)', message: i.message }))
  return { ok: false, errors, message: `política inválida:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}` }
}
