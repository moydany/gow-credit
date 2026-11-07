/**
 * What is marked on each page of the document, and why: unverified or conflicting values, doubtful
 * movements, extraction alerts and balance breaks. The page strip paints these pages; the viewer
 * lists them for the page on screen, so a marked page is never a mystery.
 */
import type { Account, Period, StatementExtraction, Transaction } from '@gow/contracts'
import { date, money } from '../../lib/format'
import { balanceBreaks } from './breaks'

export interface PageAlert {
  /** What it is: "Saldo inicial: 124.46", "Cargo del 5 oct 2026 por $931.06 MXN". */
  label: string
  /** Why it is marked. */
  reason: string
  /** Text to highlight on the page, when there is one. */
  snippet: string | null
  tone: 'unverified' | 'conflict'
}

interface Field {
  value: string | number | boolean | null
  verification: string
  source: { page: number; snippet: string } | null
}

type Labeled = [Field, string]

const WHY: Record<string, string> = {
  unverified: 'el valor no se encontró tal cual en el texto de la página',
  conflict: 'dos lecturas del documento no coinciden',
}

function headerFields(x: StatementExtraction): Labeled[] {
  const h = x.holder
  return [[x.bank_name, 'Banco'], [h.name, 'Nombre del titular'], [h.rfc, 'RFC del titular'], [h.holder_type, 'Tipo de titular'], [h.address, 'Domicilio']]
}

function accountFields(a: Account): Labeled[] {
  return [[a.product_name, 'Producto'], [a.account_type, 'Tipo de cuenta'], [a.account_number, 'Número de cuenta'], [a.clabe, 'CLABE'], [a.currency, 'Moneda']]
}

function periodFields(p: Period): Labeled[] {
  const s = p.summary
  return [
    [p.period_start, 'Inicio del periodo'],
    [p.period_end, 'Fin del periodo'],
    [p.statement_date, 'Fecha de corte'],
    [s.opening_balance, 'Saldo inicial'],
    [s.closing_balance, 'Saldo final'],
    [s.total_credits, 'Total de abonos'],
    [s.total_debits, 'Total de cargos'],
    [s.credits_count, 'Número de abonos'],
    [s.debits_count, 'Número de cargos'],
    [s.average_balance, 'Saldo promedio'],
    [s.fees_charged, 'Comisiones'],
    [s.interest_earned, 'Intereses'],
    [s.tax_withheld, 'ISR retenido'],
  ]
}

const movement = (t: Pick<Transaction, 'type' | 'date' | 'amount'>) => `${t.type === 'credit' ? 'Abono' : 'Cargo'} del ${date(t.date)} por ${money(t.amount)}`
const toneOf = (verification: string): PageAlert['tone'] => (verification === 'conflict' ? 'conflict' : 'unverified')

/** A field read but not verified, on the page it was read from. */
function fieldAlert([f, label]: Labeled): [number, PageAlert] | null {
  if (f.verification === 'verified' || f.value === null || !f.source) return null
  return [f.source.page, { label: `${label}: ${String(f.value)}`, reason: WHY[f.verification] ?? f.verification, snippet: f.source.snippet, tone: toneOf(f.verification) }]
}

function transactionAlert(t: Transaction): [number, PageAlert] | null {
  if (t.verification === 'verified') return null
  return [t.source.page, { label: movement(t), reason: WHY[t.verification] ?? t.verification, snippet: t.source.snippet, tone: toneOf(t.verification) }]
}

/** Every page with something to review, with what and why. */
export function pageAlerts(x: StatementExtraction): Map<number, PageAlert[]> {
  const found: ([number, PageAlert] | null)[] = [
    ...headerFields(x).map(fieldAlert),
    ...x.accounts.flatMap((a) => [...accountFields(a).map(fieldAlert), ...a.periods.flatMap((p) => [...periodFields(p).map(fieldAlert), ...p.transactions.map(transactionAlert)])]),
    ...x.issues.filter((i) => i.page !== null && i.severity !== 'info').map((i): [number, PageAlert] => [i.page ?? 0, { label: 'Alerta de la extracción', reason: i.message, snippet: null, tone: i.severity === 'error' ? 'conflict' : 'unverified' }]),
    ...balanceBreaks(x).map((b): [number, PageAlert] => [b.tx.source.page, { label: movement(b.tx), reason: `el saldo deja de cuadrar aquí: se esperaba ${money(b.expected)} y el banco imprime ${money(b.printed)}`, snippet: b.tx.source.snippet, tone: 'conflict' }]),
  ]
  const out = new Map<number, PageAlert[]>()
  for (const entry of found) {
    if (!entry) continue
    const [page, alert] = entry
    out.set(page, [...(out.get(page) ?? []), alert])
  }
  return out
}
