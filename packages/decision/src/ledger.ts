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
 */
import type { AccountUse, ApplicationRequest, Period, Provenance, StatementExtraction, Transaction, TransactionClassification, TransactionRef } from '@gow/contracts'
import { bankTokens, buyerMatch, classifyByRules, type RuleContext } from './classify/rules.ts'
import { toDay } from './util/dates.ts'
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
  documents: LedgerDocument[]
  periods: LedgerPeriod[]
  rows: LedgerRow[]
  /** Documents or accounts left out of the profile, with the reason (for `note`). */
  skipped: string[]
}

export interface LedgerOptions {
  request: ApplicationRequest | null
  minConfidence: number
  /** Account use declared by the owner; null or absent: unknown. */
  accountUse?: AccountUse | null
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
  return { documents, periods, rows, skipped }
}
