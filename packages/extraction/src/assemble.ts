/**
 * Model output to the canonical contract: stable ids, normalized dates and amounts, rows outside
 * the block dropped, each value with its source and its check against the text layer. Does not
 * call the model.
 */
import type { Account, AccountType, HolderType, Period, Provenance, Transaction, Verification } from '@gow/contracts'
import type { IssueSink } from './issues.ts'
import { pick, type SummaryOut, type TransactionOut } from './llm-schema.ts'
import { isValidIsoDate, parseAmount, parseCount, parseLooseDate, round2 } from './normalize.ts'
import { accountTypeSource, currencySource } from './inferred.ts'
import type { PageText } from './page-text.ts'

export interface FieldOf<T> {
  value: T | null
  source: { page: number; snippet: string } | null
  verification: Verification
  confidence: number
  provenance: Provenance
}

/** Normalized quote: in the model schema, absent means "" or page 0 (union limit). */
interface Cited<T> {
  value: T | null
  page: number | null
  snippet: string | null
}

function cite<T>(c: { value: string; page: number; snippet: string }, parse: (raw: string) => T | null): Cited<T> {
  const raw = c.value.trim()
  return { value: raw.length > 0 ? parse(raw) : null, page: c.page > 0 ? c.page : null, snippet: c.snippet.trim().length > 0 ? c.snippet : null }
}
type RawCited = Parameters<typeof cite>[0]
const asText = (c: RawCited) => cite(c, (s) => s)
const asAmount = (c: RawCited) => cite(c, parseAmount)
/** Totals, fees, interest and ISR are magnitudes: some banks (Mercado Pago) print charges signed. */
const asMagnitude = (c: RawCited) => cite(c, (raw) => {
  const n = parseAmount(raw)
  return n === null ? null : Math.abs(n)
})
const asCount = (c: RawCited) => cite(c, parseCount)

const EMPTY: FieldOf<never> = { value: null, source: null, verification: 'unverified', confidence: 0, provenance: 'extracted' }

function cleanSnippet(s: string | null): string | null {
  if (s === null) return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 0 ? t.slice(0, 600) : null
}

/** Builds a Field checking the value against the cited page; with no quote, searches for it. */
export function textField(c: Cited<string>, text: PageText): FieldOf<string> {
  const value = c.value?.trim() ? c.value.trim() : null
  if (value === null) return EMPTY
  const snippet = cleanSnippet(c.snippet)
  if (text.validPage(c.page) && snippet) {
    const ok = text.usable && (text.snippetOnPage(c.page, snippet) || text.snippetOnPage(c.page, value))
    return { value, source: { page: c.page, snippet }, verification: ok ? 'verified' : 'unverified', confidence: ok ? 0.95 : 0.6, provenance: 'extracted' }
  }
  const found = text.usable ? text.locateText(value) : null
  if (found) return { value, source: { page: found.page, snippet: found.line }, verification: 'verified', confidence: 0.9, provenance: 'extracted' }
  return { value, source: null, verification: 'unverified', confidence: 0.3, provenance: 'extracted' }
}

export function amountField(c: Cited<number>, text: PageText, hintPages: readonly number[] = []): FieldOf<number> {
  if (c.value === null || !Number.isFinite(c.value)) return EMPTY
  const value = round2(c.value)
  const snippet = cleanSnippet(c.snippet)
  if (text.validPage(c.page) && snippet) {
    const ok = text.usable && text.amountOnPage(c.page, value)
    return { value, source: { page: c.page, snippet }, verification: ok ? 'verified' : 'unverified', confidence: ok ? 0.95 : 0.6, provenance: 'extracted' }
  }
  const found = text.usable ? text.locateAmount(value, hintPages) : null
  if (found) return { value, source: { page: found.page, snippet: found.line }, verification: 'verified', confidence: 0.85, provenance: 'extracted' }
  return { value, source: null, verification: 'unverified', confidence: 0.3, provenance: 'extracted' }
}

export function countField(c: Cited<number>, text: PageText): FieldOf<number> {
  if (c.value === null || !Number.isInteger(c.value) || c.value < 0) return EMPTY
  const snippet = cleanSnippet(c.snippet)
  if (text.validPage(c.page) && snippet) {
    const ok = text.usable && text.snippetOnPage(c.page, snippet)
    return { value: c.value, source: { page: c.page, snippet }, verification: ok ? 'verified' : 'unverified', confidence: ok ? 0.9 : 0.6, provenance: 'extracted' }
  }
  return { value: c.value, source: null, verification: 'unverified', confidence: 0.3, provenance: 'extracted' }
}

export function dateField(c: Cited<string>, text: PageText, periodEnd: string | null): FieldOf<string> {
  if (c.value === null) return EMPTY
  const iso = parseLooseDate(c.value, periodEnd)
  if (iso === null) return EMPTY
  const snippet = cleanSnippet(c.snippet)
  if (text.validPage(c.page) && snippet) {
    const ok = text.usable && text.snippetOnPage(c.page, snippet)
    return { value: iso, source: { page: c.page, snippet }, verification: ok ? 'verified' : 'unverified', confidence: ok ? 0.95 : 0.6, provenance: 'extracted' }
  }
  return { value: iso, source: null, verification: 'unverified', confidence: 0.3, provenance: 'extracted' }
}

function enumField<T extends string>(value: T | 'unknown', base: FieldOf<string>): FieldOf<T> {
  if (value === 'unknown') return EMPTY
  // Account/person type is a model inference with no literal text to prove it: unverified.
  return { value, source: base.source, verification: 'unverified', confidence: 0.7, provenance: 'extracted' }
}

const CURRENCY = /^[A-Z]{3}$/

export interface PeriodMeta {
  id: string
  accountId: string
  accountRef: string
  periodRef: string
  start: string | null
  end: string | null
  movementPages: number[]
  printsRunningBalance: boolean
  label: string
}

export interface AssembledSummary {
  bankName: FieldOf<string>
  holder: { name: FieldOf<string>; rfc: FieldOf<string>; holder_type: FieldOf<HolderType>; address: FieldOf<string> }
  accounts: Account[]
  periods: PeriodMeta[]
  /** account_ref -> period_ref -> period id. */
  refs: Map<string, Map<string, string>>
}

export function assembleSummary(s: SummaryOut, text: PageText): AssembledSummary {
  const refs = new Map<string, Map<string, string>>()
  const periods: PeriodMeta[] = []
  const accounts: Account[] = s.accounts.map((a, ai) => {
    const accountId = `a${String(ai + 1)}`
    const periodRefs = new Map<string, string>()
    refs.set(a.ref.trim(), periodRefs)
    const product = textField(asText(pick(a.values, 'product_name')), text)
    const builtPeriods: Period[] = a.periods.map((p, pi) => {
      const periodId = `${accountId}.p${String(pi + 1)}`
      periodRefs.set(p.ref.trim(), periodId)
      const v = (name: string) => pick(p.values, name)
      const end = dateField(asText(v('period_end')), text, null)
      const start = dateField(asText(v('period_start')), text, end.value)
      const statementDate = dateField(asText(v('statement_date')), text, end.value)
      const movementPages = [...new Set(p.movement_pages.filter((n) => text.validPage(n)))].sort((x, y) => x - y)
      periods.push({
        id: periodId,
        accountId,
        accountRef: a.ref.trim(),
        periodRef: p.ref.trim(),
        start: start.value,
        end: end.value ?? statementDate.value,
        movementPages,
        printsRunningBalance: p.prints_running_balance,
        label: `${product.value ?? a.ref} ${start.value ?? '?'} a ${end.value ?? '?'}`,
      })
      const hint = movementPages.length > 0 ? [Math.max(1, (movementPages[0] ?? 1) - 1), ...movementPages] : []
      return {
        id: periodId,
        period_start: start,
        period_end: end,
        statement_date: statementDate,
        pages: movementPages,
        summary: {
          opening_balance: amountField(asAmount(v('opening_balance')), text, hint),
          closing_balance: amountField(asAmount(v('closing_balance')), text, hint),
          total_credits: amountField(asMagnitude(v('total_credits')), text, hint),
          total_debits: amountField(asMagnitude(v('total_debits')), text, hint),
          credits_count: countField(asCount(v('credits_count')), text),
          debits_count: countField(asCount(v('debits_count')), text),
          average_balance: amountField(asAmount(v('average_balance')), text, hint),
          fees_charged: amountField(asMagnitude(v('fees_charged')), text, hint),
          interest_earned: amountField(asMagnitude(v('interest_earned')), text, hint),
          tax_withheld: amountField(asMagnitude(v('tax_withheld')), text, hint),
        },
        transactions: [],
        reconciliation: null,
      }
    })
    const currencyRaw = a.currency.trim().toUpperCase() || null
    // Inferred values, verified when a printed word states them; that line is their source (inferred.ts).
    const currencyProof = currencyRaw ? currencySource(currencyRaw, text) : null
    const currency: FieldOf<string> =
      currencyRaw && CURRENCY.test(currencyRaw)
        ? currencyProof
          ? { value: currencyRaw, source: currencyProof, verification: 'verified', confidence: 0.95, provenance: 'extracted' }
          : { value: currencyRaw, source: product.source, verification: 'unverified', confidence: 0.8, provenance: 'extracted' }
        : EMPTY
    const accountType = enumField<AccountType>(a.account_type, product)
    const sameType = s.accounts.filter((x) => x.account_type === a.account_type).length
    const typeProof = accountType.value !== null ? accountTypeSource(accountType.value, product, sameType, text) : null
    return {
      id: accountId,
      product_name: product,
      account_type: typeProof ? { ...accountType, source: typeProof, verification: 'verified', confidence: 0.95 } : accountType,
      account_number: textField(asText(pick(a.values, 'account_number')), text),
      clabe: textField(asText(pick(a.values, 'clabe')), text),
      currency,
      periods: builtPeriods,
    }
  })
  const holderName = textField(asText(pick(s.values, 'holder_name')), text)
  return {
    bankName: textField(asText(pick(s.values, 'bank_name')), text),
    holder: { name: holderName, rfc: textField(asText(pick(s.values, 'holder_rfc')), text), holder_type: enumField<HolderType>(s.holder_type, holderName), address: textField(asText(pick(s.values, 'holder_address')), text) },
    accounts,
    periods,
    refs,
  }
}

/** Row assigned to a period, still without its final id. */
export interface PlacedRow {
  periodId: string
  /** Reading order within the document (block, position); keeps the printed order. */
  order: number
  tx: Omit<Transaction, 'id'>
}

function resolvePeriod(row: TransactionOut, summary: AssembledSummary, date: string | null): string | null {
  const byAccount = summary.refs.get(row.account_ref.trim())
  const direct = byAccount?.get(row.period_ref.trim())
  if (direct) return direct
  // Invented or miscopied refs: with one possible period use it, otherwise go by date and page.
  const candidates = summary.periods.filter((p) => (byAccount ? p.accountRef === row.account_ref.trim() : true))
  if (candidates.length === 1) return candidates[0]?.id ?? null
  const byPage = candidates.filter((p) => p.movementPages.includes(row.page))
  if (byPage.length === 1) return byPage[0]?.id ?? null
  if (date) {
    const byDate = (byPage.length > 0 ? byPage : candidates).filter((p) => p.start !== null && p.end !== null && date >= p.start && date <= p.end)
    if (byDate.length === 1) return byDate[0]?.id ?? null
  }
  return null
}

function resolveRowDates(r: TransactionOut, summary: AssembledSummary): { periodEnd: string | null; date: string | null; periodId: string | null } {
  const periodEnd = summary.periods.find((p) => p.periodRef === r.period_ref.trim())?.end ?? summary.periods[0]?.end ?? null
  const date = isValidIsoDate(r.date.trim()) ? r.date.trim() : parseLooseDate(r.date, periodEnd)
  const periodId = resolvePeriod(r, summary, date)
  return { periodEnd, date, periodId }
}

function convertPlacedRow(
  r: TransactionOut,
  index: number,
  orderBase: number,
  summary: AssembledSummary,
  issues: IssueSink,
  seen: Set<string>,
): PlacedRow | null {
  const { periodEnd, date, periodId } = resolveRowDates(r, summary)
  if (date === null || periodId === null) {
    issues.add({
      code: 'missing_required_field',
      severity: 'error',
      message: date === null ? `Movimiento de la página ${String(r.page)} con fecha ilegible; se descartó.` : `Movimiento de la página ${String(r.page)} sin cuenta o periodo identificable; se descartó.`,
      page: r.page,
      details: { amount: parseAmount(r.amount) },
    })
    return null
  }
  const settlementRaw = r.settlement_date.trim()
  const settlement = settlementRaw === '' ? null : isValidIsoDate(settlementRaw) ? settlementRaw : parseLooseDate(settlementRaw, periodEnd)
  const parsedAmount = parseAmount(r.amount)
  if (parsedAmount === null) {
    issues.add({ code: 'missing_required_field', severity: 'error', message: `Movimiento de la página ${String(r.page)} con monto ilegible; se descartó.`, page: r.page, period_id: periodId })
    return null
  }
  const amount = round2(Math.abs(parsedAmount))
  const balance = parseAmount(r.balance)
  const description = r.description.replace(/\s+/g, ' ').trim() || '(sin descripción)'
  const key = `${String(r.page)}|${date}|${String(amount)}|${r.type}|${String(balance)}|${description}`
  if (balance !== null && seen.has(key)) {
    issues.add({ code: 'duplicate_transaction_removed', severity: 'info', message: `Fila repetida en la página ${String(r.page)}; se dejó una.`, page: r.page, period_id: periodId, details: { amount } })
    return null
  }
  seen.add(key)
  return {
    periodId,
    order: orderBase + index,
    tx: {
      date,
      settlement_date: settlement,
      description,
      reference: r.reference.trim() || null,
      amount,
      type: r.type,
      balance,
      internal_transfer: r.internal_transfer,
      source: { page: r.page, snippet: (r.snippet.replace(/\s+/g, ' ').trim() || description).slice(0, 600) },
      verification: 'unverified',
      confidence: 0.5,
      provenance: 'extracted',
      classification: null,
    },
  }
}

/**
 * Converts a block's rows. Drops rows outside the block's pages (another block extracts them),
 * rows on a repeated page (`skipPages`: already flagged once, must not count twice before the
 * balance check) and exact duplicates with a balance, which cannot be legitimate.
 */
export function placeRows(rows: readonly TransactionOut[], blockPages: readonly number[], summary: AssembledSummary, orderBase: number, issues: IssueSink, skipPages: ReadonlySet<number> = new Set()): PlacedRow[] {
  const allowed = new Set(blockPages)
  const seen = new Set<string>()
  const placed: PlacedRow[] = []
  let outside = 0
  rows.forEach((r, i) => {
    if (skipPages.has(r.page)) return
    if (!allowed.has(r.page)) {
      outside += 1
      return
    }
    const item = convertPlacedRow(r, i, orderBase, summary, issues, seen)
    if (item !== null) placed.push(item)
  })
  if (outside > 0) {
    issues.add({ code: 'duplicate_transaction_removed', severity: 'info', message: `${String(outside)} filas venían de páginas fuera del bloque ${String(blockPages[0])}-${String(blockPages.at(-1))}; se descartaron porque las extrae otro bloque.`, details: { outside } })
  }
  return placed
}

/** Final ids per period in reading order: a1.p1.t0001, ... */
export function materialize(rows: readonly PlacedRow[]): Map<string, Transaction[]> {
  const byPeriod = new Map<string, PlacedRow[]>()
  for (const r of rows) byPeriod.set(r.periodId, [...(byPeriod.get(r.periodId) ?? []), r])
  const out = new Map<string, Transaction[]>()
  for (const [periodId, list] of byPeriod) {
    const sorted = [...list].sort((a, b) => a.tx.source.page - b.tx.source.page || a.order - b.order)
    out.set(
      periodId,
      sorted.map((r, i) => ({ id: `${periodId}.t${String(i + 1).padStart(4, '0')}`, ...r.tx })),
    )
  }
  return out
}
