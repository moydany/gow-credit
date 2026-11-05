/**
 * Escenario de docs/06: un mundo completo en un archivo YAML (tenant y política, proveedores,
 * documentos, fuentes externas, conversación y resultado esperado). El mismo archivo corre en
 * dos modos:
 *
 * - `unit` (fase 4): sin LLM ni base. Los documentos son estados de cuenta **sintéticos**
 *   (`statements`), generados en código con descripciones de banco; se clasifican con reglas,
 *   se calcula el perfil con los adaptadores simulados y se aplica la política.
 * - `full` (fase 6): los PDFs de `documents` pasan por el workflow real con caché de modelos.
 *
 * Nada de datos reales: nombres, RFC y montos de un escenario son inventados.
 */
import { z } from 'zod'
import { ApplicationStatus, DecisionStatus, Verification } from './enums.ts'
import { BureauReport, ExistingCredit } from './external.ts'
import { CFDI_SAT_STATUS, FeatureName, PriorApplication, SAT_LIST_STATUS } from './features.ts'
import { AskTopic } from './policy.ts'
import { IsoDate, LocalId, Money, SignedMoney } from './primitives.ts'
import { ApplicationRequest } from './request.ts'

/** Tipos de flujo sintético. Cada uno se convierte en movimientos con la descripción típica de un banco mexicano. */
export const SyntheticFlowKind = z.enum([
  // abonos
  'customer_payment',
  'sales_settlement',
  'cash_deposit',
  'unclassified_credit',
  'loan_disbursement',
  'own_transfer_in',
  'refund',
  'interest',
  // cargos
  'supplier_payment',
  'payroll',
  'tax',
  'fee',
  'loan_payment',
  'own_transfer_out',
  'cash_withdrawal',
  'card_purchase',
])
export type SyntheticFlowKind = z.infer<typeof SyntheticFlowKind>

export const SyntheticFlow = z.strictObject({
  kind: SyntheticFlowKind,
  amount: Money.refine((n) => n > 0, { error: 'el monto del flujo debe ser mayor a cero' }).describe('Total del mes; se reparte en `count` movimientos'),
  count: z.int().min(1).max(200).default(1),
  counterparty: z.string().min(1).optional().describe('Nombre que aparece en la descripción'),
  counterparty_rfc: z.string().optional(),
  description: z.string().min(1).optional().describe('Reemplaza la descripción generada'),
  verification: Verification.default('verified'),
  months: z.array(z.int().min(1)).optional().describe('Meses (desde 1) en que ocurre; todos si se omite'),
})
export type SyntheticFlow = z.infer<typeof SyntheticFlow>

export const SyntheticFiscal = z.strictObject({
  uuid: z.string().min(1),
  regime: z.string().min(3).describe('Régimen fiscal del receptor, por ejemplo "626"'),
  receiver_rfc: z.string().nullable().default(null),
  fees_match: z.boolean().default(true).describe('false: el subtotal del CFDI no cuadra con las comisiones'),
  certified_days_after_end: z.int().min(0).default(2),
})

export const SyntheticStatement = z.strictObject({
  bank: z.string().min(1).default('BANCO FICTICIO'),
  start: IsoDate.describe('Primer día del primer periodo'),
  months: z.int().min(1).max(24).default(1),
  periods: z.enum(['monthly', 'single']).default('monthly').describe('single: un periodo impreso para todos los meses, como Mercado Pago (ADR 0006)'),
  opening_balance: SignedMoney,
  monthly: z.array(SyntheticFlow).min(1),
  growth: z.number().min(-0.5).max(1).default(0).describe('Crecimiento mensual de los abonos de clientes'),
  holder_redacted: z.boolean().default(false).describe('true: nombre, RFC y CLABE en null, como los PDFs de desarrollo'),
  fiscal: SyntheticFiscal.nullable().default(null),
  reconciled: z.boolean().default(true),
})
export type SyntheticStatement = z.infer<typeof SyntheticStatement>

const BuyerInput = z.union([
  z.string().min(1).transform((name) => ({ name, rfc: null, aliases: [] })),
  z.strictObject({ name: z.string().min(1), rfc: z.string().nullable().default(null), aliases: z.array(z.string()).default([]) }),
])

export const ScenarioRequest = z
  .strictObject({
    amount: Money.nullable().default(null),
    maturity: IsoDate.nullable().default(null),
    buyer: BuyerInput.nullable().default(null),
  })
  .pipe(ApplicationRequest)

export const ScenarioSupplier = z.strictObject({
  id: LocalId,
  name: z.string().min(1),
  rfc: z.string().nullable().default(null),
  clabes: z.array(z.string()).default([]),
  contacts: z.array(z.strictObject({ channel: z.enum(['whatsapp', 'email']), address: z.string().min(1), verified: z.boolean() })).default([]),
  documents: z
    .array(z.string().min(1))
    .default([])
    .describe('Modo full: nombre de un PDF de data/dev, o adversarial:<id> para un PDF de la eval de inyección'),
  statements: z.array(SyntheticStatement).default([]).describe('Estados de cuenta sintéticos para el modo unit'),
  request: ScenarioRequest.nullable().default(null),
})
export type ScenarioSupplier = z.infer<typeof ScenarioSupplier>

const bySupplier = <T extends z.ZodType>(schema: T) => z.record(LocalId, schema).default({})

export const ScenarioExternal = z.strictObject({
  existing_credits: bySupplier(z.array(ExistingCredit)),
  bureau: bySupplier(BureauReport),
  sat: bySupplier(
    z.strictObject({
      rfc_valid: z.boolean().nullable().default(null),
      compliance_opinion: z.enum(['positive', 'negative']).nullable().default(null),
      list_status: z.enum(SAT_LIST_STATUS).nullable().default(null),
    }),
  ),
  cfdi: z.record(z.string(), z.enum(CFDI_SAT_STATUS)).default({}).describe('UUID → estado ante el SAT'),
  sat_lists: z.record(z.string(), z.enum(SAT_LIST_STATUS)).default({}).describe('RFC de contraparte → lista del SAT'),
  program: z.record(z.string(), Money).default({}).describe('Nombre del comprador → cupo disponible del programa'),
  history: bySupplier(
    z.strictObject({
      prior_applications: z.array(PriorApplication).default([]),
      statement_reuse: z.array(z.strictObject({ uuid: z.string().min(1), application_id: LocalId })).default([]),
      seen_elsewhere: z.array(z.strictObject({ uuid: z.string().min(1), days_ago: z.int().min(0) })).default([]),
    }),
  ),
})
export type ScenarioExternal = z.infer<typeof ScenarioExternal>

export const ScenarioExpect = z.strictObject({
  supplier: LocalId.optional().describe('Proveedor al que aplica; el primero si se omite'),
  status: DecisionStatus,
  limit: Money.nullable().optional(),
  limit_min: Money.optional(),
  limit_max: Money.optional(),
  reasons_include: z.array(z.string()).default([]),
  next_steps_include: z.array(FeatureName).default([]).describe('Features que deben aparecer en next_steps'),
  clarification_topics: z.array(AskTopic).optional(),
  features: z.partialRecord(FeatureName, z.json()).default({}).describe('Valores exactos de features del perfil'),
  full: z
    .strictObject({
      application_status: ApplicationStatus.optional(),
      inbound_resolutions: z.array(z.string()).optional().describe('Resolución de cada mensaje entrante, en orden'),
      isolated_from_other_tenant: z.boolean().optional().describe('Otro tenant no ve la solicitud ni sus datos'),
      extraction: z
        .strictObject({
          route: z.enum(['text_and_vision', 'vision_only']).optional(),
          transactions: z.int().min(0).optional(),
          flags_include: z.array(z.string()).default([]),
          amounts_absent: z.array(z.number()).default([]).describe('Montos que no deben aparecer en ningún movimiento (inyectados)'),
        })
        .optional(),
    })
    .optional()
    .describe('Expectativas que solo el modo full puede comprobar'),
})
export type ScenarioExpect = z.infer<typeof ScenarioExpect>

export const Scenario = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'id en kebab-case' }),
    catalog: z.int().min(1).optional().describe('Número del caso en docs/06 §4'),
    title: z.string().min(1),
    description: z.string().optional(),
    modes: z.array(z.enum(['unit', 'full'])).min(1),
    as_of: IsoDate.describe('Fecha del reloj simulado'),
    tenant: z.strictObject({
      name: z.string().min(1),
      policy: z.string().min(1).default('base').describe('base o ruta a un JSON de política desde la raíz del repo'),
      whatsapp_number: z.string().optional(),
    }),
    suppliers: z.array(ScenarioSupplier).min(1),
    external: ScenarioExternal.default({ existing_credits: {}, bureau: {}, sat: {}, cfdi: {}, sat_lists: {}, program: {}, history: {} }),
    conversation: z
      .array(
        z.strictObject({
          on_question: AskTopic,
          reply: z.string().min(1),
          after_minutes: z.int().min(0).optional(),
          from: z.string().min(3).optional().describe('Quién contesta; por defecto el WhatsApp verificado del proveedor'),
        }),
      )
      .default([]),
    expect: ScenarioExpect,
  })
  .superRefine((s, ctx) => {
    s.suppliers.forEach((sup, i) => {
      if (s.modes.includes('unit') && sup.statements.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['suppliers', i, 'statements'], message: 'el modo unit necesita estados de cuenta sintéticos (statements)' })
      }
      if (s.modes.includes('full') && sup.documents.length === 0 && sup.statements.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['suppliers', i, 'documents'], message: 'el modo full necesita documentos (PDFs) o estados de cuenta sintéticos' })
      }
    })
    if (s.expect.supplier !== undefined && !s.suppliers.some((sup) => sup.id === s.expect.supplier)) {
      ctx.addIssue({ code: 'custom', path: ['expect', 'supplier'], message: `proveedor desconocido "${s.expect.supplier}"` })
    }
  })
  .meta({ id: 'Scenario', title: 'Escenario de docs/06' })
export type Scenario = z.infer<typeof Scenario>
export type ScenarioInput = z.input<typeof Scenario>
