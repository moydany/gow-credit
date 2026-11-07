/**
 * Profile ledger: a request's extractions flattened into movements with their effective
 * classification, plus the periods they cover. All feature computation starts here, so the rules
 * for what gets in live in one place:
 *
 * - Every document whose extraction finished, even if the classifier did not call it a bank
 *   statement: the label stays as a warning. A given sha256 enters once.
 * - MXN accounts that are not credit cards (no currency conversion).
 * - Effective classification: the movement's own (Jev, Haiku, owner answer) if it reaches the
 *   minimum confidence; otherwise the buyer recognized by RFC or name; otherwise whatever it
 *   carries; and if it carries none, the rules.
 * - Mixed-use account declared by the owner: a deposit that is only presumed a client payment
 *   (no RFC, not the buyer, confidence below `PRESUMPTION_CONFIDENCE`) drops to
 *   `MIXED_PRESUMED_CONFIDENCE` and stops counting as income.
 * - Only the evaluated months enter: the most recent one, or the `months` most recent (the policy's
 *   `history.months`, ADR 0072). Periods and movements before them are left out, and a period
 *   that starts earlier is cut.
 */
import type { AccountUse, ApplicationRequest, Period, Provenance, StatementExtraction, Transaction, TransactionClassification, TransactionRef } from '@gow/contracts'
import { bankTokens, buyerMatch, classifyByRules, type RuleContext } from './classify/rules.ts'
import { addMonths, fromDay, toDay } from './util/dates.ts'
import { normalizeText } from './util/text.ts'

export interface LedgerDocument {
  index: number
  sha256: string
  /** Short sha256 prefix for readable evidence. */
  tag: string
  statement: StatementExtraction
}

export interface LedgerPeriod {
  doc: LedgerDocument
  accountId: string
  accountType: string | null
  period: Period
  /** Start and end as day numbers; null if there are no printed dates or movements. */
  start: number | null
  end: number | null
  /** true if start and end come from verified printed dates. */
  boundsVerified: boolean
  /** The summary is consolidated and balances without the internal transfers. */
  excludesInternal: boolean
  /**
   * Net amount of the movements cut before `start` when the period was trimmed to the evaluated
   * month: added to the printed opening balance gives the balance at the new start. 0 if not cut.
   */
  openingShift: number
}

export interface LedgerRow {
  ref: TransactionRef
  doc: LedgerDocument
  period: LedgerPeriod
  tx: Transaction
  day: number
  amount: number
  type: 'credit' | 'debit'
  internal: boolean
  verified: boolean
  classification: TransactionClassification
  /** Where the effective classification came from. */
  classifiedBy: 'given' | 'buyer' | 'rules'
  rule: string | null
  buyerMatch: 'rfc' | 'name' | null
  provenance: Provenance
  /** A deposit presumed to be a client payment that does not count because the account is mixed-use. */
  mixedUseDiscount: boolean
}

export interface Ledger {
  /** Documents with a period in the evaluated month. */
  documents: LedgerDocument[]
  /**
   * Every document that entered, including those left out of the evaluated month: tamper and
   * missing-page signals look at all of them, so an altered older statement is not hidden.
   */
  submitted: LedgerDocument[]
  periods: LedgerPeriod[]
  /** Movements of the evaluated months: every feature of the flow is computed from these. */
  rows: LedgerRow[]
  /**
   * Every movement of `submitted`, inside the evaluated months or not: for checks of a whole
   * document against something outside it (the fee CFDI signed by the SAT).
   */
  submittedRows: LedgerRow[]
  /** Documents or accounts left out of the profile, with the reason (for `note`). */
  skipped: string[]
}

export interface LedgerOptions {
  request: ApplicationRequest | null
  minConfidence: number
  /** Account use declared by the owner; null or absent: unknown. */
  accountUse?: AccountUse | null
  /** Months evaluated, counted back from the latest period end. Default 1. */
  months?: number
}

/** Below this confidence a client payment with no RFC or buyer is a presumption (third-party transfer). */
export const PRESUMPTION_CONFIDENCE = 0.8
/** Confidence of a presumption in a mixed-use account: the rules' "nothing recognizable". */
export const MIXED_PRESUMED_CONFIDENCE = 0.5

/**
 * Is this deposit only presumed to be a client payment? A third-party transfer nobody recognized
 * (no printed RFC, no buyer, no person's answer) with confidence below `PRESUMPTION_CONFIDENCE`:
 * the rules give "SPEI RECIBIDO" 0.75.
 */
export function isPresumedCustomerPayment(row: Pick<LedgerRow, 'type' | 'internal' | 'classification' | 'buyerMatch'>): boolean {
  const c = row.classification
  return (
    row.type === 'credit' &&
    !row.internal &&
    c.category === 'customer_payment' &&
    c.confidence < PRESUMPTION_CONFIDENCE &&
    row.buyerMatch === null &&
    c.counterparty_rfc === null &&
    c.classifier !== 'owner_answer' &&
    c.classifier !== 'analyst_answer'
  )
}

export function evidenceRef(row: Pick<LedgerRow, 'doc' | 'tx'>): string {
  return `${row.doc.tag}#${row.tx.id}`
}

function provenanceOf(t: Transaction, c: TransactionClassification): Provenance {
  if (c.classifier === 'owner_answer' || c.classifier === 'analyst_answer') return c.classifier
  return t.provenance
}

/** Rules context for a document: holder, bank words and the request's buyer. */
export function ruleContext(s: StatementExtraction, request: ApplicationRequest | null): RuleContext {
  return {
    holderName: s.holder.name.value,
    holderRfc: s.holder.rfc.value,
    bankTokens: bankTokens(s.bank_name.value, s.classification.bank),
    buyer: request?.buyer ?? null,
  }
}

/**
 * Start and end of the period: the printed dates if verified; otherwise the movements' (months
 * come from dates, not the number of periods).
 */
function periodBounds(p: Period): { start: number | null; end: number | null; verified: boolean } {
  const days = p.transactions.map((t) => toDay(t.date))
  const minTx = days.length > 0 ? Math.min(...days) : null
  const maxTx = days.length > 0 ? Math.max(...days) : null
  const printedStart = p.period_start.value !== null && p.period_start.verification === 'verified' ? toDay(p.period_start.value) : null
  const printedEnd = p.period_end.value !== null && p.period_end.verification === 'verified' ? toDay(p.period_end.value) : null
  return { start: printedStart ?? minTx, end: printedEnd ?? maxTx, verified: printedStart !== null && printedEnd !== null }
}

export function buildLedger(statements: readonly StatementExtraction[], opts: LedgerOptions): Ledger {
  const documents: LedgerDocument[] = []
  const periods: LedgerPeriod[] = []
  const rows: LedgerRow[] = []
  const skipped: string[] = []
  const seen = new Set<string>()

  for (const s of statements) {
    const sha = s.document.sha256
    if (seen.has(sha)) {
      skipped.push(`documento repetido ${sha.slice(0, 12)}: se usa una vez`)
      continue
    }
    seen.add(sha)
    if (s.extraction.status === 'failed') {
      skipped.push(`documento ${sha.slice(0, 12)} sin extracción: no entra al perfil`)
      continue
    }
    if (s.classification.document_type !== 'bank_statement') {
      // The classifier labels, it does not block: a finished extraction is analyzed anyway and the
      // label is flagged; if it is really not a statement, the balance check and gates will say so.
      skipped.push(`documento ${sha.slice(0, 12)} clasificado como ${s.classification.document_type}: entra al perfil con ese aviso`)
    }
    const doc: LedgerDocument = { index: documents.length, sha256: sha, tag: sha.slice(0, 12), statement: s }
    documents.push(doc)
    const ctx = ruleContext(s, opts.request)

    for (const a of s.accounts) {
      const accountType = a.account_type.value
      if (accountType === 'credit_card') {
        skipped.push(`cuenta ${a.id} de ${doc.tag} es tarjeta de crédito: no es flujo de la empresa`)
        continue
      }
      const currency = a.currency.value
      if (currency !== null && currency !== 'MXN') {
        skipped.push(`cuenta ${a.id} de ${doc.tag} en ${currency}: sin conversión de moneda`)
        continue
      }
      for (const p of a.periods) {
        const b = periodBounds(p)
        const lp: LedgerPeriod = {
          doc,
          accountId: a.id,
          accountType,
          period: p,
          start: b.start,
          end: b.end,
          boundsVerified: b.verified,
          excludesInternal: p.reconciliation?.global?.excludes_internal_transfers ?? false,
          openingShift: 0,
        }
        periods.push(lp)
        for (const t of p.transactions) {
          const given = t.classification
          const text = normalizeText(`${t.description} ${t.reference ?? ''}`)
          let classification: TransactionClassification
          let classifiedBy: LedgerRow['classifiedBy']
          let rule: string | null = null
          let buyer: LedgerRow['buyerMatch'] = null
          const rules = classifyByRules(t, ctx)
          const buyerHit = t.type === 'credit' && !t.internal_transfer ? buyerMatch(text, given?.counterparty_rfc ?? rules.classification.counterparty_rfc, ctx.buyer) : null
          if (given !== null && given.confidence >= opts.minConfidence) {
            classification = given
            classifiedBy = 'given'
            buyer = given.category === 'customer_payment' ? buyerHit : null
          } else if (buyerHit !== null && ctx.buyer !== null) {
            classification = { category: 'customer_payment', confidence: buyerHit === 'rfc' ? 0.98 : 0.95, counterparty: ctx.buyer.name, counterparty_rfc: given?.counterparty_rfc ?? rules.classification.counterparty_rfc, classifier: rules.classification.classifier }
            classifiedBy = 'buyer'
            rule = `buyer_${buyerHit}`
            buyer = buyerHit
          } else if (given !== null) {
            classification = given
            classifiedBy = 'given'
          } else {
            classification = rules.classification
            classifiedBy = 'rules'
            rule = rules.rule
            buyer = rules.buyerMatch
          }
          const internal = t.internal_transfer
          const mixedUseDiscount = opts.accountUse === 'mixed' && isPresumedCustomerPayment({ type: t.type, internal, classification, buyerMatch: buyer })
          if (mixedUseDiscount) classification = { ...classification, confidence: Math.min(classification.confidence, MIXED_PRESUMED_CONFIDENCE) }
          rows.push({
            ref: { document_sha256: sha, transaction_id: t.id },
            doc,
            period: lp,
            tx: t,
            day: toDay(t.date),
            amount: t.amount,
            type: t.type,
            internal,
            verified: t.verification === 'verified',
            classification,
            classifiedBy,
            rule,
            buyerMatch: buyer,
            provenance: provenanceOf(t, classification),
            mixedUseDiscount,
          })
        }
      }
    }
  }
  return keepLatestMonths({ documents, submitted: documents, periods, rows, submittedRows: rows, skipped }, opts.months ?? 1)
}

/**
 * First day of the month that ends on `end`: the calendar month if `end` is its last day; otherwise
 * the day after the same date one month earlier (a cycle from the 5th to the 4th).
 */
export function monthStart(end: number): number {
  const iso = fromDay(end)
  if (fromDay(end + 1).endsWith('-01')) return toDay(`${iso.slice(0, 8)}01`)
  return toDay(addMonths(iso, -1)) + 1
}

/** First day of the `months` months that end on `end`. */
export function windowStart(end: number, months: number): number {
  let start = monthStart(end)
  for (let i = 1; i < months; i++) start = monthStart(start - 1)
  return start
}

/**
 * Keeps only the evaluated months: the `months` months that end on the latest period end. A period
 * that does not reach them is left out; one that starts before them is cut, and the movements cut
 * move its opening balance. Without dated periods nothing is cut.
 */
export function keepLatestMonths(ledger: Ledger, months: number): Ledger {
  const ends = ledger.periods.flatMap((p) => (p.end === null ? [] : [p.end]))
  if (ends.length === 0) return ledger
  const end = Math.max(...ends)
  const start = windowStart(end, months)
  const toWindow = months === 1 ? 'al mes evaluado' : `a los ${String(months)} meses evaluados`
  const ofWindow = months === 1 ? 'del mes evaluado' : `de los ${String(months)} meses evaluados`
  const skipped = [...ledger.skipped]
  const periods: LedgerPeriod[] = []
  for (const p of ledger.periods) {
    if (p.end === null || p.end < start) {
      skipped.push(`periodo ${p.period.id} de ${p.doc.tag} anterior ${toWindow}: no entra al perfil`)
      continue
    }
    if (p.start !== null && p.start < start) {
      const cut = ledger.rows.filter((r) => r.period === p && r.day < start && !(p.excludesInternal && r.internal))
      const openingShift = cut.reduce((s, r) => s + (r.type === 'credit' ? r.amount : -r.amount), 0)
      skipped.push(`periodo ${p.period.id} de ${p.doc.tag} recortado ${toWindow} (${fromDay(start)} a ${fromDay(end)})`)
      // Mutated in place: the rows point to this same object.
      p.start = start
      p.openingShift = Math.round(openingShift * 100) / 100
    }
    periods.push(p)
  }
  const kept = new Set(periods)
  const rows = ledger.rows.filter((r) => kept.has(r.period) && r.day >= start)
  const docs = new Set(periods.map((p) => p.doc))
  for (const d of ledger.documents) if (!docs.has(d)) skipped.push(`documento ${d.tag} fuera ${ofWindow}: no entra al perfil`)
  return { documents: ledger.documents.filter((d) => docs.has(d)), submitted: ledger.submitted, periods, rows, submittedRows: ledger.submittedRows, skipped }
}
