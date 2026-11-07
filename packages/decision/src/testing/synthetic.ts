/**
 * Synthetic statements for tests and the scenarios' `unit` mode: valid, balanced extractions with
 * descriptions as a Mexican bank prints them, so they go through the same rule classification and
 * profile computation as a real document. All invented: nothing comes from data/.
 */
import { createHash } from 'node:crypto'
import {
  SyntheticStatement,
  STATEMENT_SCHEMA_VERSION,
  StatementExtraction,
  type FiscalDocument,
  type Period,
  type SyntheticFlow,
  type SyntheticFlowKind,
  type Transaction,
} from '@gow/contracts'
import type { z } from 'zod'
import { addDays, addMonths, fromDay, toDay } from '../util/dates.ts'
import { round2 } from '../util/num.ts'

export interface SyntheticHolder {
  name: string
  rfc: string | null
  clabe: string | null
  /** Address printed in the header; without it the statement carries none. */
  address?: string | null
}

const CREDIT_KINDS: ReadonlySet<SyntheticFlowKind> = new Set(['customer_payment', 'sales_settlement', 'cash_deposit', 'unclassified_credit', 'loan_disbursement', 'own_transfer_in', 'refund', 'interest'])
const GROWING_KINDS: ReadonlySet<SyntheticFlowKind> = new Set(['customer_payment', 'sales_settlement', 'cash_deposit', 'unclassified_credit'])

/** Fictitious issuer of the fee CFDI. */
export const SYNTHETIC_BANK_RFC = 'BFI990101AB1'

function describe(flow: SyntheticFlow, seq: number): string {
  if (flow.description) return flow.description
  const cp = flow.counterparty
  const rfc = flow.counterparty_rfc ? ` RFC ${flow.counterparty_rfc}` : ''
  switch (flow.kind) {
    case 'customer_payment':
      return `SPEI RECIBIDO ${cp ?? 'CLIENTE VARIOS'}${rfc} REF ${String(seq)}`
    case 'sales_settlement':
      return `ABONO VENTAS TPV LOTE ${String(seq)}`
    case 'cash_deposit':
      return `DEPOSITO EN EFECTIVO SUCURSAL ${String(seq)}`
    case 'unclassified_credit':
      return `${cp ?? 'OPERACION'}${rfc} ${String(seq)}`
    case 'loan_disbursement':
      return `DISPOSICION DE CREDITO ${cp ?? 'FINANCIERA'}`
    case 'own_transfer_in':
    case 'own_transfer_out':
      return 'TRASPASO ENTRE CUENTAS PROPIAS'
    case 'refund':
      return `DEVOLUCION SPEI ${String(seq)}`
    case 'interest':
      return 'INTERESES GANADOS'
    case 'supplier_payment':
      return `PAGO A PROVEEDOR ${cp ?? 'PROVEEDOR GENERAL'}${rfc} REF ${String(seq)}`
    case 'payroll':
      return `PAGO DE NOMINA QUINCENA ${String(seq)}`
    case 'tax':
      return `PAGO REFERENCIADO SAT ${String(seq)}`
    case 'fee':
      return 'COMISION MANEJO DE CUENTA'
    case 'loan_payment':
      return `PAGO DE CREDITO ${cp ?? 'FINANCIERA'}`
    case 'cash_withdrawal':
      return `RETIRO CAJERO AUTOMATICO ${String(seq)}`
    case 'card_purchase':
      return `COMPRA TARJETA ${cp ?? 'COMERCIO'} ${String(seq)}`
  }
}

function verified<T>(value: T, page: number) {
  return { value, source: { page, snippet: String(value) }, verification: 'verified' as const, confidence: 1, provenance: 'extracted' as const }
}

function missing() {
  return { value: null, source: null, verification: 'unverified' as const, confidence: 0, provenance: 'extracted' as const }
}

interface Draft {
  day: number
  amount: number
  type: 'credit' | 'debit'
  description: string
  verification: Transaction['verification']
  order: number
}

function splitCents(total: number, parts: number): number[] {
  const cents = Math.round(total * 100)
  const base = Math.floor(cents / parts)
  return Array.from({ length: parts }, (_, i) => (base + (i < cents - base * parts ? 1 : 0)) / 100)
}

/** Movements of a month (1-based) between `start` and `end` (days). */
function monthDrafts(spec: z.infer<typeof SyntheticStatement>, month: number, start: number, end: number, seq: { n: number }): Draft[] {
  const out: Draft[] = []
  const len = end - start + 1
  spec.monthly.forEach((flow, fi) => {
    if (flow.months && !flow.months.includes(month)) return
    const growth = GROWING_KINDS.has(flow.kind) ? (1 + spec.growth) ** (month - 1) : 1
    const amounts = splitCents(round2(flow.amount * growth), flow.count)
    amounts.forEach((amount, i) => {
      seq.n++
      out.push({
        day: start + Math.min(len - 1, Math.floor(((i + 0.5) * len) / flow.count)),
        amount,
        type: CREDIT_KINDS.has(flow.kind) ? 'credit' : 'debit',
        description: describe(flow, seq.n),
        verification: flow.verification,
        order: fi * 1000 + i,
      })
    })
  })
  return out
}

/**
 * Generates the extraction. `seed` tells documents apart (it goes into the sha256), so two
 * statements from the same supplier do not collide and the same statement generated twice is
 * identical.
 */
/** The holder block: what is printed, or nothing if the statement is redacted. */
function holderBlock(holder: SyntheticHolder, redacted: boolean) {
  const printed = (value: string | null | undefined) => (redacted || !value ? missing() : verified(value, 1))
  return { name: printed(holder.name), rfc: printed(holder.rfc), holder_type: missing(), address: printed(holder.address) }
}

export function syntheticStatement(input: z.input<typeof SyntheticStatement>, holder: SyntheticHolder, seed: string): StatementExtraction {
  const spec = SyntheticStatement.parse(input)
  const months = Array.from({ length: spec.months }, (_, m) => ({ month: m + 1, start: toDay(addMonths(spec.start, m)), end: toDay(addDays(addMonths(spec.start, m + 1), -1)) }))
  const seq = { n: 0 }
  const drafts = months.flatMap((m) => monthDrafts(spec, m.month, m.start, m.end, seq)).sort((a, b) => a.day - b.day || a.order - b.order)
  const ranges = spec.periods === 'monthly' ? months : [{ month: 1, start: months[0]?.start ?? toDay(spec.start), end: months.at(-1)?.end ?? toDay(spec.start) }]

  let balance = spec.opening_balance
  const periods: Period[] = ranges.map((r, pi) => {
    const page = pi + 1
    const opening = balance
    const txs: Transaction[] = drafts
      .filter((d) => d.day >= r.start && d.day <= r.end)
      .map((d, ti) => {
        balance = round2(balance + (d.type === 'credit' ? d.amount : -d.amount))
        const date = fromDay(d.day)
        return {
          id: `a1.p${String(pi + 1)}.t${String(ti + 1).padStart(4, '0')}`,
          date,
          settlement_date: null,
          description: d.description,
          reference: null,
          amount: d.amount,
          type: d.type,
          balance,
          internal_transfer: false,
          source: { page, snippet: `${date} ${d.description}` },
          verification: d.verification,
          confidence: d.verification === 'verified' ? 1 : 0.4,
          provenance: 'extracted' as const,
          classification: null,
        }
      })
    const credits = round2(txs.filter((t) => t.type === 'credit').reduce((s, t) => s + t.amount, 0))
    const debits = round2(txs.filter((t) => t.type === 'debit').reduce((s, t) => s + t.amount, 0))
    const closing = balance
    const printedClosing = spec.reconciled ? closing : round2(closing + 1000)
    const amountCheck = (v: number) => ({ printed: v, extracted: v, difference: 0, ok: true })
    return {
      id: `a1.p${String(pi + 1)}`,
      period_start: verified(fromDay(r.start), page),
      period_end: verified(fromDay(r.end), page),
      statement_date: verified(fromDay(r.end), page),
      pages: [page],
      summary: {
        opening_balance: verified(opening, page),
        closing_balance: verified(printedClosing, page),
        total_credits: verified(credits, page),
        total_debits: verified(debits, page),
        credits_count: verified(txs.filter((t) => t.type === 'credit').length, page),
        debits_count: verified(txs.filter((t) => t.type === 'debit').length, page),
        average_balance: missing(),
        fees_charged: missing(),
        interest_earned: missing(),
        tax_withheld: missing(),
      },
      transactions: txs,
      reconciliation: {
        status: spec.reconciled ? 'reconciled' : 'not_reconciled',
        tolerance: 1,
        global: {
          opening_balance: opening,
          credits,
          debits,
          expected_closing: closing,
          printed_closing: printedClosing,
          difference: round2(printedClosing - closing),
          ok: spec.reconciled,
          excludes_internal_transfers: false,
          adjustments: [],
        },
        totals: {
          credits: amountCheck(credits),
          debits: amountCheck(debits),
          credits_count: { printed: txs.filter((t) => t.type === 'credit').length, extracted: txs.filter((t) => t.type === 'credit').length, ok: true },
          debits_count: { printed: txs.filter((t) => t.type === 'debit').length, extracted: txs.filter((t) => t.type === 'debit').length, ok: true },
        },
        running_balance: { rows_checked: txs.length, rows_without_balance: 0, breaks: [], ok: true },
      },
    }
  })

  const pageCount = periods.length + 1
  const fiscal: FiscalDocument[] = []
  if (spec.fiscal) {
    const f = spec.fiscal
    const last = periods.at(-1)
    // The bank's CFDI covers the fees of the whole document.
    const fees = round2(periods.flatMap((x) => x.transactions).filter((t) => t.type === 'debit' && t.description.startsWith('COMISION')).reduce((s, t) => s + t.amount, 0))
    const total = round2(fees + (f.fees_match ? 0 : 150))
    const subtotal = round2(total / 1.16)
    const certified = `${addDays(last?.period_end.value ?? spec.start, f.certified_days_after_end)}T10:15:07`
    const receiverRfc = f.receiver_rfc ?? (spec.holder_redacted ? null : holder.rfc)
    const p = pageCount
    fiscal.push({
      id: 'f1',
      kind: 'income',
      version: verified('4.0', p),
      uuid: verified(f.uuid, p),
      series: missing(),
      folio: verified('F-1001', p),
      issued_at: verified(certified, p),
      certified_at: verified(certified, p),
      issuer_certificate: verified('00001000000500000002', p),
      sat_certificate: verified('00001000000700000001', p),
      pac_rfc: verified('SAT970701NN3', p),
      issuer: { rfc: verified(SYNTHETIC_BANK_RFC, p), name: verified(spec.bank, p), tax_regime: verified('601', p) },
      receiver: {
        rfc: receiverRfc === null ? missing() : verified(receiverRfc, p),
        name: spec.holder_redacted ? missing() : verified(holder.name, p),
        tax_regime: verified(f.regime, p),
        cfdi_use: verified('G03', p),
        postal_code: missing(),
      },
      payment_form: verified('03', p),
      payment_method: verified('PUE', p),
      currency: verified('MXN', p),
      subtotal: verified(subtotal, p),
      tax: verified(round2(total - subtotal), p),
      total: verified(total, p),
      seals: { issuer_present: true, sat_present: true, chain_present: true, looks_truncated: false },
      original_chain: { uuid: verified(f.uuid, p), certified_at: verified(certified, p), sat_certificate: verified('00001000000700000001', p) },
      source: { page: p, snippet: 'Este documento es una representación impresa de un CFDI' },
    })
  }

  const sha = createHash('sha256').update(`${seed}\n${JSON.stringify(spec)}`).digest('hex')
  const redacted = spec.holder_redacted
  return StatementExtraction.parse({
    schema_version: STATEMENT_SCHEMA_VERSION,
    document: { file_name: `synthetic-${seed}.pdf`, sha256: sha, size_bytes: 1024 * pageCount, page_count: pageCount, text_layer: 'ok', route: 'text_and_vision' },
    classification: { document_type: 'bank_statement', confidence: 0.99, bank: spec.bank },
    bank_name: verified(spec.bank, 1),
    holder: holderBlock(holder, redacted),
    accounts: [
      {
        id: 'a1',
        product_name: verified('CUENTA PYME', 1),
        account_type: verified('checking', 1),
        account_number: verified('65-XXXX-4', 1),
        clabe: redacted || holder.clabe === null ? missing() : verified(holder.clabe, 1),
        currency: verified('MXN', 1),
        periods,
      },
    ],
    fiscal_documents: fiscal,
    issues: [],
    flags: [...new Set([...(periods.length > 1 ? (['multi_period'] as const) : []), ...(fiscal.length > 0 ? (['fiscal_document_present'] as const) : []), ...(spec.flags ?? [])])],
    extraction: {
      status: 'complete',
      started_at: '2026-11-04T12:00:00.000Z',
      finished_at: '2026-11-04T12:00:00.000Z',
      duration_ms: 0,
      extraction_model: 'synthetic',
      classifier: { implementation: 'claude', model: 'none', fallback: false },
      prompts: {},
      calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost_usd: 0,
      failure_reason: null,
    },
  })
}
