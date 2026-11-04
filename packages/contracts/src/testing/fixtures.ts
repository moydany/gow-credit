/**
 * Constructores de objetos válidos para tests (aquí y en packages/decision). Todo es
 * sintético: ningún dato sale de data/.
 */
import type { Provenance } from '../enums.ts'
import { FEATURE_CATALOG, FEATURE_CATALOG_VERSION, type FeatureName } from '../features.ts'
import type { Profile, ProfileFeatures } from '../profile.ts'
import { STATEMENT_SCHEMA_VERSION, type Account, type FiscalDocument, type Period, type StatementExtraction, type Transaction } from '../statement.ts'

export function extracted<T>(value: T, page = 1, snippet = String(value)) {
  return { value, source: { page, snippet }, verification: 'verified' as const, confidence: 1, provenance: 'extracted' as const }
}

export function missing() {
  return { value: null, source: null, verification: 'unverified' as const, confidence: 0, provenance: 'extracted' as const }
}

export function tx(id: string, date: string, amount: number, type: 'credit' | 'debit', balance: number | null, page = 1): Transaction {
  return {
    id,
    date,
    settlement_date: null,
    description: type === 'credit' ? 'SPEI RECIBIDO CLIENTE' : 'PAGO PROVEEDOR',
    reference: null,
    amount,
    type,
    balance,
    internal_transfer: false,
    source: { page, snippet: `${date} ${String(amount)}` },
    verification: 'verified',
    confidence: 1,
    provenance: 'extracted',
    classification: null,
  }
}

function summary(opening: number, credits: number, debits: number, closing: number): Period['summary'] {
  return {
    opening_balance: extracted(opening),
    closing_balance: extracted(closing),
    total_credits: extracted(credits),
    total_debits: extracted(debits),
    credits_count: missing(),
    debits_count: missing(),
    average_balance: missing(),
    fees_charged: missing(),
    interest_earned: missing(),
    tax_withheld: missing(),
  }
}

export function period(id: string, start: string, end: string, transactions: Transaction[], opening: number): Period {
  const credits = transactions.filter((t) => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
  const debits = transactions.filter((t) => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
  const closing = Math.round((opening + credits - debits) * 100) / 100
  return {
    id,
    period_start: extracted(start),
    period_end: extracted(end),
    statement_date: extracted(end),
    pages: [1],
    summary: summary(opening, credits, debits, closing),
    transactions,
    reconciliation: null,
  }
}

export function account(id: string, periods: Period[], type: 'checking' | 'investment' = 'checking'): Account {
  return {
    id,
    product_name: extracted(type === 'checking' ? 'CUENTA PYME' : 'INVERSION PYME'),
    account_type: extracted(type),
    account_number: extracted('65-XXXX-4'),
    clabe: missing(),
    currency: extracted('MXN'),
    periods,
  }
}

/** CFDI sintético de comisiones (tipo I), con todos sus campos legibles y sellos completos. */
export function fiscalDocument(id = 'f1', page = 3, overrides: Partial<FiscalDocument> = {}): FiscalDocument {
  const uuid = 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B'
  const sat = '00001000000700000001'
  return {
    id,
    kind: 'income',
    version: extracted('4.0', page),
    uuid: extracted(uuid, page),
    series: missing(),
    folio: extracted('F-1001', page),
    issued_at: extracted('2026-04-01T10:15:00', page),
    certified_at: extracted('2026-04-01T10:15:07', page),
    issuer_certificate: extracted('00001000000500000002', page),
    sat_certificate: extracted(sat, page),
    pac_rfc: extracted('SAT970701NN3', page),
    issuer: { rfc: extracted('BFI990101AB1', page), name: extracted('BANCO FICTICIO', page), tax_regime: extracted('601', page) },
    receiver: { rfc: extracted('XAXX010101000', page), name: extracted('COMERCIALIZADORA DE PRUEBA', page), tax_regime: extracted('601', page), cfdi_use: extracted('G03', page), postal_code: extracted('06600', page) },
    payment_form: extracted('03', page),
    payment_method: extracted('PUE', page),
    currency: extracted('MXN', page),
    subtotal: extracted(240, page),
    tax: extracted(38.4, page),
    total: extracted(278.4, page),
    seals: { issuer_present: true, sat_present: true, chain_present: true, looks_truncated: false },
    original_chain: { uuid: extracted(uuid, page), certified_at: extracted('2026-04-01T10:15:07', page), sat_certificate: extracted(sat, page) },
    source: { page, snippet: 'Este documento es una representación impresa de un CFDI' },
    ...overrides,
  }
}

/** Estado sintético con dos cuentas (cheques + inversión) y dos periodos en la primera. */
export function sampleStatement(): StatementExtraction {
  const p1 = period('a1.p1', '2026-03-01', '2026-03-31', [tx('a1.p1.t1', '2026-03-05', 5000, 'credit', 15000), tx('a1.p1.t2', '2026-03-12', 1250.5, 'debit', 13749.5)], 10000)
  const p2 = period('a1.p2', '2026-04-01', '2026-04-30', [tx('a1.p2.t1', '2026-04-02', 300, 'debit', 13449.5, 2)], 13749.5)
  const inv = period('a2.p1', '2026-03-01', '2026-04-30', [], 50000)
  return {
    schema_version: STATEMENT_SCHEMA_VERSION,
    document: { file_name: 'synthetic.pdf', sha256: 'a'.repeat(64), size_bytes: 1024, page_count: 3, text_layer: 'ok', route: 'text_and_vision' },
    classification: { document_type: 'bank_statement', confidence: 0.98, bank: 'Banco Ficticio' },
    bank_name: extracted('BANCO FICTICIO'),
    holder: { name: extracted('COMERCIALIZADORA DE PRUEBA SA DE CV'), rfc: extracted('XAXX010101000'), holder_type: extracted('legal_entity') },
    accounts: [account('a1', [p1, p2]), account('a2', [inv], 'investment')],
    fiscal_documents: [],
    issues: [],
    flags: ['multi_account', 'multi_period'],
    extraction: {
      status: 'complete',
      started_at: '2026-11-04T12:00:00.000Z',
      finished_at: '2026-11-04T12:00:42.000Z',
      duration_ms: 42000,
      extraction_model: 'claude-opus-5-5',
      classifier: { implementation: 'claude', model: 'claude-haiku-5-5', fallback: true },
      prompts: { extract_summary: 'v1', extract_transactions: 'v1' },
      calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost_usd: 0,
      failure_reason: null,
    },
  }
}

type FeatureOverrides = { [K in FeatureName]?: ProfileFeatures[K]['value'] }

/** Perfil con todas las features desconocidas, salvo las que se pasen (verificadas, confianza 1). */
export function sampleProfile(values: FeatureOverrides = {}, provenance: Provenance = 'extracted'): Profile {
  const features = Object.fromEntries(
    (Object.keys(FEATURE_CATALOG) as FeatureName[]).map((name) => {
      const value = values[name]
      return [
        name,
        value === undefined
          ? { value: null, confidence: 0, verification: 'unverified', provenance, evidence: [], note: 'sin datos' }
          : { value, confidence: 1, verification: 'verified', provenance, evidence: [], note: null },
      ]
    }),
  ) as unknown as ProfileFeatures
  return {
    catalog_version: FEATURE_CATALOG_VERSION,
    computed_at: '2026-11-04T12:00:00.000Z',
    inputs: { document_sha256: ['a'.repeat(64)], request: null, external: [] },
    parameters: { low_balance_threshold: 1000, min_classification_confidence: 0.7 },
    features,
  }
}
