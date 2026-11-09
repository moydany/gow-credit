/* eslint-disable no-console -- CLI: prints only figures, counts and codes; never document text */
/**
 * pnpm -F @gow/evals gt:build
 *
 * Builds the ground truth for the 9 dev documents:
 * - Movements: deterministic per-bank parser of the text layer (`banks.ts`).
 * - Header, summary and CFDI: facts read by hand from the text layer (and the image for HSBC), in
 *   data/ground-truth/facts/<doc>.json; here each value is checked to appear in the document.
 * - Arbiter: the bank's arithmetic (running balance, global reconciliation, totals and counts).
 * Nothing comes from the extractor model. Output goes to data/ground-truth/ (not versioned) and a
 * manifest without personal data to evals/ground-truth/manifest.json.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadPdf, PageText } from '@gow/extraction'
import { BANKS } from './banks.ts'
import { readLayout } from './layout.ts'
import { checkChain, parseTable, type ParsedRow } from './parse-table.ts'
import { GroundTruth, GT_VERSION, type GtFiscalDocument, type GtPeriod, type GtProvenance, type GtTransaction } from './schema.ts'
import { round2 } from './table.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const DATA = join(REPO, 'data')
const OUT = join(DATA, 'ground-truth')
const TODAY = new Date().toISOString().slice(0, 10)

interface FactPeriod {
  period_start: string
  period_end: string
  opening_balance: number | null
  closing_balance: number | null
  total_credits: number | null
  total_debits: number | null
  credits_count: number | null
  debits_count: number | null
  /** Summary item the bank doesn't list as a row (Nu: yield). */
  unitemized_adjustment?: number
  /** Charges the bank prints apart and doesn't add into its charges total (Fondeadora: ISR). */
  printed_debits_exclude?: number
}
interface FactAccount {
  key: string
  account_type: 'checking' | 'savings' | 'investment' | 'credit_card' | 'other' | null
  account_number: string | null
  clabe: string | null
  currency: string | null
  periods: FactPeriod[]
  table: string | null
}
type FiscalStringKey = 'kind' | 'uuid' | 'issued_at' | 'certified_at' | 'issuer_certificate' | 'sat_certificate' | 'pac_rfc' | 'issuer_rfc' | 'receiver_rfc' | 'receiver_name' | 'receiver_tax_regime' | 'receiver_cfdi_use'
type FactFiscal = { page: number } & Record<FiscalStringKey, string | null> & Record<'subtotal' | 'tax' | 'total', number | null>
interface Facts {
  bank: string
  holder: { name: string | null; rfc: string | null }
  accounts: FactAccount[]
  fiscal: FactFiscal[]
  notes: string[]
}

/** Per-bank description cleanup (format only). */
function cleanRow(bank: string, r: ParsedRow): ParsedRow {
  if (bank === 'bbva') {
    // The description segment starts with the settlement date ("01/SEP T17 ...").
    const strip = (s: string) => s.replace(/^\d{2}\/[A-Z]{3} /, '')
    return { ...r, description: strip(r.description), description_head: strip(r.description_head) }
  }
  return r
}

/**
 * Order-tolerant running balance: each printed balance must come from the opening balance or from
 * another row's printed balance plus or minus its amount (Fondeadora prints interest and ISR at
 * the end with balances computed in another order). Returns the rows whose balance isn't explained.
 */
function unexplainedBalances(rows: readonly ParsedRow[], opening: number | null): number {
  const balances = new Set<number>(rows.flatMap((r) => (r.balance === null ? [] : [Math.round(r.balance * 100)])))
  if (opening !== null) balances.add(Math.round(opening * 100))
  let bad = 0
  for (const r of rows) {
    if (r.balance === null) continue
    const delta = Math.round((r.type === 'credit' ? r.amount : -r.amount) * 100)
    if (!balances.has(Math.round(r.balance * 100) - delta)) bad++
  }
  return bad
}

function main(): Promise<void> {
  return run()
}

type BankSpec = (typeof BANKS)[number]

interface FactHelpers {
  strFact: (label: string, value: string | null, page?: number | null) => { value: string | null; provenance: GtProvenance[]; page: number | null }
  numFact: (label: string, value: number | null, arithmetic?: boolean) => { value: number | null; provenance: GtProvenance[]; page: number | null }
  intFact: (value: number | null) => { value: number | null; provenance: GtProvenance[]; page: null }
  dayFact: (value: string) => { value: string; provenance: GtProvenance[]; page: null }
}

function createFactHelpers(text: PageText, visual: boolean, warnings: string[]): FactHelpers {
  const prov = (found: boolean): GtProvenance[] => (found ? ['text_layer'] : visual ? ['visual_review'] : ['text_layer'])
  const strFact = (label: string, value: string | null, page: number | null = null) => {
    if (value === null) return { value: null, provenance: ['text_layer'] as GtProvenance[], page }
    const hit = text.locateText(value) ?? text.locateText(value.replace(/-/g, ''))
    if (!hit && value.length >= 4 && !/^\d{4}-\d{2}-\d{2}T/.test(value) && !/--/.test(value)) warnings.push(`${label}: no aparece literal en la capa de texto`)
    return { value, provenance: prov(hit !== null), page: hit?.page ?? page }
  }
  const numFact = (label: string, value: number | null, arithmetic = false) => {
    if (value === null) return { value: null, provenance: ['text_layer'] as GtProvenance[], page: null }
    const hit = value === 0 ? null : text.locateAmount(value)
    if (!hit && value !== 0) warnings.push(`${label}: monto no aparece en la capa de texto`)
    const p: GtProvenance[] = [...prov(hit !== null || value === 0)]
    if (arithmetic) p.push('bank_arithmetic')
    return { value, provenance: p, page: hit?.page ?? null }
  }
  const intFact = (value: number | null) => ({ value, provenance: ['text_layer'] as GtProvenance[], page: null })
  const dayFact = (value: string) => ({ value, provenance: ['text_layer'] as GtProvenance[], page: null })
  return { strFact, numFact, intFact, dayFact }
}

function computeGlobalCheck(
  fp: FactPeriod,
  chain: ReturnType<typeof checkChain>,
  net: ReturnType<typeof checkChain>,
): GtPeriod['checks']['global'] {
  if (fp.opening_balance === null || fp.closing_balance === null) return 'not_checkable'
  const direct = round2(fp.opening_balance + chain.credits - chain.debits)
  const consolidated = round2(fp.opening_balance + net.credits - net.debits + (fp.unitemized_adjustment ?? 0))
  if (Math.abs(direct - fp.closing_balance) < 0.005) return 'ok'
  return Math.abs(consolidated - fp.closing_balance) < 0.005 ? 'ok_consolidated' : 'failed'
}

function computeTotalsCheck(
  fp: FactPeriod,
  sums: ReturnType<typeof checkChain>,
): GtPeriod['checks']['totals'] {
  if (fp.total_credits === null || fp.total_debits === null) return 'not_printed'
  const debitsCompared = round2(sums.debits - (fp.printed_debits_exclude ?? 0))
  return Math.abs(sums.credits - fp.total_credits) < 0.005 && Math.abs(debitsCompared - fp.total_debits) < 0.005 ? 'ok' : 'failed'
}

function computePeriodChecks(
  rows: readonly ParsedRow[],
  fp: FactPeriod,
  reverseChronological: boolean | undefined,
) {
  const chain = checkChain(rows, fp.opening_balance, { reverse: reverseChronological ?? false })
  const net = checkChain(rows, fp.opening_balance, { reverse: reverseChronological ?? false, excludeInternal: true })
  const withBalance = rows.filter((r) => r.balance !== null).length
  const unexplained = chain.breaks.length === 0 ? 0 : unexplainedBalances(rows, fp.opening_balance)
  const running: GtPeriod['checks']['running_balance'] = withBalance === 0 ? 'not_printed' : unexplained === 0 ? 'ok' : 'failed'

  const global = computeGlobalCheck(fp, chain, net)
  const sums = global === 'ok_consolidated' ? net : chain
  const totals = computeTotalsCheck(fp, sums)

  let counts: GtPeriod['checks']['counts'] = 'not_printed'
  if (fp.credits_count !== null && fp.debits_count !== null) {
    counts = sums.creditsCount === fp.credits_count && sums.debitsCount === fp.debits_count ? 'ok' : 'failed'
  }

  const checks = { running_balance: running, global, totals, counts }
  const ok = running !== 'failed' && global !== 'failed' && global !== 'not_checkable' && totals !== 'failed' && counts !== 'failed'
  return { checks, ok }
}

function buildGtPeriod(
  fa: FactAccount,
  fp: FactPeriod,
  pi: number,
  rowsByTable: Map<string, ParsedRow[]>,
  spec: BankSpec,
  helpers: FactHelpers,
  warnings: string[],
): { period: GtPeriod; ok: boolean } {
  const rows = fa.table ? (rowsByTable.get(fa.table) ?? []) : []
  const parserProblems = rows.filter((r) => r.problems.length > 0).length
  if (parserProblems > 0) warnings.push(`${fa.key}: ${String(parserProblems)} filas con problemas del parser`)

  const { checks, ok } = computePeriodChecks(rows, fp, spec.reverseChronological)
  const txProv: GtProvenance[] = ok ? ['text_layer', 'bank_arithmetic'] : ['text_layer']
  const transactions: GtTransaction[] = rows.map((r) => ({
    page: r.page,
    date: r.date,
    description: r.description,
    description_head: r.description_head,
    reference: r.reference,
    amount: r.amount,
    type: r.type,
    balance: r.balance,
    internal_transfer: r.internal_transfer,
    provenance: txProv,
  }))

  const period: GtPeriod = {
    key: `${fa.key}.p${String(pi + 1)}`,
    period_start: helpers.dayFact(fp.period_start),
    period_end: helpers.dayFact(fp.period_end),
    opening_balance: helpers.numFact(`${fa.key} saldo inicial`, fp.opening_balance, ok),
    closing_balance: helpers.numFact(`${fa.key} saldo final`, fp.closing_balance, ok),
    total_credits: helpers.numFact(`${fa.key} total abonos`, fp.total_credits, ok),
    total_debits: helpers.numFact(`${fa.key} total cargos`, fp.total_debits, ok),
    credits_count: helpers.intFact(fp.credits_count),
    debits_count: helpers.intFact(fp.debits_count),
    checks,
    pages: [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b),
    transactions,
  }
  return { period, ok }
}

function buildGtFiscalDocuments(fiscal: FactFiscal[], helpers: FactHelpers): GtFiscalDocument[] {
  return fiscal.map((f, i) => {
    const s = (k: FiscalStringKey) => helpers.strFact(`CFDI ${String(i + 1)} ${k}`, f[k], f.page)
    const n = (k: 'subtotal' | 'tax' | 'total') => helpers.numFact(`CFDI ${String(i + 1)} ${k}`, f[k])
    return {
      kind: { value: f.kind as 'income' | 'withholding' | 'other' | null, provenance: ['text_layer'], page: f.page },
      page: f.page,
      uuid: s('uuid'),
      issued_at: s('issued_at'),
      certified_at: s('certified_at'),
      issuer_certificate: s('issuer_certificate'),
      sat_certificate: s('sat_certificate'),
      pac_rfc: s('pac_rfc'),
      issuer_rfc: s('issuer_rfc'),
      receiver_rfc: s('receiver_rfc'),
      receiver_name: s('receiver_name'),
      receiver_tax_regime: s('receiver_tax_regime'),
      receiver_cfdi_use: s('receiver_cfdi_use'),
      subtotal: n('subtotal'),
      tax: n('tax'),
      total: n('total'),
    }
  })
}

async function buildBankManifestEntry(spec: BankSpec): Promise<Record<string, unknown>> {
  const base = spec.file.replace(/\.pdf$/, '')
  const facts = JSON.parse(readFileSync(join(OUT, 'facts', `${base}.json`), 'utf8')) as Facts
  const pdfPath = join(DATA, 'dev', spec.file)
  const [layout, pdf] = await Promise.all([readLayout(pdfPath), loadPdf(pdfPath)])
  const text = new PageText({ ...pdf, textLayer: pdf.textRepaired ? 'ok' : pdf.textLayer })
  const warnings: string[] = []
  const helpers = createFactHelpers(text, spec.bank === 'hsbc', warnings)

  const rowsByTable = new Map<string, ParsedRow[]>()
  for (const table of spec.tables) {
    const rows = parseTable(layout.pages, table).map((r) => cleanRow(spec.bank, r))
    rowsByTable.set('main', [...(rowsByTable.get('main') ?? []), ...rows])
  }

  let gated = true
  const accounts = facts.accounts.map((fa) => {
    const periods: GtPeriod[] = []
    fa.periods.forEach((fp, pi) => {
      const res = buildGtPeriod(fa, fp, pi, rowsByTable, spec, helpers, warnings)
      if (!res.ok) gated = false
      periods.push(res.period)
    })
    return {
      key: fa.key,
      account_type: { value: fa.account_type, provenance: ['text_layer'] as GtProvenance[], page: null },
      account_number: helpers.strFact(`${fa.key} número de cuenta`, fa.account_number),
      clabe: helpers.strFact(`${fa.key} CLABE`, fa.clabe),
      currency: { value: fa.currency, provenance: ['text_layer'] as GtProvenance[], page: null },
      periods,
    }
  })

  const fiscal_documents = buildGtFiscalDocuments(facts.fiscal, helpers)
  const gt = GroundTruth.parse({
    gt_version: GT_VERSION,
    file_name: spec.file,
    sha256: pdf.sha256,
    page_count: pdf.pageCount,
    bank: spec.bank,
    gated,
    holder: { name: helpers.strFact('titular', facts.holder.name), rfc: helpers.strFact('RFC titular', facts.holder.rfc) },
    accounts,
    fiscal_documents,
    review: {
      built_by: 'Claude Code (claude-opus-5-5), parser determinístico por banco + hechos leídos a mano',
      built_at: TODAY,
      method: 'Movimientos: capa de texto con coordenadas (pdfjs; HSBC decodificado de EBCDIC) y parser por banco sin modelo. Árbitro: saldo corrido, cuadre global, totales y conteos impresos por el banco. Encabezado y CFDI: leídos a mano de la capa de texto y comprobados por búsqueda literal; HSBC además contra la imagen de la página.',
      human_sample: null,
    },
    notes: facts.notes,
  })
  writeFileSync(join(OUT, `${base}.json`), `${JSON.stringify(gt, null, 1)}\n`)

  const txs = gt.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions))
  const entry = {
    file: spec.file,
    bank: spec.bank,
    sha256: gt.sha256,
    gt_sha256: createHash('sha256').update(JSON.stringify(gt)).digest('hex'),
    gated,
    accounts: gt.accounts.length,
    periods: gt.accounts.reduce((n, a) => n + a.periods.length, 0),
    transactions: txs.length,
    internal_transfers: txs.filter((t) => t.internal_transfer).length,
    pages_with_transactions: [...new Set(txs.map((t) => t.page))].length,
    fiscal_documents: gt.fiscal_documents.length,
    checks: gt.accounts.flatMap((a) => a.periods.map((p) => ({ period: p.key, ...p.checks }))),
    warnings: warnings.length,
  }
  console.log(`${spec.bank.padEnd(12)} mov ${String(txs.length).padStart(4)} internos ${String(entry.internal_transfers).padStart(3)} cfdi ${String(entry.fiscal_documents)} gated ${String(gated)} ${entry.checks.map((c) => `${c.period}[saldo ${c.running_balance}, cuadre ${c.global}, totales ${c.totals}, conteos ${c.counts}]`).join(' ')}`)
  for (const w of warnings) console.log(`   aviso: ${w}`)
  return entry
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const manifest: Record<string, unknown>[] = []
  for (const spec of BANKS) {
    manifest.push(await buildBankManifestEntry(spec))
  }
  writeFileSync(join(REPO, 'evals/ground-truth/manifest.json'), `${JSON.stringify({ gt_version: GT_VERSION, built_at: TODAY, location: 'data/ground-truth/<documento>.json (no se versiona)', documents: manifest }, null, 2)}\n`)
}

await main()
