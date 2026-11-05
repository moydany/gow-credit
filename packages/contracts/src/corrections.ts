/**
 * Correcciones del analista en revisión humana (docs/08 §2). Cada una es un par (valor leído,
 * valor correcto) sobre un valor concreto de la extracción, con su página: es lo que alimenta el
 * dataset de evals. El conjunto de blancos es cerrado, no un JSON Pointer libre: solo se corrige
 * lo que el motor usa (titular, CLABE, cifras del resumen y movimientos) y el servidor sabe
 * recalcular el cuadre después.
 */
import { z } from 'zod'
import { IsoDate, LocalId, Money, SignedMoney } from './primitives.ts'
import { TransactionType } from './enums.ts'

export const HolderCorrectionField = z.enum(['name', 'rfc', 'holder_type'])
export const AccountCorrectionField = z.enum(['clabe', 'account_number'])
export const PeriodCorrectionField = z.enum(['opening_balance', 'closing_balance', 'total_credits', 'total_debits', 'credits_count', 'debits_count'])
export const TransactionCorrectionField = z.enum(['amount', 'type', 'date'])

export const CorrectionTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('holder'), field: HolderCorrectionField }),
  z.strictObject({ kind: z.literal('account'), account_id: LocalId, field: AccountCorrectionField }),
  z.strictObject({ kind: z.literal('period'), period_id: LocalId, field: PeriodCorrectionField }),
  z.strictObject({ kind: z.literal('transaction'), transaction_id: LocalId, field: TransactionCorrectionField }),
])
export type CorrectionTarget = z.infer<typeof CorrectionTarget>

export const CorrectionValue = z.union([z.string().trim().min(1).max(200), z.number()])

/** Lo que el navegador manda: el blanco, el valor correcto y la página donde se ve. */
export const CorrectionInput = z.strictObject({
  target: CorrectionTarget,
  value: CorrectionValue,
  page: z.int().min(1).nullable(),
})
export type CorrectionInput = z.infer<typeof CorrectionInput>

export const CorrectionsBody = z.strictObject({ corrections: z.array(CorrectionInput).min(1).max(50) })

/** La corrección guardada: incluye lo que se leyó, para el dataset de evals. */
export const Correction = z.strictObject({
  id: z.uuid(),
  target: CorrectionTarget,
  read_value: z.union([z.string(), z.number(), z.null()]),
  value: CorrectionValue,
  page: z.int().min(1).nullable(),
  created_by: z.string().nullable().describe('Correo de quien corrigió'),
  created_at: z.string(),
})
export type Correction = z.infer<typeof Correction>

/** El tipo de valor que acepta cada blanco; el servidor y el formulario validan con lo mismo. */
export function correctionValueKind(t: CorrectionTarget): 'text' | 'money' | 'signed_money' | 'count' | 'date' | 'type' | 'holder_type' {
  if (t.kind === 'holder') return t.field === 'holder_type' ? 'holder_type' : 'text'
  if (t.kind === 'account') return 'text'
  if (t.kind === 'period') return t.field === 'credits_count' || t.field === 'debits_count' ? 'count' : t.field === 'opening_balance' || t.field === 'closing_balance' ? 'signed_money' : 'money'
  return t.field === 'amount' ? 'money' : t.field === 'type' ? 'type' : 'date'
}

/** Mensaje de error de un valor para ese blanco, o null si sirve. */
export function checkCorrectionValue(t: CorrectionTarget, value: string | number): string | null {
  const kind = correctionValueKind(t)
  const num = typeof value === 'number' ? value : Number(value.replace(/[$,\s]/g, ''))
  switch (kind) {
    case 'money':
      return Money.safeParse(num).success ? null : 'Escribe un monto positivo con a lo más dos decimales'
    case 'signed_money':
      return SignedMoney.safeParse(num).success ? null : 'Escribe un monto con a lo más dos decimales'
    case 'count':
      return Number.isInteger(num) && num >= 0 ? null : 'Escribe un número entero'
    case 'date':
      return IsoDate.safeParse(value).success ? null : 'Usa el formato AAAA-MM-DD'
    case 'type':
      return TransactionType.safeParse(value).success ? null : 'Elige abono o cargo'
    case 'holder_type':
      return ['individual', 'individual_with_business_activity', 'legal_entity'].includes(String(value)) ? null : 'Elige un tipo de titular'
    default:
      return String(value).trim().length > 0 ? null : 'No puede ir vacío'
  }
}
