/**
 * Engine verdict: not just the status but the full diagnosis to re-explain the decision, plus the
 * counterfactuals (`next_steps`) for the supplier. Numbers come from the engine; `next_steps`
 * text is written by Claude afterwards and filtered so it carries no figures absent from here.
 */
import { z } from 'zod'
import { DecisionStatus, FinalDecisionStatus } from './enums.ts'
import { FeatureName } from './features.ts'
import { AskTopic, ConditionOp } from './policy.ts'
import { Profile } from './profile.ts'
import { IsoDateTime, LocalId, Money, Sha256, SignedMoney } from './primitives.ts'

/** Why a feature was not used in a dimension or gate. */
export const ExclusionReason = z.enum(['unknown', 'low_confidence', 'unverified', 'conflict'])

export const GateEvaluation = z.strictObject({
  id: LocalId,
  feature: FeatureName,
  op: ConditionOp,
  threshold: z.json().describe('El valor de la regla'),
  value: z.json().describe('El valor de la feature en el perfil'),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  effect: z.enum(['none', 'needs_clarification', 'human_review', 'not_qualified']),
  ask: AskTopic.nullable(),
})
export type GateEvaluation = z.infer<typeof GateEvaluation>

export const DimensionEvaluation = z.strictObject({
  id: LocalId,
  feature: FeatureName,
  relative_to: FeatureName.nullable(),
  value: z.number().nullable().describe('Valor de la feature, o la razón feature / relativeTo'),
  normalized: z.number().min(0).max(1).nullable(),
  weight: z.number(),
  points: z.number().min(0),
  used: z.boolean(),
  excluded_reason: ExclusionReason.nullable(),
})

export const CapEvaluation = z.strictObject({
  index: z.int().min(0),
  feature: FeatureName,
  applied: z.boolean(),
  max_status: FinalDecisionStatus,
})

export const LimitEvaluation = z.strictObject({
  formula: z.string(),
  terms: z.array(z.strictObject({ term: z.string(), value: SignedMoney.nullable() })),
  value: Money.nullable().describe('Mínimo de los términos conocidos, nunca negativo'),
})

export const Reason = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).describe('Código estable, por ejemplo existing_exposure'),
  message: z.string().min(1).describe('Texto en español para el analista del tenant'),
  features: z.array(FeatureName),
})

/**
 * Status, score and line of an outcome, before (`from`) or after (`to`) a counterfactual. The line
 * is the engine `Decision.limit` for that profile: without it "qualifies with a limit" cannot be
 * told from "qualifies with a larger limit". `default(null)` lets stored decisions that predate
 * the field still parse.
 */
export const StatusAndScore = z.strictObject({
  status: DecisionStatus,
  score: z.number().min(0).max(100).nullable(),
  limit: Money.nullable().default(null).describe('Línea que da el motor en ese resultado; null si no califica'),
})

/** Another feature that moves together with the main one in a counterfactual (delay -> overdue amount). */
export const RelatedChange = z.strictObject({ feature: FeatureName, current_value: z.json(), target_value: z.json() })

/** Counterfactual: which change in a feature would move the outcome, computed on the same policy. */
export const NextStep = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  feature: FeatureName,
  current_value: z.json(),
  target_value: z.json(),
  related: z.array(RelatedChange).describe('Features que cambian junto con la principal; sus cifras también pueden aparecer en el texto'),
  from: StatusAndScore,
  to: StatusAndScore,
  message: z.string().nullable().describe('Redacción para el proveedor; null hasta que se redacta'),
})
export type NextStep = z.infer<typeof NextStep>

/** A document transaction; the id is only unique within its document. */
export const TransactionRef = z.strictObject({ document_sha256: Sha256, transaction_id: LocalId })
export type TransactionRef = z.infer<typeof TransactionRef>

export const Decision = z
  .strictObject({
    status: DecisionStatus,
    limit: Money.nullable(),
    score: z.number().min(0).max(100).nullable(),
    band: z.strictObject({ index: z.int().min(0), min: z.number(), status: FinalDecisionStatus }).nullable(),
    policy: z.strictObject({ id: z.string().nullable(), version: z.int().min(1) }),
    profile: Profile,
    evaluation: z.strictObject({
      gates: z.array(GateEvaluation),
      dimensions: z.array(DimensionEvaluation),
      caps: z.array(CapEvaluation),
      limit: LimitEvaluation.nullable(),
    }),
    reasons: z.array(Reason),
    next_steps: z.array(NextStep),
    explanation: z
      .strictObject({
        text: z.string().min(1).max(2000),
        text_source: z.enum(['template', 'writer']).describe('template: armada por el código; writer: redactada por Haiku y aceptada por el filtro de cifras'),
      })
      .nullable()
      .default(null)
      .describe('El resultado en lenguaje natural para quien revisa la solicitud. Las cifras salen de la decisión.'),
    clarification: z
      .strictObject({
        topics: z.array(AskTopic).min(1),
        issue_ids: z.array(LocalId).describe('Issues de la extracción que motivan la pregunta'),
        transactions: z.array(TransactionRef).describe('Movimientos sobre los que se pregunta: abonos y cargos grandes sin clasificar con confianza'),
      })
      .nullable(),
    engine_version: z.string(),
    decided_at: IsoDateTime,
  })
  .superRefine((d, ctx) => {
    if (d.status === 'needs_clarification' && d.clarification === null) {
      ctx.addIssue({ code: 'custom', path: ['clarification'], message: 'needs_clarification exige decir qué se pregunta' })
    }
    if ((d.status === 'qualified' || d.status === 'qualified_with_limit') && d.limit === null) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: `${d.status} exige una línea` })
    }
  })
  .meta({ id: 'Decision', title: 'Veredicto', description: 'Resultado del motor con diagnóstico y contrafactuales (docs/03 §6)' })
export type Decision = z.infer<typeof Decision>
