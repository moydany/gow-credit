/**
 * Analyst corrections over an extraction. The stored extraction is immutable: corrections live
 * apart and are applied on read, both to show the corrected document and to re-evaluate.
 * Applying one:
 * - sets the value, `verified`, confidence 1 and provenance `analyst_answer` (the engine treats
 *   it as confirmed by a person, not read by a model);
 * - recomputes the balance check of touched periods with the extraction's own function, so
 *   `integrity_ok` and the flags reflect the corrected figure, not the one read.
 * Pure code: no models, no database.
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

function locateAccount(x: StatementExtraction, accountId: string) {
  const account = x.accounts.find((a) => a.id === accountId)
  if (!account) throw new CorrectionError(`no existe la cuenta ${accountId}`)
  return account
}

function locatePeriod(x: StatementExtraction, periodId: string): Period {
  for (const account of x.accounts) {
    const period = account.periods.find((p) => p.id === periodId)
    if (period) return period
  }
  throw new CorrectionError(`no existe el periodo ${periodId}`)
}

function locateTransaction(x: StatementExtraction, transactionId: string): { tx: Period['transactions'][number]; period: Period } {
  for (const account of x.accounts) {
    for (const period of account.periods) {
      const tx = period.transactions.find((t) => t.id === transactionId)
      if (tx) return { tx, period }
    }
  }
  throw new CorrectionError(`no existe el movimiento ${transactionId}`)
}

/** The value the blank holds today, kept as the "read value". */
export function readValue(x: StatementExtraction, target: CorrectionTarget): Value | null {
  if (target.kind === 'holder') return x.holder[target.field].value
  if (target.kind === 'account') return locateAccount(x, target.account_id)[target.field].value
  if (target.kind === 'period') return locatePeriod(x, target.period_id).summary[target.field].value
  return locateTransaction(x, target.transaction_id).tx[target.field]
}

function confirmed<F extends { value: unknown }>(f: F, value: NonNullable<F['value']>): F {
  return { ...f, value, verification: 'verified', confidence: 1, provenance: 'analyst_answer' }
}

function applyHolderCorrection(holder: StatementExtraction['holder'], t: Extract<CorrectionTarget, { kind: 'holder' }>, value: Value): void {
  if (t.field === 'rfc' && checkRfc(String(value)).result === 'invalid') throw new CorrectionError('El RFC no tiene un formato válido')
  if (t.field === 'holder_type') holder.holder_type = confirmed(holder.holder_type, String(value) as NonNullable<typeof holder.holder_type.value>)
  else holder[t.field] = confirmed(holder[t.field], String(value))
}

function applyAccountCorrection(account: StatementExtraction['accounts'][number], t: Extract<CorrectionTarget, { kind: 'account' }>, value: Value): void {
  if (t.field === 'clabe' && checkClabe(String(value)) === 'invalid') throw new CorrectionError('La CLABE no pasa el dígito verificador')
  account[t.field] = confirmed(account[t.field], String(value))
}

function applySingleCorrection(x: StatementExtraction, target: CorrectionTarget, value: Value, touched: Set<Period>): void {
  if (target.kind === 'holder') {
    applyHolderCorrection(x.holder, target, value)
  } else if (target.kind === 'account') {
    applyAccountCorrection(locateAccount(x, target.account_id), target, value)
  } else if (target.kind === 'period') {
    const period = locatePeriod(x, target.period_id)
    period.summary[target.field] = confirmed(period.summary[target.field], Number(value))
    touched.add(period)
  } else {
    const { tx, period } = locateTransaction(x, target.transaction_id)
    if (target.field === 'amount') tx.amount = Number(value)
    else if (target.field === 'date') tx.date = String(value)
    else tx.type = String(value) as typeof tx.type
    tx.verification = 'verified'
    tx.confidence = 1
    tx.provenance = 'analyst_answer'
    touched.add(period)
  }
}

function refreshReconciledPeriods(x: StatementExtraction, touched: Set<Period>): void {
  for (const p of touched) {
    p.reconciliation = reconcilePeriod(p.transactions, printedOf(p)).reconciliation
    if (p.reconciliation.status === 'reconciled') x.issues = x.issues.filter((i) => !(i.period_id === p.id && RECONCILIATION_ISSUES.has(i.code)))
  }
  if (!x.accounts.some((a) => a.periods.some((p) => p.reconciliation?.status === 'not_reconciled'))) x.flags = x.flags.filter((f) => f !== 'reconciliation_failed')
}

export function applyCorrections(input: StatementExtraction, corrections: readonly Pick<CorrectionInput, 'target' | 'value'>[]): StatementExtraction {
  if (corrections.length === 0) return input
  const x = structuredClone(input)
  const touched = new Set<Period>()
  for (const c of corrections) {
    const problem = checkCorrectionValue(c.target, c.value)
    if (problem) throw new CorrectionError(problem)
    const value = coerce(c.target, c.value)
    applySingleCorrection(x, c.target, value, touched)
  }
  refreshReconciledPeriods(x, touched)
  return x
}
