/**
 * Libro del perfil: las extracciones de una solicitud aplanadas en movimientos con su
 * clasificación efectiva, más los periodos que cubren. Todo el cálculo de features parte de
 * aquí, así que las reglas de qué entra y qué no viven en un solo lugar:
 *
 * - Solo documentos `bank_statement` (ADR 0002); un mismo sha256 entra una vez.
 * - Cuentas en MXN y que no son tarjeta de crédito (sin conversión de moneda).
 * - Clasificación efectiva: la que trae el movimiento (Jev, Haiku, respuesta del dueño) si
 *   alcanza la confianza mínima; si no, el comprador reconocido por RFC o nombre; si no, la que
 *   traiga; y si no trae ninguna, las reglas (ADR 0013).
 * - Cuenta de uso mixto declarada por el dueño (ADR 0050): un abono que solo se presume pago de
 *   cliente (sin RFC, sin el comprador y con confianza menor a `PRESUMPTION_CONFIDENCE`) baja a
 *   `MIXED_PRESUMED_CONFIDENCE` y deja de contar como ingreso.
 */
import type { AccountUse, ApplicationRequest, Period, Provenance, StatementExtraction, Transaction, TransactionClassification, TransactionRef } from '@gow/contracts'
import { bankTokens, buyerMatch, classifyByRules, type RuleContext } from './classify/rules.ts'
import { toDay } from './util/dates.ts'
import { normalizeText } from './util/text.ts'

export interface LedgerDocument {
  index: number
  sha256: string
  /** Prefijo corto del sha256 para evidencia legible. */
  tag: string
  statement: StatementExtraction
}

export interface LedgerPeriod {
  doc: LedgerDocument
  accountId: string
  accountType: string | null
  period: Period
  /** Inicio y fin en número de día; null si no hay fechas impresas ni movimientos. */
  start: number | null
  end: number | null
  /** true si inicio y fin salen de fechas impresas verificadas. */
  boundsVerified: boolean
  /** El resumen es consolidado y cuadra sin los traspasos internos (ADR 0009). */
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
  /** De dónde salió la clasificación efectiva. */
  classifiedBy: 'given' | 'buyer' | 'rules'
  rule: string | null
  buyerMatch: 'rfc' | 'name' | null
  provenance: Provenance
  /** Abono que se presumía pago de cliente y no cuenta por ser cuenta de uso mixto (ADR 0050). */
  mixedUseDiscount: boolean
}

export interface Ledger {
  documents: LedgerDocument[]
  periods: LedgerPeriod[]
  rows: LedgerRow[]
  /** Documentos o cuentas que no entran al perfil, con la razón (para `note`). */
  skipped: string[]
}

export interface LedgerOptions {
  request: ApplicationRequest | null
  minConfidence: number
  /** Uso de la cuenta declarado por el dueño (ADR 0050); null o ausente: no se sabe. */
  accountUse?: AccountUse | null
}

/** Debajo de esta confianza un pago de cliente sin RFC ni comprador es una presunción (transferencia de un tercero). */
export const PRESUMPTION_CONFIDENCE = 0.8
/** Confianza de una presunción en una cuenta de uso mixto: la de "nada reconocible" de las reglas. */
export const MIXED_PRESUMED_CONFIDENCE = 0.5

/**
 * ¿Este abono solo se presume pago de cliente? Lo es una transferencia de un tercero que nadie
 * reconoció (ni RFC impreso, ni el comprador, ni una respuesta de una persona) y con confianza
 * menor a `PRESUMPTION_CONFIDENCE`: las reglas le dan 0.75 a "SPEI RECIBIDO" (ADR 0013).
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

/** Contexto de las reglas para un documento: titular, palabras del banco y comprador de la solicitud. */
export function ruleContext(s: StatementExtraction, request: ApplicationRequest | null): RuleContext {
  return {
    holderName: s.holder.name.value,
    holderRfc: s.holder.rfc.value,
    bankTokens: bankTokens(s.bank_name.value, s.classification.bank),
    buyer: request?.buyer ?? null,
  }
}

/**
 * Inicio y fin del periodo: las fechas impresas si están verificadas; si no, las de los
 * movimientos (ADR 0006: los meses salen de fechas, no del número de periodos).
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
    if (s.classification.document_type !== 'bank_statement') {
      skipped.push(`documento ${sha.slice(0, 12)} clasificado como ${s.classification.document_type}: no entra al perfil`)
      continue
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
