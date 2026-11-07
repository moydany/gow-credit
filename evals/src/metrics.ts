/**
 * Extraction metrics against ground truth. Pure: they take the extraction (contract) and the
 * ground truth and return numbers; no model or I/O.
 *
 * - Movement precision = 1 - invention rate (extracted rows that don't exist).
 * - Movement recall = 1 - omission rate (bank rows that are missing).
 * - Per-matched-row accuracy: date, amount, direction, balance, description (fuzzy), internal
 *   transfer.
 * - Header and summary accuracy per field; CFDI accuracy per field.
 * - First-pass reconciliation: all periods reconcile without re-reading.
 */
import type { StatementExtraction, Transaction } from '@gow/contracts'
import { costUsd } from '@gow/llm'
import type { GroundTruth, GtTransaction } from './ground-truth/schema.ts'

// ---------- text

const STOP = new Set(['de', 'del', 'la', 'el', 'en', 'por', 'a', 'al', 'y', 'los', 'las', 'con'])

export function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

/**
 * Fraction of `part`'s tokens that appear in `whole` (multiset). A long token also counts if it
 * appears inside the text without spaces: the text layer sometimes glues words ("RECIBIDOCITI")
 * that the model separates, and vice versa. Short operation codes (T17, A15) aren't required.
 */
export function containment(part: string, whole: string): number {
  const p = tokens(part).filter((t) => !(t.length <= 3 && /\d/.test(t) && /[a-z]/.test(t)))
  if (p.length === 0) return 1
  const wholeTokens = tokens(whole)
  const glued = wholeTokens.join('')
  const bag = new Map<string, number>()
  for (const t of wholeTokens) bag.set(t, (bag.get(t) ?? 0) + 1)
  let hit = 0
  for (const t of p) {
    const n = bag.get(t) ?? 0
    if (n > 0) {
      hit++
      bag.set(t, n - 1)
    } else if (t.length >= 4 && glued.includes(t)) hit++
    else if (t.length >= 8 && wholeTokens.some((w) => w.length >= 3 && t.includes(w)) && wholeTokens.filter((w) => w.length >= 3 && t.includes(w)).join('').length >= t.length * 0.8) hit++
  }
  return hit / p.length
}

export const DESCRIPTION_THRESHOLD = 0.7

/**
 * Fuzzy description: the model's text (description + reference) must contain the first line of the
 * bank's description and carry no text that isn't in the bank's row (description + reference).
 * Where the reference ended up doesn't count (convention in evals/ground-truth/README.md).
 */
export function descriptionMatches(gt: Pick<GtTransaction, 'description' | 'description_head' | 'reference'>, ex: { description: string; reference: string | null }): boolean {
  const exText = `${ex.description} ${ex.reference ?? ''}`
  const gtText = `${gt.description} ${gt.reference ?? ''}`
  return containment(gt.description_head, exText) >= DESCRIPTION_THRESHOLD && containment(exText, gtText) >= DESCRIPTION_THRESHOLD
}

// ---------- row matching

export interface FlatTx {
  page: number
  date: string
  amount: number
  type: 'credit' | 'debit'
  balance: number | null
  description: string
  reference: string | null
  internal_transfer: boolean
}

export interface Pair {
  gt: GtTransaction
  ex: FlatTx
  /** exact: same date, amount and direction; loose: matched despite one misread field. */
  kind: 'exact' | 'loose'
}

export interface MatchResult {
  pairs: Pair[]
  invented: FlatTx[]
  omitted: GtTransaction[]
}

const cents = (n: number) => Math.round(n * 100)
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000

/**
 * Matches rows in two rounds. First exact ones by (date, amount, direction), preferring the same
 * page and order. Then, among the leftovers, rows with a single misread field: same amount and a
 * nearby page (different date or direction), or same date, direction and page with an equivalent
 * description (different amount). What remains are inventions and omissions.
 */
export function matchTransactions(gt: readonly GtTransaction[], ex: readonly FlatTx[]): MatchResult {
  const usedEx = new Set<number>()
  const usedGt = new Set<number>()
  const pairs: Pair[] = []
  const byKey = new Map<string, number[]>()
  ex.forEach((e, i) => {
    const k = `${e.date}|${String(cents(e.amount))}|${e.type}`
    byKey.set(k, [...(byKey.get(k) ?? []), i])
  })
  gt.forEach((g, gi) => {
    const k = `${g.date}|${String(cents(g.amount))}|${g.type}`
    const candidates = (byKey.get(k) ?? []).filter((i) => !usedEx.has(i))
    if (candidates.length === 0) return
    const best = candidates.reduce((a, b) => (Math.abs((ex[a]?.page ?? 0) - g.page) <= Math.abs((ex[b]?.page ?? 0) - g.page) ? a : b))
    usedEx.add(best)
    usedGt.add(gi)
    const e = ex[best]
    if (e) pairs.push({ gt: g, ex: e, kind: 'exact' })
  })
  gt.forEach((g, gi) => {
    if (usedGt.has(gi)) return
    let found = -1
    for (let i = 0; i < ex.length && found < 0; i++) {
      const e = ex[i]
      if (!e || usedEx.has(i) || Math.abs(e.page - g.page) > 1) continue
      const sameAmount = cents(e.amount) === cents(g.amount)
      const oneFieldOff = (sameAmount && (dayDiff(e.date, g.date) <= 31 || e.type !== g.type)) || (!sameAmount && e.date === g.date && e.type === g.type && descriptionMatches(g, e))
      if (oneFieldOff) found = i
    }
    const e = ex[found]
    if (found >= 0 && e) {
      usedEx.add(found)
      usedGt.add(gi)
      pairs.push({ gt: g, ex: e, kind: 'loose' })
    }
  })
  return {
    pairs,
    invented: ex.filter((_, i) => !usedEx.has(i)),
    omitted: gt.filter((_, i) => !usedGt.has(i)),
  }
}

// ---------- fields

export interface FieldScore {
  field: string
  ok: boolean
  /** No value printed in the ground truth and the model invented one. */
  invented: boolean
}

type NullPolicy = 'must_be_null' | 'skip'

function normId(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
function normDigits(v: string): string {
  return v.replace(/\D/g, '')
}
function normDateTime(v: string): string {
  return v.replace(/[^0-9]/g, '').slice(0, 14)
}

export function scoreField(field: string, gt: string | number | null, ex: string | number | null | undefined, policy: NullPolicy, kind: 'id' | 'digits' | 'money' | 'datetime' | 'exact' = 'exact'): FieldScore | null {
  const exv = ex ?? null
  if (gt === null) {
    if (policy === 'skip') return null
    const empty = exv === null || (typeof exv === 'string' && normId(exv) === '')
    return { field, ok: empty, invented: !empty }
  }
  if (exv === null) return { field, ok: false, invented: false }
  let ok: boolean
  if (kind === 'money') ok = typeof exv === 'number' && typeof gt === 'number' && Math.abs(exv - gt) < 0.005
  else if (kind === 'id') ok = normId(String(exv)) === normId(String(gt))
  else if (kind === 'digits') ok = normDigits(String(exv)) === normDigits(String(gt)) && normDigits(String(gt)).length > 0
  else if (kind === 'datetime') ok = normDateTime(String(exv)) === normDateTime(String(gt))
  else ok = String(exv) === String(gt)
  return { field, ok, invented: false }
}

// ---------- document

export interface DocumentScore {
  file: string
  bank: string
  gt_transactions: number
  ex_transactions: number
  matched: number
  invented: number
  omitted: number
  precision: number
  recall: number
  row_fields: { date: number; amount: number; type: number; balance: number; description: number; internal_transfer: number }
  header: { total: number; ok: number; invented: number; failed: string[] }
  fiscal: { total: number; ok: number; invented: number; failed: string[]; fiscal_documents_gt: number; fiscal_documents_ex: number }
  reconciled_final: boolean
  reconciled_first_pass: boolean
  retry_pages: number
  /** Pages with omitted or invented rows (to locate them). */
  pages_with_errors: number[]
  cost_usd: number
  models: string[]
}

export function flatten(doc: StatementExtraction): FlatTx[] {
  return doc.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions.map((t: Transaction) => ({ page: t.source.page, date: t.date, amount: t.amount, type: t.type, balance: t.balance, description: t.description, reference: t.reference, internal_transfer: t.internal_transfer }))))
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b)

export function scoreDocument(doc: StatementExtraction, gt: GroundTruth): DocumentScore {
  const gtTx = gt.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions))
  const exTx = flatten(doc)
  const m = matchTransactions(gtTx, exTx)
  const n = m.pairs.length
  const withBalance = m.pairs.filter((p) => p.gt.balance !== null)
  const row_fields = {
    date: ratio(m.pairs.filter((p) => p.ex.date === p.gt.date).length, n),
    amount: ratio(m.pairs.filter((p) => cents(p.ex.amount) === cents(p.gt.amount)).length, n),
    type: ratio(m.pairs.filter((p) => p.ex.type === p.gt.type).length, n),
    balance: ratio(withBalance.filter((p) => p.ex.balance !== null && cents(p.ex.balance) === cents(p.gt.balance ?? 0)).length, withBalance.length),
    description: ratio(m.pairs.filter((p) => descriptionMatches(p.gt, p.ex)).length, n),
    internal_transfer: ratio(m.pairs.filter((p) => p.ex.internal_transfer === p.gt.internal_transfer).length, n),
  }

  // Header and summary: accounts matched by shared movements, then by order.
  const header: FieldScore[] = []
  const add = (s: FieldScore | null) => {
    if (s) header.push(s)
  }
  add(scoreField('holder.name', gt.holder.name.value, doc.holder.name.value, 'must_be_null', 'id'))
  add(scoreField('holder.rfc', gt.holder.rfc.value, doc.holder.rfc.value, 'must_be_null', 'id'))
  const exAccounts = [...doc.accounts]
  const taken = new Set<number>()
  gt.accounts.forEach((ga, gi) => {
    const gaKeys = new Set(ga.periods.flatMap((p) => p.transactions.map((t) => `${t.date}|${String(cents(t.amount))}`)))
    let best = -1
    let bestOverlap = 0
    exAccounts.forEach((ea, ei) => {
      if (taken.has(ei)) return
      const overlap = ea.periods.flatMap((p) => p.transactions).filter((t) => gaKeys.has(`${t.date}|${String(cents(t.amount))}`)).length
      if (overlap > bestOverlap) {
        best = ei
        bestOverlap = overlap
      }
    })
    if (best < 0) best = exAccounts.findIndex((_, ei) => !taken.has(ei) && ei >= gi)
    if (best < 0) best = exAccounts.findIndex((_, ei) => !taken.has(ei))
    const ea = exAccounts[best]
    const prefix = `account[${ga.key}]`
    if (!ea) {
      header.push({ field: `${prefix}.missing`, ok: false, invented: false })
      return
    }
    taken.add(best)
    add(scoreField(`${prefix}.account_number`, ga.account_number.value, ea.account_number.value, 'must_be_null', 'digits'))
    add(scoreField(`${prefix}.clabe`, ga.clabe.value, ea.clabe.value, 'must_be_null', 'digits'))
    add(scoreField(`${prefix}.currency`, ga.currency.value, ea.currency.value, 'skip'))
    ga.periods.forEach((gp, pi) => {
      const ep = ea.periods[pi]
      const pp = `${prefix}.${gp.key}`
      if (!ep) {
        header.push({ field: `${pp}.missing`, ok: false, invented: false })
        return
      }
      add(scoreField(`${pp}.period_start`, gp.period_start.value, ep.period_start.value, 'skip'))
      add(scoreField(`${pp}.period_end`, gp.period_end.value, ep.period_end.value, 'skip'))
      add(scoreField(`${pp}.opening_balance`, gp.opening_balance.value, ep.summary.opening_balance.value, 'skip', 'money'))
      add(scoreField(`${pp}.closing_balance`, gp.closing_balance.value, ep.summary.closing_balance.value, 'skip', 'money'))
      add(scoreField(`${pp}.total_credits`, gp.total_credits.value, ep.summary.total_credits.value, 'skip', 'money'))
      add(scoreField(`${pp}.total_debits`, gp.total_debits.value, ep.summary.total_debits.value, 'skip', 'money'))
      add(scoreField(`${pp}.credits_count`, gp.credits_count.value, ep.summary.credits_count.value, 'skip'))
      add(scoreField(`${pp}.debits_count`, gp.debits_count.value, ep.summary.debits_count.value, 'skip'))
    })
  })
  if (exAccounts.length > gt.accounts.length) header.push({ field: 'accounts.extra', ok: false, invented: true })

  // CFDI: matched by UUID, then by order.
  const fiscal: FieldScore[] = []
  const usedF = new Set<number>()
  gt.fiscal_documents.forEach((gf, i) => {
    let ei = doc.fiscal_documents.findIndex((f, j) => !usedF.has(j) && f.uuid.value !== null && gf.uuid.value !== null && normId(f.uuid.value) === normId(gf.uuid.value))
    if (ei < 0) ei = doc.fiscal_documents.findIndex((_, j) => !usedF.has(j))
    const ef = doc.fiscal_documents[ei]
    const p = `cfdi[${String(i + 1)}]`
    if (!ef) {
      fiscal.push({ field: `${p}.missing`, ok: false, invented: false })
      return
    }
    usedF.add(ei)
    const push = (s: FieldScore | null) => {
      if (s) fiscal.push(s)
    }
    push(scoreField(`${p}.kind`, gf.kind.value, ef.kind, 'skip'))
    push(scoreField(`${p}.uuid`, gf.uuid.value, ef.uuid.value, 'skip', 'id'))
    push(scoreField(`${p}.issued_at`, gf.issued_at.value, ef.issued_at.value, 'skip', 'datetime'))
    push(scoreField(`${p}.certified_at`, gf.certified_at.value, ef.certified_at.value, 'skip', 'datetime'))
    push(scoreField(`${p}.issuer_certificate`, gf.issuer_certificate.value, ef.issuer_certificate.value, 'skip', 'digits'))
    push(scoreField(`${p}.sat_certificate`, gf.sat_certificate.value, ef.sat_certificate.value, 'skip', 'digits'))
    push(scoreField(`${p}.pac_rfc`, gf.pac_rfc.value, ef.pac_rfc.value, 'skip', 'id'))
    push(scoreField(`${p}.issuer_rfc`, gf.issuer_rfc.value, ef.issuer.rfc.value, 'skip', 'id'))
    push(scoreField(`${p}.receiver_rfc`, gf.receiver_rfc.value, ef.receiver.rfc.value, 'must_be_null', 'id'))
    push(scoreField(`${p}.receiver_name`, gf.receiver_name.value, ef.receiver.name.value, 'must_be_null', 'id'))
    push(scoreField(`${p}.receiver_tax_regime`, gf.receiver_tax_regime.value, ef.receiver.tax_regime.value === null ? null : (/\d{3}/.exec(ef.receiver.tax_regime.value)?.[0] ?? ef.receiver.tax_regime.value), 'skip'))
    push(scoreField(`${p}.receiver_cfdi_use`, gf.receiver_cfdi_use.value, ef.receiver.cfdi_use.value === null ? null : (/[A-Z]\d{2}/.exec(ef.receiver.cfdi_use.value)?.[0] ?? ef.receiver.cfdi_use.value), 'skip'))
    push(scoreField(`${p}.subtotal`, gf.subtotal.value, ef.subtotal.value, 'skip', 'money'))
    push(scoreField(`${p}.tax`, gf.tax.value, ef.tax.value, 'skip', 'money'))
    push(scoreField(`${p}.total`, gf.total.value, ef.total.value, 'skip', 'money'))
  })
  const extraFiscal = doc.fiscal_documents.length - usedF.size
  for (let i = 0; i < extraFiscal; i++) fiscal.push({ field: 'cfdi.extra', ok: false, invented: true })

  const periods = doc.accounts.flatMap((a) => a.periods)
  const reconciled_final = periods.length > 0 && periods.every((p) => p.reconciliation?.status === 'reconciled')
  const retryCalls = doc.extraction.calls.filter((c) => c.purpose === 'retry_page')
  const errorPages = [...new Set([...m.invented.map((t) => t.page), ...m.omitted.map((t) => t.page)])].sort((a, b) => a - b)
  return {
    file: gt.file_name,
    bank: gt.bank,
    gt_transactions: gtTx.length,
    ex_transactions: exTx.length,
    matched: n,
    invented: m.invented.length,
    omitted: m.omitted.length,
    precision: ratio(n, exTx.length),
    recall: ratio(n, gtTx.length),
    row_fields,
    header: { total: header.length, ok: header.filter((s) => s.ok).length, invented: header.filter((s) => s.invented).length, failed: header.filter((s) => !s.ok).map((s) => s.field) },
    fiscal: { total: fiscal.length, ok: fiscal.filter((s) => s.ok).length, invented: fiscal.filter((s) => s.invented).length, failed: fiscal.filter((s) => !s.ok).map((s) => s.field), fiscal_documents_gt: gt.fiscal_documents.length, fiscal_documents_ex: doc.fiscal_documents.length },
    reconciled_final,
    reconciled_first_pass: reconciled_final && retryCalls.length === 0,
    retry_pages: retryCalls.length,
    pages_with_errors: errorPages,
    // Cost at list price of the calls that produced the extraction, even if they now come from cache.
    cost_usd: Math.round(doc.extraction.calls.reduce((s, c) => s + costUsd(c.model, c.usage), 0) * 1e4) / 1e4,
    models: [...new Set(doc.extraction.calls.map((c) => c.model))],
  }
}
