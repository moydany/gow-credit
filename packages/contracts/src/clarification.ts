/**
 * Aclaración con el dueño del documento (docs/03 §7, docs/04 §4). El motor dice qué temas
 * preguntar (`Decision.clarification`); aquí viven la pregunta ya redactada, con los hechos
 * que puede citar, y la respuesta estructurada que la reanuda.
 *
 * Los hechos son la única fuente de cifras de la pregunta: un texto generado que cite un número
 * o una fecha que no esté en `facts` se descarta (filtro de cifras de docs/04 §4).
 */
import { z } from 'zod'
import { TransactionCategory } from './enums.ts'
import { AskTopic } from './policy.ts'
import { TransactionRef } from './decision.ts'
import { LocalId } from './primitives.ts'
import { AccountUse } from './request.ts'

/**
 * Qué forma tiene la respuesta: un abono o un cargo a clasificar, el cliente principal (texto
 * libre), el uso de la cuenta, datos de identidad o documentos nuevos.
 */
export const QuestionKind = z.enum(['deposit', 'charge', 'buyer', 'account_use', 'identity', 'documents'])
export type QuestionKind = z.infer<typeof QuestionKind>

/** Dato que la pregunta puede citar. */
export const QuestionFact = z.strictObject({
  name: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})
export type QuestionFact = z.infer<typeof QuestionFact>

/** Lo que el dueño puede decir que es un abono. */
export const DepositAnswerCategory = TransactionCategory.extract(['customer_payment', 'loan_disbursement', 'own_transfer', 'interest', 'other'])
export type DepositAnswerCategory = z.infer<typeof DepositAnswerCategory>

/**
 * Lo que el dueño puede decir que es un cargo (ADR 0050). `personal_expense` se guarda como `other`:
 * sigue siendo salida de dinero (ver ADR), pero no es pago de crédito.
 */
export const ChargeAnswerCategory = z.enum(['loan_payment', 'supplier_payment', 'own_transfer', 'personal_expense', 'other'])
export type ChargeAnswerCategory = z.infer<typeof ChargeAnswerCategory>

export const Question = z
  .strictObject({
    id: LocalId.describe('q1, q2...: único dentro de la solicitud'),
    topic: AskTopic,
    kind: QuestionKind,
    transaction: TransactionRef.nullable().describe('El abono o cargo sobre el que se pregunta (kind deposit o charge)'),
    facts: z.array(QuestionFact),
    options: z.array(z.strictObject({ value: z.string(), label: z.string() })).describe('Respuestas posibles cuando son cerradas'),
    text: z.string().min(1).describe('Texto para el proveedor, en español'),
    text_source: z.enum(['writer', 'template']).describe('writer: redactado por el modelo y filtrado; template: plantilla del código'),
  })
  .meta({ id: 'Question', title: 'Pregunta al proveedor' })
export type Question = z.infer<typeof Question>

const nullableText = z.string().trim().min(1).nullable().default(null)

export const OwnerAnswer = z
  .discriminatedUnion('kind', [
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('deposit'),
      category: DepositAnswerCategory,
      counterparty: nullableText.describe('Quién hizo el depósito, si el dueño lo dice'),
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('charge'),
      category: ChargeAnswerCategory,
      counterparty: nullableText.describe('A quién se le pagó, si el dueño lo dice'),
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('buyer'),
      name: z.string().trim().min(3).max(200).describe('Cliente principal: la empresa que paga las facturas que se quieren adelantar'),
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('account_use'),
      use: AccountUse,
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('identity'),
      legal_name: nullableText,
      rfc: nullableText,
      clabe: nullableText,
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('documents'),
      paths: z.array(z.string().min(1)).min(1).describe('PDFs nuevos: rutas relativas al archivo de respuestas'),
    }),
    z.strictObject({
      question_id: LocalId,
      kind: z.literal('decline'),
      note: nullableText,
    }),
  ])
  .meta({ id: 'OwnerAnswer', title: 'Respuesta del dueño del documento' })
export type OwnerAnswer = z.infer<typeof OwnerAnswer>

/** `pnpm run evaluate --answers <archivo>`: respuestas por solicitud (el nombre del PDF sin extensión). */
export const AnswersFile = z
  .strictObject({
    version: z.literal(1),
    applications: z.record(
      z.string().min(1),
      z.strictObject({
        round: z.int().min(1).optional().describe('Ronda que contestan (la escribe answers.template.json). Si la solicitud está pausada en otra ronda, no se aplican: los ids q1, q2... se repiten entre rondas'),
        answers: z.array(OwnerAnswer),
      }),
    ),
  })
  .meta({ id: 'AnswersFile', title: 'Archivo de respuestas', description: 'Respuestas del dueño para reanudar solicitudes pausadas en modo standalone' })
export type AnswersFile = z.infer<typeof AnswersFile>
