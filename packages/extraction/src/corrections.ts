/**
 * Correcciones del analista sobre una extracción (docs/08 §2, ADR 0020). La extracción guardada es
 * inmutable: las correcciones viven aparte y se aplican en lectura, tanto para mostrar el
 * documento corregido como para reevaluar. Aplicar una corrección:
 * - pone el valor, `verified`, confianza 1 y procedencia `analyst_answer` (el motor lo trata como
 *   un dato confirmado por una persona, no como uno leído por un modelo);
 * - recalcula el cuadre de los periodos tocados con la misma función de la extracción, para que
 *   `integrity_ok` y las banderas reflejen la cifra corregida y no la leída.
 * Código puro: sin modelos, sin base.
 */
import { checkClabe, checkCorrectionValue, checkRfc, correctionValueKind, type CorrectionInput, type CorrectionTarget, type Period, type StatementExtraction } from '@gow/contracts'
import { round2 } from './normalize.ts'
import { printedOf, reconcilePeriod } from './reconcile.ts'

export class CorrectionError extends Error {}

const RECONCILIATION_ISSUES = new Set(['reconciliation_mismatch', 'totals_mismatch', 'count_mismatch', 'running_balance_break'])

type Value = string | number

function coerce(target: CorrectionTarget, value: Value): Value {
  const kind = correctionValueKind(target)
  if (kind === 'money' || kind === 'signed_money') return round2(typeof value === 'number' ? value : Number(value.replace(/[$,\s]/g, '')))
  if (kind === 'count') return typeof value === 'number' ? value : Number(value.replace(/[,\s]/g, ''))
  return typeof value === 'string' ? value.trim() : String(value)
}

function locate(x: StatementExtraction, target: CorrectionTarget) {
  if (target.kind === 'holder') return { holder: x.holder }
  if (target.kind === 'account') {
    const account = x.accounts.find((a) => a.id === target.account_id)
    if (!account) throw new CorrectionError(`no existe la cuenta ${target.account_id}`)
    return { account }
  }
  for (const account of x.accounts) {
    for (const period of account.periods) {
      if (target.kind === 'period' && period.id === target.period_id) return { period }
      if (target.kind === 'transaction') {
        const tx = period.transactions.find((t) => t.id === target.transaction_id)
        if (tx) return { tx, period }
      }
    }
  }
  throw new CorrectionError(target.kind === 'period' ? `no existe el periodo ${target.period_id}` : `no existe el movimiento ${target.transaction_id}`)
}

/** El valor que hoy tiene el blanco, para guardarlo como "valor leído". */
export function readValue(x: StatementExtraction, target: CorrectionTarget): Value | null {
  const at = locate(x, target)
  if (target.kind === 'holder' && at.holder) return at.holder[target.field].value
  if (target.kind === 'account' && at.account) return at.account[target.field].value
  if (target.kind === 'period' && at.period) return at.period.summary[target.field].value
  if (target.kind === 'transaction' && at.tx) return at.tx[target.field]
  return null
}

function confirmed<F extends { value: unknown }>(f: F, value: NonNullable<F['value']>): F {
  return { ...f, value, verification: 'verified', confidence: 1, provenance: 'analyst_answer' }
}

export function applyCorrections(input: StatementExtraction, corrections: readonly Pick<CorrectionInput, 'target' | 'value'>[]): StatementExtraction {
  if (corrections.length === 0) return input
  const x = structuredClone(input)
  const touched = new Set<Period>()
  for (const c of corrections) {
    const problem = checkCorrectionValue(c.target, c.value)
    if (problem) throw new CorrectionError(problem)
    const value = coerce(c.target, c.value)
    const t = c.target
    const at = locate(x, t)
    if (t.kind === 'holder' && at.holder) {
      if (t.field === 'rfc' && checkRfc(String(value)).result === 'invalid') throw new CorrectionError('El RFC no tiene un formato válido')
      if (t.field === 'holder_type') at.holder.holder_type = confirmed(at.holder.holder_type, String(value) as NonNullable<typeof at.holder.holder_type.value>)
      else at.holder[t.field] = confirmed(at.holder[t.field], String(value))
    } else if (t.kind === 'account' && at.account) {
      if (t.field === 'clabe' && checkClabe(String(value)) === 'invalid') throw new CorrectionError('La CLABE no pasa el dígito verificador')
      at.account[t.field] = confirmed(at.account[t.field], String(value))
    } else if (t.kind === 'period' && at.period) {
      at.period.summary[t.field] = confirmed(at.period.summary[t.field], Number(value))
      touched.add(at.period)
    } else if (t.kind === 'transaction' && at.tx) {
      const tx = at.tx
      if (t.field === 'amount') tx.amount = Number(value)
      else if (t.field === 'date') tx.date = String(value)
      else tx.type = String(value) as typeof tx.type
      tx.verification = 'verified'
      tx.confidence = 1
      tx.provenance = 'analyst_answer'
      touched.add(at.period)
    }
  }
  for (const p of touched) {
    p.reconciliation = reconcilePeriod(p.transactions, printedOf(p)).reconciliation
    if (p.reconciliation.status === 'reconciled') x.issues = x.issues.filter((i) => !(i.period_id === p.id && RECONCILIATION_ISSUES.has(i.code)))
  }
  if (!x.accounts.some((a) => a.periods.some((p) => p.reconciliation?.status === 'not_reconciled'))) x.flags = x.flags.filter((f) => f !== 'reconciliation_failed')
  return x
}
