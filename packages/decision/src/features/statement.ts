/**
 * Features from the statements. Common rules:
 *
 * - Months come from the days covered (union of periods), not the number of periods: Mercado
 *   Pago prints a 91-day period and it counts as 3 months.
 * - Internal transfers are neither income nor expense.
 * - An `unverified` or `conflict` movement does not add up; if what was left out is material,
 *   the feature is `unverified` and the engine decides whether that changes the band.
 * - The confidence of a feature that depends on classification is the amount-weighted mean
 *   confidence of the movements feeding it.
 */
import { checkRfc, rfcRoot, type DOCUMENT_TAMPER_SIGNALS, type Issue, type StatementExtraction, type Verification } from '@gow/contracts'
import { evidenceRef, type Ledger, type LedgerRow } from '../ledger.ts'
import { AVG_MONTH_DAYS, intervalDays, toDay, unionIntervals, type Interval } from '../util/dates.ts'
import { clamp01, round2, round4, sumMoney, weightedMean } from '../util/num.ts'
import { nameSimilarity, normalizeText } from '../util/text.ts'
import { fiscalAnchor, fiscalRegime, regimeIncomePlausible } from './fiscal.ts'
import type { StatementContext } from './statement-context.ts'
import { combinedProvenance, known, unknown, worst, type Entries, type Entry } from './entry.ts'

/** One month with about 3 days of tolerance: February or a mid-month cutoff counts as a full month. */
const MONTH_TOLERANCE = 0.1
/** Under a week covered is not enough for monthly averages. */
const MIN_DAYS_FOR_MONTHLY = 7
/** Below this share of income with an identified payer, concentration and recurrence are unknown. */
const MIN_IDENTIFIED_SHARE = 0.5

export type { StatementContext }

export interface Coverage {
  segments: Interval[]
  days: number
  /** Fractional months: days / 30.4375. */
  months: number
  verified: boolean
}

export function coverageOf(ledger: Ledger): Coverage {
  const intervals: Interval[] = []
  let verified = true
  for (const p of ledger.periods) {
    if (p.start === null || p.end === null) continue
    intervals.push({ start: p.start, end: p.end })
    if (!p.boundsVerified && !ledger.rows.some((r) => r.period === p && r.verified)) verified = false
  }
  const segments = unionIntervals(intervals)
  const days = intervalDays(segments)
  return { segments, days, months: days / AVG_MONTH_DAYS, verified }
}

/** Movements that weigh in a feature: the 25 largest by amount, as evidence. */
function topRefs(rows: readonly LedgerRow[]): string[] {
  return [...rows].sort((a, b) => b.amount - a.amount || a.day - b.day || evidenceRef(a).localeCompare(evidenceRef(b))).map(evidenceRef)
}

function isMaterial(unverifiedAmount: number, poolAmount: number): boolean {
  return unverifiedAmount > Math.max(1, 0.005 * poolAmount)
}

function confidenceOf(rows: readonly LedgerRow[]): number {
  return weightedMean(
    rows.map((r) => ({ value: r.classification.confidence, weight: r.amount })),
    1,
  )
}

function rulesNote(rows: readonly LedgerRow[]): string {
  const byRules = rows.filter((r) => r.classifiedBy === 'rules').length
  return byRules > 0 ? `; ${String(byRules)} clasificados por reglas (rules-v1)` : ''
}

// ---------------------------------------------------------------------------------------------
// History, age, identity, integrity, flags
// ---------------------------------------------------------------------------------------------

function monthsOfHistory(ledger: Ledger, cov: Coverage): Entry {
  if (cov.days === 0) return unknown('sin periodos con fechas')
  const value = Math.floor(cov.months + MONTH_TOLERANCE)
  return known(value, {
    verification: cov.verified ? 'verified' : 'unverified',
    evidence: ledger.periods.map((p) => `${p.doc.tag}:${p.period.id}`),
    note: `${String(cov.days)} días cubiertos (${cov.months.toFixed(2)} meses) en ${String(cov.segments.length)} tramo(s)`,
  })
}

function documentAgeDays(ctx: StatementContext): Entry {
  let latest: number | null = null
  let latestVerification: Verification = 'verified'
  const evidence: string[] = []
  for (const doc of ctx.ledger.documents) {
    const periods = ctx.ledger.periods.filter((p) => p.doc === doc)
    let corte: number | null = null
    let corteVerified = true
    for (const p of periods) {
      const printed = p.period.statement_date.verification === 'verified' ? p.period.statement_date.value : null
      const end = p.period.period_end.verification === 'verified' ? p.period.period_end.value : null
      const day = printed !== null ? toDay(printed) : end !== null ? toDay(end) : p.end
      if (day === null) continue
      if (printed === null && end === null) corteVerified = false
      corte = corte === null ? day : Math.max(corte, day)
    }
    if (corte === null) continue
    // The CFDI stamp date is a SAT mark: if it is earlier than the printed cutoff, it wins. So a
    // cutoff edited forward does not make the document look newer.
    const certified = doc.statement.fiscal_documents
      .filter((f) => f.kind === 'income' && f.certified_at.value !== null && f.certified_at.verification === 'verified')
      .map((f) => toDay(f.certified_at.value ?? ''))
    const reference = certified.length > 0 ? Math.min(corte, ...certified) : corte
    evidence.push(`${doc.tag}:${certified.length > 0 && Math.min(...certified) < corte ? 'cfdi.certified_at' : 'statement_date'}`)
    if (latest === null || reference > latest) {
      latest = reference
      latestVerification = corteVerified ? 'verified' : 'unverified'
    }
  }
  if (latest === null) return unknown('sin fecha de corte ni movimientos')
  const age = ctx.asOfDay - latest
  if (age < 0) return known(0, { verification: 'conflict', evidence, note: 'la fecha de corte es posterior a la fecha de cálculo' })
  return known(age, { verification: latestVerification, evidence, note: null })
}

/** `root`: the document's RFC has no homoclave and its root matches the registered one. */
type FieldResult = 'match' | 'partial' | 'root' | 'mismatch' | null

const MASK_CHARS = /[*•#]/

function cleanId(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase()
}

/** Compares position by position, skipping masked ones. */
function compareMasked(doc: string, registered: string): FieldResult {
  if (doc.length !== registered.length) return 'mismatch'
  let visible = 0
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i] ?? ''
    if (MASK_CHARS.test(c)) continue
    visible++
    if (c !== registered[i]) return 'mismatch'
  }
  return visible >= 3 ? 'partial' : null
}

export function compareRfc(docRfc: string, registered: string): FieldResult {
  const a = cleanId(docRfc)
  const b = cleanId(registered)
  // No homoclave: the root (letters and date) is compared against the start of the registered RFC.
  const root = rfcRoot(a)
  if (root !== null) return checkRfc(b).result === 'valid' && b.length === root.length + 3 ? (b.startsWith(root) ? 'root' : 'mismatch') : null
  const check = checkRfc(a)
  if (check.result === 'valid') return check.kind === 'generic' ? null : a === b ? 'match' : 'mismatch'
  if (check.result === 'masked') return compareMasked(a, b)
  return null
}

export function compareName(docName: string, registered: string): FieldResult {
  const sim = nameSimilarity(docName, registered)
  if (normalizeText(docName).length === 0) return null
  return sim >= 0.99 ? 'match' : sim >= 0.5 ? 'partial' : 'mismatch'
}

function identityMatch(ctx: StatementContext): Entry {
  const supplier = ctx.supplier
  if (supplier === null) return unknown('sin proveedor registrado contra el cual comparar')
  // Only name and RFC. The CLABE is extracted but does not tell whose account it is: whoever
  // sends the document can supply the same CLABE it prints.
  const results: { field: 'rfc' | 'name'; result: FieldResult; verification: Verification; where: string }[] = []
  for (const doc of ctx.ledger.documents) {
    const s = doc.statement
    if (supplier.rfc !== null) {
      if (s.holder.rfc.value !== null) results.push({ field: 'rfc', result: compareRfc(s.holder.rfc.value, supplier.rfc), verification: s.holder.rfc.verification, where: `${doc.tag}:holder.rfc` })
      // The header often masks the RFC; the CFDI prints it in full.
      for (const f of s.fiscal_documents) {
        if (f.receiver.rfc.value !== null) results.push({ field: 'rfc', result: compareRfc(f.receiver.rfc.value, supplier.rfc), verification: f.receiver.rfc.verification, where: `${doc.tag}:${f.id}.receiver.rfc` })
      }
    }
    if (s.holder.name.value !== null) results.push({ field: 'name', result: compareName(s.holder.name.value, supplier.legal_name), verification: s.holder.name.verification, where: `${doc.tag}:holder.name` })
  }
  const compared = results.filter((r) => r.result !== null)
  if (compared.length === 0) return unknown('titular y RFC no vienen en el documento o no se pueden comparar (redactados o enmascarados)')
  const verification = worst(...compared.map((r) => r.verification))
  const evidence = compared.map((r) => `${r.where}=${r.result ?? ''}`)
  const has = (field: string, result: FieldResult) => compared.some((r) => r.field === field && r.result === result)
  let value: 'match' | 'partial' | 'mismatch'
  if (compared.some((r) => r.result === 'mismatch')) value = 'mismatch'
  // The full RFC, or the name plus the RFC root (no homoclave).
  else if (has('rfc', 'match') || (has('name', 'match') && has('rfc', 'root'))) value = 'match'
  else value = 'partial'
  return known(value, { verification, evidence, note: `campos comparados: ${[...new Set(compared.map((r) => r.field))].join(', ')}` })
}

function integrityOk(ledger: Ledger): Entry {
  if (ledger.periods.length === 0) return unknown('sin periodos')
  const evidence: string[] = []
  let anyFalse = false
  let anyUnknown = false
  for (const p of ledger.periods) {
    const status = p.period.reconciliation?.status ?? null
    evidence.push(`${p.doc.tag}:${p.period.id}=${status ?? 'sin verificar'}`)
    if (status === 'not_reconciled') anyFalse = true
    else if (status !== 'reconciled') anyUnknown = true
  }
  if (anyFalse) return known(false, { evidence, note: 'al menos un periodo no cuadra' })
  if (anyUnknown) return { ...unknown('al menos un periodo no se pudo verificar por completo (sin saldos impresos o cuadre parcial)'), evidence }
  return known(true, { evidence })
}

const FLAG_RULES: readonly (readonly ['returned_check' | 'garnishment' | 'judicial_order' | 'tax_requirement' | 'overdraft', RegExp])[] = [
  ['returned_check', /\bCHEQUE DEVUELTO\b|\bDEVOLUCION DE CHEQUE\b|\bCHQ DEVUELTO\b|\bCHEQUE SIN FONDOS\b/],
  ['garnishment', /\bEMBARGO\b/],
  ['judicial_order', /\bORDEN JUDICIAL\b|\bASEGURAMIENTO\b|\bMANDAMIENTO\b|\bJUZGADO\b/],
  ['tax_requirement', /\bREQUERIMIENTO\b|\bCREDITO FISCAL\b|\bINMOVILIZACION\b/],
  ['overdraft', /\bSOBREGIRO\b/],
]

/** What is said when the computed daily balance goes negative and is not taken as an overdraft. */
const UNRELIABLE_BALANCE_NOTE = 'saldo calculado no confiable: el periodo no cuadra'

/**
 * `balancesTrusted`: every period balances, so the daily balance computed from the movements is
 * the bank's. If they do not (a repeated or missing page, an altered row), that balance says
 * nothing about the account and a negative minimum would be an invented overdraft. Overdraft
 * from a negative printed balance or `SOBREGIRO` in the description does not depend on the
 * balance check and stays the same.
 */
function redFlags(ledger: Ledger, minDailyBalance: number | null, balancesTrusted: boolean): Entry {
  const found = new Map<string, { verified: boolean; refs: string[] }>()
  const add = (flag: string, verified: boolean, ref: string) => {
    const f = found.get(flag) ?? { verified: false, refs: [] }
    f.verified ||= verified
    f.refs.push(ref)
    found.set(flag, f)
  }
  for (const r of ledger.rows) {
    if (r.internal) continue
    const text = normalizeText(`${r.tx.description} ${r.tx.reference ?? ''}`)
    for (const [flag, re] of FLAG_RULES) if (re.test(text)) add(flag, r.verified, evidenceRef(r))
    if (r.tx.balance !== null && r.tx.balance < 0) add('overdraft', r.verified, evidenceRef(r))
  }
  const negativeComputed = minDailyBalance !== null && minDailyBalance < 0
  if (negativeComputed && balancesTrusted) add('overdraft', true, 'saldo diario calculado')
  const flags = [...found.keys()].sort()
  const verification: Verification = [...found.values()].every((f) => f.verified) ? 'verified' : 'unverified'
  const evidence = [...new Set([...found.values()].flatMap((f) => f.refs))].sort()
  const ignored = negativeComputed && !balancesTrusted
  const note = ignored ? UNRELIABLE_BALANCE_NOTE : flags.length > 0 ? null : 'sin señales graves en las descripciones ni saldos negativos'
  return known(flags, { verification, evidence, note })
}

/** Do all periods balance? Only then is the daily balance computed from movements reliable. */
function allPeriodsReconciled(ledger: Ledger): boolean {
  return ledger.periods.length > 0 && ledger.periods.every((p) => p.period.reconciliation?.status === 'reconciled')
}

// ---------------------------------------------------------------------------------------------
// Document robustness: extraction signals reach the profile
// ---------------------------------------------------------------------------------------------

type TamperSignal = (typeof DOCUMENT_TAMPER_SIGNALS)[number]

/**
 * A CFDI stamp far from the period (`fiscal.ts`) shares a code with a movement outside the period
 * dates (`extract.ts`). The movement one always carries `period_id`; the CFDI one carries neither
 * period nor movement and only exists if the document has a voucher.
 */
function isFiscalStampIssue(issue: Issue, statement: StatementExtraction): boolean {
  return issue.code === 'date_out_of_period' && issue.period_id === null && issue.transaction_id === null && statement.fiscal_documents.length > 0
}

/**
 * `holder_address_present`: some statement carries the holder's address. Evidence is
 * `sha:holder.address` of those that do; the address itself stays out of the profile (personal
 * data).
 */
function holderAddressPresent(ledger: Ledger): Entry {
  if (ledger.documents.length === 0) return unknown('sin estados de cuenta')
  const read = ledger.documents.filter((d) => (d.statement.holder.address.value ?? '').trim().length > 0)
  if (read.length === 0) return known(false, { note: 'ningún estado de cuenta trae el domicilio del titular' })
  // One located in the text is enough; if none could be located (e.g. a scan read by vision), the
  // value stays unverified and decides nothing on its own.
  const verified = read.filter((d) => d.statement.holder.address.verification === 'verified')
  const evidence = (verified.length > 0 ? verified : read).map((d) => `${d.tag}:holder.address`)
  return known(true, { evidence, verification: verified.length > 0 ? 'verified' : 'unverified', note: verified.length > 0 ? null : 'el domicilio leído no se pudo ubicar en el texto del documento' })
}

/**
 * `document_pages_missing` and `document_tamper_signals`, from the flags and issues extraction
 * left on each document in the ledger. Evidence is `sha:issue id`; if the signal is only a flag,
 * `sha:flag`.
 */
function documentSignals(ledger: Ledger): { pagesMissing: Entry; tamper: Entry } {
  if (ledger.documents.length === 0) {
    const note = 'sin estados de cuenta'
    return { pagesMissing: unknown(note), tamper: unknown(note) }
  }
  const missing: string[] = []
  const signals = new Map<TamperSignal, string[]>()
  const add = (signal: TamperSignal, refs: readonly string[]) => signals.set(signal, [...(signals.get(signal) ?? []), ...refs])
  for (const doc of ledger.documents) {
    const s = doc.statement
    const ids = (match: (i: Issue) => boolean): string[] => s.issues.filter(match).map((i) => `${doc.tag}:${i.id}`)
    // A flag with no issue explaining it still counts; its evidence is the flag.
    const flagged = (flag: StatementExtraction['flags'][number], issueCode: Issue['code']): string[] => {
      if (!s.flags.includes(flag)) return []
      const found = ids((i) => i.code === issueCode)
      return found.length > 0 ? found : [`${doc.tag}:${flag}`]
    }
    missing.push(...flagged('pages_missing', 'page_missing'))
    const injection = flagged('possible_prompt_injection', 'possible_prompt_injection')
    if (injection.length > 0) add('prompt_injection', injection)
    const chain = ids((i) => i.code === 'fiscal_chain_mismatch' && i.severity === 'error')
    if (chain.length > 0) add('fiscal_chain_mismatch', chain)
    const stamp = ids((i) => isFiscalStampIssue(i, s))
    if (stamp.length > 0) add('fiscal_stamp_far_from_period', stamp)
    const duplicated = flagged('pages_duplicated', 'duplicate_page_removed')
    if (duplicated.length > 0) add('pages_duplicated', duplicated)
    const header = ids((i) => i.code === 'header_read_conflict')
    if (header.length > 0) add('header_read_conflict', header)
  }
  const list = [...signals.keys()].sort()
  return {
    pagesMissing: known(missing.length > 0, { evidence: missing, note: missing.length > 0 ? 'la paginación que imprime el documento tiene huecos: faltan páginas en el PDF' : null }),
    tamper: known(list, { evidence: [...new Set([...signals.values()].flat())].sort(), note: list.length > 0 ? null : 'sin señales de manipulación en las banderas ni en los problemas de los documentos' }),
  }
}

// ---------------------------------------------------------------------------------------------
// Flow: income, expenses, debt, capacity
// ---------------------------------------------------------------------------------------------

interface Flow {
  incomeRows: LedgerRow[]
  incomeTotal: number
  incomeEntryMeta: { confidence: number; verification: Verification; provenance: ReturnType<typeof combinedProvenance> }
  opexRows: LedgerRow[]
  debtRows: LedgerRow[]
  expenseMeta: { confidence: number; verification: Verification; provenance: ReturnType<typeof combinedProvenance> }
  loanRows: LedgerRow[]
}

export function isIncomeRow(r: LedgerRow, minConfidence: number): boolean {
  return r.type === 'credit' && !r.internal && r.classification.category === 'customer_payment' && r.classification.confidence >= minConfidence
}

function flowOf(ledger: Ledger, minConfidence: number): Flow {
  const live = ledger.rows.filter((r) => !r.internal)
  const credits = live.filter((r) => r.type === 'credit')
  const debits = live.filter((r) => r.type === 'debit')
  const vCredits = credits.filter((r) => r.verified)
  const vDebits = debits.filter((r) => r.verified)

  const incomeRows = vCredits.filter((r) => isIncomeRow(r, minConfidence))
  const incomeTotal = sumMoney(incomeRows.map((r) => r.amount))
  const incomeUnverified = sumMoney(credits.filter((r) => !r.verified && isIncomeRow(r, minConfidence)).map((r) => r.amount))

  // An own transfer or a loan payment stop being operating expense only with enough confidence.
  const isOwn = (r: LedgerRow) => r.classification.category === 'own_transfer' && r.classification.confidence >= minConfidence
  const isDebt = (r: LedgerRow) => r.classification.category === 'loan_payment' || r.classification.category === 'interest'
  const opexRows = vDebits.filter((r) => !isOwn(r) && !isDebt(r))
  const debtRows = vDebits.filter(isDebt)
  const debitsUnverified = sumMoney(debits.filter((r) => !r.verified && !isOwn(r)).map((r) => r.amount))
  const debitsPool = sumMoney(vDebits.map((r) => r.amount))

  return {
    incomeRows,
    incomeTotal,
    // Only deposits with enough confidence count: the doubt is whether any of them is not a
    // customer payment. Uncertain deposits left out are asked about by `decide`.
    incomeEntryMeta: {
      confidence: confidenceOf(incomeRows),
      verification: isMaterial(incomeUnverified, incomeTotal) ? 'unverified' : 'verified',
      provenance: combinedProvenance(incomeRows.map((r) => r.provenance)),
    },
    opexRows,
    debtRows,
    // Every charge counts as expense except an own transfer or a loan payment: mixing up supplier,
    // service or other does not change the total. The real doubt is a charge excluded as an own
    // transfer that was not one; only those weigh with their confidence.
    expenseMeta: {
      confidence: weightedMean(
        vDebits.map((r) => ({ value: isOwn(r) ? r.classification.confidence : 1, weight: r.amount })),
        1,
      ),
      verification: isMaterial(debitsUnverified, debitsPool) ? 'unverified' : 'verified',
      provenance: combinedProvenance([...opexRows, ...debtRows].map((r) => r.provenance)),
    },
    loanRows: vCredits.filter((r) => r.classification.category === 'loan_disbursement'),
  }
}

interface FlowFeatures {
  entries: Entries
  incomeMonthly: number | null
}

function flowFeatures(ctx: StatementContext, cov: Coverage, flow: Flow): FlowFeatures {
  const entries: Entries = {}
  const months = cov.months
  if (cov.days < MIN_DAYS_FOR_MONTHLY) {
    const note = `solo ${String(cov.days)} días cubiertos: no alcanza para promedios mensuales`
    for (const f of ['operating_income_monthly', 'operating_expenses_monthly', 'debt_service_monthly', 'free_cash_flow_monthly', 'payment_capacity_pct', 'debt_capacity', 'external_debt_signal'] as const) entries[f] = unknown(note)
    entries.new_debt_in_period = known(sumMoney(flow.loanRows.map((r) => r.amount)), { evidence: topRefs(flow.loanRows) })
    return { entries, incomeMonthly: null }
  }

  const incomeMonthly = round2(flow.incomeTotal / months)
  const opexTotal = sumMoney(flow.opexRows.map((r) => r.amount))
  const debtTotal = sumMoney(flow.debtRows.map((r) => r.amount))
  const opexMonthly = round2(opexTotal / months)
  const debtMonthly = round2(debtTotal / months)
  const fcf = round2(incomeMonthly - opexMonthly - debtMonthly)
  const combined = {
    confidence: Math.min(flow.incomeEntryMeta.confidence, flow.expenseMeta.confidence),
    verification: worst(flow.incomeEntryMeta.verification, flow.expenseMeta.verification),
    provenance: combinedProvenance([flow.incomeEntryMeta.provenance, flow.expenseMeta.provenance]),
  }
  const perMonth = `${months.toFixed(2)} meses`

  entries.operating_income_monthly = known(incomeMonthly, {
    ...flow.incomeEntryMeta,
    evidence: topRefs(flow.incomeRows),
    note: `${String(flow.incomeRows.length)} abonos de clientes con confianza ≥ ${String(ctx.params.min_classification_confidence)}, total ${String(flow.incomeTotal)} en ${perMonth}${rulesNote(flow.incomeRows)}`,
  })
  entries.operating_expenses_monthly = known(opexMonthly, {
    ...flow.expenseMeta,
    evidence: topRefs(flow.opexRows),
    note: `todo cargo que no es traspaso propio ni pago de crédito (conservador: incluye retiros y consumos), total ${String(opexTotal)} en ${perMonth}`,
  })
  entries.debt_service_monthly = known(debtMonthly, {
    ...flow.expenseMeta,
    evidence: topRefs(flow.debtRows),
    note: `${String(flow.debtRows.length)} pagos a créditos e intereses cobrados, total ${String(debtTotal)} en ${perMonth}`,
  })
  entries.new_debt_in_period = known(sumMoney(flow.loanRows.map((r) => r.amount)), {
    confidence: confidenceOf(flow.loanRows),
    evidence: topRefs(flow.loanRows),
    note: `${String(flow.loanRows.length)} préstamos recibidos`,
  })
  const newDebtTotal = sumMoney(flow.loanRows.map((r) => r.amount))
  entries.external_debt_signal = known(round2(newDebtTotal + debtTotal), {
    confidence: Math.min(confidenceOf(flow.loanRows), flow.expenseMeta.confidence),
    verification: flow.expenseMeta.verification,
    evidence: topRefs([...flow.loanRows, ...flow.debtRows]),
    note: `préstamos recibidos (${String(newDebtTotal)}) + pagos a créditos (${String(debtTotal)}) en el periodo`,
  })
  entries.free_cash_flow_monthly = known(fcf, { ...combined, note: 'ingresos operativos − gastos operativos − servicio de deuda, mensual' })
  entries.payment_capacity_pct =
    incomeMonthly > 0 ? known(round4(fcf / incomeMonthly), { ...combined, note: 'flujo libre / ingresos operativos' }) : unknown('sin ingresos operativos: la capacidad de pago no está definida')
  entries.debt_capacity = known(round2(Math.max(0, fcf) * ctx.params.debt_capacity_months), {
    ...combined,
    note: `flujo libre mensual positivo × ${String(ctx.params.debt_capacity_months)} meses`,
  })
  return { entries, incomeMonthly }
}

// ---------------------------------------------------------------------------------------------
// Daily balances and trend
// ---------------------------------------------------------------------------------------------

interface DailyBalances {
  avg: number
  lowDays: number
  min: number
  verification: Verification
}

/**
 * End-of-day balance, summing the accounts that cover that day. Walks from the printed opening
 * balance; in a consolidated summary internal transfers do not move the balance.
 */
function dailyBalances(ledger: Ledger, threshold: number): DailyBalances | string {
  const perDay = new Map<number, number>()
  let verification: Verification = 'verified'
  for (const p of ledger.periods) {
    if (p.start === null || p.end === null) return `el periodo ${p.period.id} de ${p.doc.tag} no tiene fechas`
    const opening = p.period.summary.opening_balance
    if (opening.value === null) return `el periodo ${p.period.id} de ${p.doc.tag} no imprime saldo inicial`
    verification = worst(verification, opening.verification)
    const byDay = new Map<number, number>()
    for (const r of ledger.rows) {
      if (r.period !== p || (p.excludesInternal && r.internal)) continue
      const d = Math.min(Math.max(r.day, p.start), p.end)
      byDay.set(d, (byDay.get(d) ?? 0) + Math.round((r.type === 'credit' ? 1 : -1) * r.amount * 100))
    }
    let cents = Math.round(opening.value * 100)
    for (let d = p.start; d <= p.end; d++) {
      cents += byDay.get(d) ?? 0
      perDay.set(d, (perDay.get(d) ?? 0) + cents)
    }
  }
  if (perDay.size === 0) return 'sin días cubiertos'
  const values = [...perDay.values()]
  const avg = round2(values.reduce((s, c) => s + c, 0) / values.length / 100)
  const lowDays = values.filter((c) => c / 100 < threshold).length
  return { avg, lowDays, min: Math.min(...values) / 100, verification }
}

/**
 * Month-over-month income slope: the covered timeline (no gaps between documents) is split into
 * as many equal windows as months of history; least-squares slope over each window's income,
 * divided by the mean.
 */
function incomeTrend(cov: Coverage, monthsOfHistory: number, incomeRows: readonly LedgerRow[]): number | string {
  if (monthsOfHistory < 3) return `requiere 3 meses o más; hay ${String(monthsOfHistory)}`
  const offsetOf = (day: number): number => {
    let offset = 0
    for (const s of cov.segments) {
      if (day > s.end) offset += s.end - s.start + 1
      else return offset + Math.max(0, day - s.start)
    }
    return offset
  }
  const n = monthsOfHistory
  const windowLen = cov.days / n
  const sums = new Array<number>(n).fill(0)
  for (const r of incomeRows) {
    const w = Math.min(n - 1, Math.floor(offsetOf(r.day) / windowLen))
    sums[w] = (sums[w] ?? 0) + r.amount
  }
  const mean = sums.reduce((a, b) => a + b, 0) / n
  if (mean <= 0) return 'sin ingresos operativos'
  const xMean = (n - 1) / 2
  let num = 0
  let den = 0
  sums.forEach((y, x) => {
    num += (x - xMean) * (y - mean)
    den += (x - xMean) ** 2
  })
  return round4(num / den / mean)
}

// ---------------------------------------------------------------------------------------------
// Buyer, payers, fiscal block
// ---------------------------------------------------------------------------------------------

function buyerFeatures(ctx: StatementContext): Entries {
  const buyer = ctx.request?.buyer ?? null
  if (buyer === null) {
    const note = 'la solicitud no trae comprador'
    return { buyer_payments_count: unknown(note), buyer_payments_amount: unknown(note) }
  }
  const rows = ctx.ledger.rows.filter((r) => r.type === 'credit' && !r.internal && r.verified && r.buyerMatch !== null)
  const byRfc = rows.length > 0 && rows.every((r) => r.buyerMatch === 'rfc')
  const declared = ctx.buyerDeclared === true
  const meta = {
    confidence: byRfc ? 1 : 0.9,
    evidence: topRefs(rows),
    // The name came from the owner; payments come from the document.
    provenance: declared ? ('owner_answer' as const) : ('extracted' as const),
    note: `${rows.length > 0 ? `reconocidos por ${byRfc ? 'RFC' : 'nombre o alias'}` : `ningún abono menciona a ${buyer.name}${buyer.rfc ? ' ni su RFC' : ''}`}${declared ? '; comprador declarado por el dueño como su cliente principal' : ''}`,
  }
  return {
    buyer_payments_count: known(rows.length, meta),
    buyer_payments_amount: known(sumMoney(rows.map((r) => r.amount)), meta),
  }
}

/** Payer key: printed RFC, the recognized buyer or the name the classifier gave. */
function payerKey(r: LedgerRow): string | null {
  if (r.classification.counterparty_rfc) return `rfc:${r.classification.counterparty_rfc}`
  if (r.buyerMatch !== null) return 'buyer'
  if (r.classification.counterparty) return `name:${normalizeText(r.classification.counterparty)}`
  return null
}

function payerFeatures(flow: Flow): Entries {
  if (flow.incomeTotal <= 0) {
    const note = 'sin ingresos operativos'
    return { recurring_income_share: unknown(note), top_payer_concentration: unknown(note) }
  }
  const groups = new Map<string, LedgerRow[]>()
  for (const r of flow.incomeRows) {
    const k = payerKey(r)
    if (k === null) continue
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const identified = sumMoney([...groups.values()].flat().map((r) => r.amount))
  const share = identified / flow.incomeTotal
  if (share < MIN_IDENTIFIED_SHARE) {
    const note = `pagador identificado en ${(share * 100).toFixed(0)} % de los ingresos (mínimo ${String(MIN_IDENTIFIED_SHARE * 100)} %): las descripciones no traen RFC ni nombre reconocible`
    return { recurring_income_share: unknown(note), top_payer_concentration: unknown(note) }
  }
  const totals = [...groups.entries()].map(([k, rows]) => ({ k, total: sumMoney(rows.map((r) => r.amount)), dates: new Set(rows.map((r) => r.day)).size }))
  const top = totals.reduce((a, b) => (b.total > a.total ? b : a))
  const recurring = sumMoney(totals.filter((t) => t.dates >= 2).map((t) => t.total))
  const confidence = clamp01(share * flow.incomeEntryMeta.confidence)
  return {
    top_payer_concentration: known(round4(top.total / identified), { confidence, verification: flow.incomeEntryMeta.verification, note: `${String(groups.size)} pagadores identificados (${(share * 100).toFixed(0)} % de los ingresos)` }),
    recurring_income_share: known(round4(recurring / identified), { confidence, verification: flow.incomeEntryMeta.verification, note: 'pagadores con abonos en dos fechas o más' }),
  }
}

// ---------------------------------------------------------------------------------------------

export interface StatementFeatures {
  entries: Entries
  coverage: Coverage
  flow: Flow
}

export function statementFeatures(ctx: StatementContext): StatementFeatures {
  const entries: Entries = {}
  const ledger = ctx.ledger
  const cov = coverageOf(ledger)
  const minConf = ctx.params.min_classification_confidence

  entries.months_of_history = monthsOfHistory(ledger, cov)
  entries.document_age_days = documentAgeDays(ctx)
  entries.identity_match = identityMatch(ctx)
  entries.integrity_ok = integrityOk(ledger)
  entries.activity_count = ledger.documents.length > 0 ? known(ledger.rows.filter((r) => !r.internal).length, { note: 'movimientos sin traspasos internos' }) : unknown('sin estados de cuenta')

  const flow = flowOf(ledger, minConf)
  const ff = flowFeatures(ctx, cov, flow)
  Object.assign(entries, ff.entries)

  const balances = dailyBalances(ledger, ctx.params.low_balance_threshold)
  if (typeof balances === 'string') {
    entries.avg_daily_balance = unknown(balances)
    entries.low_balance_days = unknown(balances)
  } else {
    entries.avg_daily_balance = known(balances.avg, { verification: balances.verification, note: 'saldo al cierre de cada día, sumando cuentas' })
    entries.low_balance_days = known(balances.lowDays, { verification: balances.verification, note: `días bajo ${String(ctx.params.low_balance_threshold)}` })
  }
  entries.red_flags = redFlags(ledger, typeof balances === 'string' ? null : balances.min, allPeriodsReconciled(ledger))

  const monthsValue = typeof entries.months_of_history.value === 'number' ? entries.months_of_history.value : 0
  const trend = incomeTrend(cov, monthsValue, flow.incomeRows)
  entries.income_trend = typeof trend === 'string' ? unknown(trend) : known(trend, { ...flow.incomeEntryMeta, note: `${String(monthsValue)} ventanas iguales sobre los días cubiertos` })

  Object.assign(entries, buyerFeatures(ctx), payerFeatures(flow))

  entries.fiscal_regime = fiscalRegime(ctx)
  entries.fiscal_anchor_ok = fiscalAnchor(ctx)
  entries.regime_income_plausible = regimeIncomePlausible(entries.fiscal_regime, ff.incomeMonthly, entries.operating_income_monthly)

  const signals = documentSignals(ledger)
  entries.holder_address_present = holderAddressPresent(ledger)
  entries.document_pages_missing = signals.pagesMissing
  entries.document_tamper_signals = signals.tamper

  return { entries, coverage: cov, flow }
}
