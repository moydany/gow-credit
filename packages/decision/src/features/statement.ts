/**
 * Features que salen de los estados de cuenta (docs/03 §3, docs/09 §5 y §9). Reglas comunes:
 *
 * - Los meses salen de los días cubiertos (unión de periodos), no del número de periodos
 *   (ADR 0006): Mercado Pago imprime un periodo de 91 días y cuenta como 3 meses.
 * - Los traspasos internos (ADR 0009) no son ingreso ni gasto.
 * - Un movimiento `unverified` o `conflict` no suma (docs/04 §5); si lo que se dejó fuera es
 *   material, la feature queda `unverified` y el motor decide si eso cambia la banda.
 * - La confianza de una feature que depende de la clasificación es la confianza media de los
 *   movimientos que la alimentan, ponderada por monto.
 */
import { checkClabe, checkRfc, FISCAL_REGIMES, type ApplicationRequest, type ProfileParameters, type SupplierIdentity, type Verification } from '@gow/contracts'
import { evidenceRef, type Ledger, type LedgerRow } from '../ledger.ts'
import { AVG_MONTH_DAYS, intervalDays, toDay, unionIntervals, type Interval } from '../util/dates.ts'
import { clamp01, round2, round4, sumMoney, weightedMean } from '../util/num.ts'
import { nameSimilarity, normalizeText } from '../util/text.ts'
import { combinedProvenance, known, unknown, worst, type Entries, type Entry } from './entry.ts'

export interface StatementContext {
  ledger: Ledger
  request: ApplicationRequest | null
  supplier: SupplierIdentity | null
  params: ProfileParameters
  asOfDay: number
}

/** Un mes con tolerancia de unos 3 días: febrero o un corte a mitad de mes cuentan como mes completo. */
const MONTH_TOLERANCE = 0.1
/** Menos de una semana cubierta no alcanza para promedios mensuales. */
const MIN_DAYS_FOR_MONTHLY = 7
/** Tope de ingresos anuales de RESICO persona física (régimen 626), docs/09 §9.5. */
export const RESICO_ANNUAL_CAP = 3_500_000
/** Tolerancia del ancla fiscal: comisiones del CFDI contra filas de comisión. */
const FISCAL_ANCHOR_TOLERANCE = 1
/** Debajo de esta parte de ingresos con pagador identificado, concentración y recurrencia son desconocidas. */
const MIN_IDENTIFIED_SHARE = 0.5

export interface Coverage {
  segments: Interval[]
  days: number
  /** Meses fraccionarios: días / 30.4375. */
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

/** Movimientos que pesan en una feature: los 25 de mayor monto, como evidencia. */
function topRefs(rows: readonly LedgerRow[]): string[] {
  return [...rows].sort((a, b) => b.amount - a.amount || a.day - b.day).map(evidenceRef)
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
// Historia, antigüedad, identidad, integridad, banderas
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
    // La fecha de timbrado del CFDI es una marca del SAT (docs/09 §9.6): si es anterior al corte
    // impreso, manda ella. Así un corte editado hacia adelante no rejuvenece el documento.
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

type FieldResult = 'match' | 'partial' | 'mismatch' | null

const MASK_CHARS = /[*•#]/

function cleanId(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase()
}

/** Compara posición por posición, saltando las enmascaradas. */
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
  const check = checkRfc(a)
  if (check.result === 'valid') return check.kind === 'generic' ? null : a === b ? 'match' : 'mismatch'
  if (check.result === 'masked') return compareMasked(a, b)
  return null
}

export function compareClabe(docClabe: string, registered: readonly string[]): FieldResult {
  if (registered.length === 0) return null
  const a = docClabe.replace(/[\s-]/g, '')
  const check = checkClabe(a)
  const regs = registered.map((r) => r.replace(/[\s-]/g, ''))
  if (check === 'valid') return regs.includes(a) ? 'match' : 'mismatch'
  if (check === 'masked') return regs.some((r) => compareMasked(a, r) === 'partial') ? 'partial' : 'mismatch'
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
  const results: { field: 'rfc' | 'name' | 'clabe'; result: FieldResult; verification: Verification; where: string }[] = []
  for (const doc of ctx.ledger.documents) {
    const s = doc.statement
    if (supplier.rfc !== null) {
      if (s.holder.rfc.value !== null) results.push({ field: 'rfc', result: compareRfc(s.holder.rfc.value, supplier.rfc), verification: s.holder.rfc.verification, where: `${doc.tag}:holder.rfc` })
      // El encabezado suele enmascarar el RFC; el CFDI lo imprime completo (docs/09 §4.6).
      for (const f of s.fiscal_documents) {
        if (f.receiver.rfc.value !== null) results.push({ field: 'rfc', result: compareRfc(f.receiver.rfc.value, supplier.rfc), verification: f.receiver.rfc.verification, where: `${doc.tag}:${f.id}.receiver.rfc` })
      }
    }
    if (s.holder.name.value !== null) results.push({ field: 'name', result: compareName(s.holder.name.value, supplier.legal_name), verification: s.holder.name.verification, where: `${doc.tag}:holder.name` })
    for (const a of s.accounts) {
      if (a.clabe.value !== null) results.push({ field: 'clabe', result: compareClabe(a.clabe.value, supplier.clabes), verification: a.clabe.verification, where: `${doc.tag}:${a.id}.clabe` })
    }
  }
  const compared = results.filter((r) => r.result !== null)
  if (compared.length === 0) return unknown('titular, RFC y CLABE no vienen en el documento o no se pueden comparar (redactados o enmascarados)')
  const verification = worst(...compared.map((r) => r.verification))
  const evidence = compared.map((r) => `${r.where}=${r.result ?? ''}`)
  const has = (field: string, result: FieldResult) => compared.some((r) => r.field === field && r.result === result)
  let value: 'match' | 'partial' | 'mismatch'
  if (compared.some((r) => r.result === 'mismatch')) value = 'mismatch'
  else if (has('rfc', 'match') || (has('name', 'match') && has('clabe', 'match'))) value = 'match'
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

function redFlags(ledger: Ledger, minDailyBalance: number | null): Entry {
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
  if (minDailyBalance !== null && minDailyBalance < 0) add('overdraft', true, 'saldo diario calculado')
  const flags = [...found.keys()].sort()
  const verification: Verification = [...found.values()].every((f) => f.verified) ? 'verified' : 'unverified'
  return known(flags, { verification, evidence: [...found.values()].flatMap((f) => f.refs), note: flags.length > 0 ? null : 'sin señales graves en las descripciones ni saldos negativos' })
}

// ---------------------------------------------------------------------------------------------
// Flujo: ingresos, gastos, deuda, capacidad
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

  // Un traspaso propio o un pago de crédito solo dejan de ser gasto operativo con confianza suficiente.
  const isOwn = (r: LedgerRow) => r.classification.category === 'own_transfer' && r.classification.confidence >= minConfidence
  const isDebt = (r: LedgerRow) => r.classification.category === 'loan_payment' || r.classification.category === 'interest'
  const opexRows = vDebits.filter((r) => !isOwn(r) && !isDebt(r))
  const debtRows = vDebits.filter(isDebt)
  const debitsUnverified = sumMoney(debits.filter((r) => !r.verified && !isOwn(r)).map((r) => r.amount))
  const debitsPool = sumMoney(vDebits.map((r) => r.amount))

  return {
    incomeRows,
    incomeTotal,
    // Solo cuentan los abonos con confianza suficiente: la duda es si alguno de ellos no es pago
    // de cliente. Los abonos inciertos que se dejaron fuera los pregunta `decide` (docs/03 §7).
    incomeEntryMeta: {
      confidence: confidenceOf(incomeRows),
      verification: isMaterial(incomeUnverified, incomeTotal) ? 'unverified' : 'verified',
      provenance: combinedProvenance(incomeRows.map((r) => r.provenance)),
    },
    opexRows,
    debtRows,
    // Todo cargo cuenta como gasto salvo un traspaso propio o un pago de crédito: equivocarse entre
    // proveedor, servicio u otro no cambia el total. La duda real es un cargo excluido como traspaso
    // propio que no lo era; por eso solo esos pesan con su confianza.
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
// Saldos diarios y tendencia
// ---------------------------------------------------------------------------------------------

interface DailyBalances {
  avg: number
  lowDays: number
  min: number
  verification: Verification
}

/**
 * Saldo al cierre de cada día, sumando las cuentas que cubren ese día. Se camina desde el saldo
 * inicial impreso; en un resumen consolidado (ADR 0009) los traspasos internos no mueven el saldo.
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
 * Pendiente de ingresos mes a mes: la línea de tiempo cubierta (sin huecos entre documentos)
 * se parte en tantas ventanas iguales como meses de historia; pendiente de mínimos cuadrados
 * sobre el ingreso de cada ventana, dividida entre el promedio.
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
// Comprador, pagadores, bloque fiscal
// ---------------------------------------------------------------------------------------------

function buyerFeatures(ctx: StatementContext): Entries {
  const buyer = ctx.request?.buyer ?? null
  if (buyer === null) {
    const note = 'la solicitud no trae comprador'
    return { buyer_payments_count: unknown(note), buyer_payments_amount: unknown(note) }
  }
  const rows = ctx.ledger.rows.filter((r) => r.type === 'credit' && !r.internal && r.verified && r.buyerMatch !== null)
  const byRfc = rows.length > 0 && rows.every((r) => r.buyerMatch === 'rfc')
  const meta = {
    confidence: byRfc ? 1 : 0.9,
    evidence: topRefs(rows),
    note: rows.length > 0 ? `reconocidos por ${byRfc ? 'RFC' : 'nombre o alias'}` : `ningún abono menciona a ${buyer.name}${buyer.rfc ? ' ni su RFC' : ''}`,
  }
  return {
    buyer_payments_count: known(rows.length, meta),
    buyer_payments_amount: known(sumMoney(rows.map((r) => r.amount)), meta),
  }
}

/** Llave del pagador: RFC impreso, el comprador reconocido o el nombre que dio el clasificador. */
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

/** "601 General de Ley Personas Morales" → 601; una clave fuera del catálogo → other. */
export function regimeCode(raw: string): (typeof FISCAL_REGIMES)[number] | null {
  const m = /^\s*(\d{3})\b/.exec(raw)
  if (!m) return null
  const code = m[1] ?? ''
  return (FISCAL_REGIMES as readonly string[]).includes(code) ? (code as (typeof FISCAL_REGIMES)[number]) : 'other'
}

function fiscalRegime(ctx: StatementContext): Entry {
  // El documento más reciente manda; si dos documentos dicen regímenes distintos, es conflicto.
  const found: { code: string; verification: Verification; where: string; end: number }[] = []
  for (const doc of ctx.ledger.documents) {
    const end = Math.max(...ctx.ledger.periods.filter((p) => p.doc === doc).map((p) => p.end ?? 0))
    const fiscal = [...doc.statement.fiscal_documents].sort((a, b) => (a.kind === 'income' ? 0 : 1) - (b.kind === 'income' ? 0 : 1))
    for (const f of fiscal) {
      const raw = f.receiver.tax_regime.value
      const code = raw === null ? null : regimeCode(raw)
      if (code === null) continue
      found.push({ code, verification: f.receiver.tax_regime.verification, where: `${doc.tag}:${f.id}.receiver.tax_regime`, end })
      break
    }
  }
  if (found.length === 0) return unknown('sin CFDI o el CFDI no imprime el régimen del receptor')
  found.sort((a, b) => b.end - a.end)
  const latest = found[0]
  if (!latest) return unknown('sin régimen')
  const conflict = found.some((f) => f.code !== latest.code)
  return known(latest.code, {
    verification: conflict ? 'conflict' : latest.verification,
    evidence: found.map((f) => `${f.where}=${f.code}`),
    note: conflict ? 'los documentos traen regímenes distintos' : null,
  })
}

/**
 * Ancla fiscal (docs/09 §9.1): el CFDI de comisiones lo firma el SAT, fuera del PDF editable.
 * Las filas de comisión del documento deben sumar su total (si el banco detalla el IVA) o su
 * subtotal (si no). Un documento sin importes en el CFDI no cuenta.
 */
function fiscalAnchor(ctx: StatementContext): Entry {
  const checks: { ok: boolean; where: string; verification: Verification }[] = []
  for (const doc of ctx.ledger.documents) {
    for (const f of doc.statement.fiscal_documents) {
      if (f.kind !== 'income') continue
      const total = f.total.value ?? (f.subtotal.value !== null && f.tax.value !== null ? round2(f.subtotal.value + f.tax.value) : null)
      const subtotal = f.subtotal.value
      if (total === null && subtotal === null) continue
      const feeRows = ctx.ledger.rows.filter((r) => r.doc === doc && r.type === 'debit' && r.classification.category === 'fee')
      const fees = sumMoney(feeRows.map((r) => r.amount))
      const ok = (total !== null && Math.abs(fees - total) <= FISCAL_ANCHOR_TOLERANCE) || (subtotal !== null && Math.abs(fees - subtotal) <= FISCAL_ANCHOR_TOLERANCE)
      const verification = worst(f.total.verification, f.subtotal.verification, ...feeRows.map((r) => (r.verified ? 'verified' : 'unverified')))
      checks.push({ ok, where: `${doc.tag}:${f.id} comisiones=${String(fees)} cfdi=${String(total ?? subtotal)}`, verification })
    }
  }
  if (checks.length === 0) return unknown('ningún CFDI de comisiones con importes impresos')
  return known(
    checks.every((c) => c.ok),
    { verification: worst(...checks.map((c) => c.verification)), evidence: checks.map((c) => c.where), note: checks.every((c) => c.ok) ? null : 'las comisiones del estado de cuenta no suman lo que firmó el SAT' },
  )
}

function regimeIncomePlausible(regime: Entry, incomeMonthly: number | null, incomeEntry: Entry | undefined): Entry {
  if (regime.value === null) return unknown('sin régimen fiscal')
  if (regime.value !== '626') return known(true, { verification: regime.verification, note: `el régimen ${String(regime.value)} no tiene tope de ingresos` })
  if (incomeMonthly === null || incomeEntry === undefined) return unknown('sin ingresos operativos mensuales')
  const annual = round2(incomeMonthly * 12)
  return known(annual <= RESICO_ANNUAL_CAP, {
    confidence: incomeEntry.confidence,
    verification: worst(regime.verification, incomeEntry.verification),
    note: `RESICO: ingresos operativos anualizados ${String(annual)} contra tope ${String(RESICO_ANNUAL_CAP)}`,
  })
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
  entries.red_flags = redFlags(ledger, typeof balances === 'string' ? null : balances.min)

  const monthsValue = typeof entries.months_of_history.value === 'number' ? entries.months_of_history.value : 0
  const trend = incomeTrend(cov, monthsValue, flow.incomeRows)
  entries.income_trend = typeof trend === 'string' ? unknown(trend) : known(trend, { ...flow.incomeEntryMeta, note: `${String(monthsValue)} ventanas iguales sobre los días cubiertos` })

  Object.assign(entries, buyerFeatures(ctx), payerFeatures(flow))

  entries.fiscal_regime = fiscalRegime(ctx)
  entries.fiscal_anchor_ok = fiscalAnchor(ctx)
  entries.regime_income_plausible = regimeIncomePlausible(entries.fiscal_regime, ff.incomeMonthly, entries.operating_income_monthly)

  return { entries, coverage: cov, flow }
}
