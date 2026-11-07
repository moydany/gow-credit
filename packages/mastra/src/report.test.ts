import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationResult, StatementExtraction, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { describe, expect, it } from 'vitest'
import { MemoryChannel, renderMessage } from './channels.ts'
import { EXTRACTION_SUMMARY_COLUMNS, extractionSummaryCsv, extractionSummaryRows, missingExtractionRow, renderReport, toApplicationResult } from './report.ts'
import { createRuntime, startApplication, WORKFLOW_ID } from './runtime.ts'
import { Writer } from './writer.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const doc = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
  holder,
  'rp1',
)

async function paused() {
  const wf = createRuntime({ extract: () => Promise.resolve(doc), transactionClassifier: null, writer: new Writer(null), channel: new MemoryChannel(), limit: (t) => t() }, join(mkdtempSync(join(tmpdir(), 'gow-rp-')), 'm.db'))
  return startApplication(wf, { application_id: 'demo', pdf_path: '/x/demo.pdf', as_of: '2026-10-05', request: { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }, supplier, policy: basePolicyTemplate(), policy_id: 'gow-base.v1' })
}

describe('salidas de evaluate', () => {
  it('una solicitud pausada da un ApplicationResult válido y un reporte con las preguntas', async () => {
    const r = await paused()
    const result = toApplicationResult('demo', r.state, { workflow: WORKFLOW_ID, run_id: r.runId, status: r.status, suspended_step: r.suspendedStep }, '2026-10-05T12:00:00.000Z', r.error)
    expect(ApplicationResult.safeParse(result).success).toBe(true)
    expect(result.status).toBe('needs_clarification')
    expect(result.clarification?.status).toBe('open')
    expect(result.costs.total_usd).toBe(0)
    const md = renderReport(result, r.state)
    for (const h of ['# Solicitud demo', '## Preguntas al proveedor (pendientes)', '## Por qué', '## Compuertas', '## Perfil', '## Extracción', '## Costo', '## Supuestos']) expect(md).toContain(h)
    expect(renderMessage(result.clarification?.questions ?? [])).toMatch(/^Hola\. .*\n\n1\. /s)
  })

  it('un workflow que falló sin estado también deja resultado y reporte', () => {
    const result = toApplicationResult('roto', null, { workflow: WORKFLOW_ID, run_id: 'r1', status: 'failed', suspended_step: null }, '2026-10-05T12:00:00.000Z', 'error de prueba')
    expect([result.status, result.failure_reason, result.decision]).toEqual(['failed', 'error de prueba', null])
    expect(renderReport(result, null)).toContain('**Razón:** error de prueba')
  })
})

/** Minimal CSV reader (RFC 4180) to check that what was written reads back as is. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  return rows
}

const asRecords = (csv: string) => {
  const [head = [], ...body] = parseCsv(csv)
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

describe('resumen plano de la extracción (extraction-summary.csv)', () => {
  const COLUMNS = ['file', 'document_type', 'bank', 'holder_name', 'holder_rfc', 'account_number', 'clabe', 'currency', 'period_start', 'period_end', 'opening_balance', 'closing_balance', 'total_credits', 'total_debits', 'credits_count', 'debits_count', 'transactions_extracted', 'reconciled', 'cfdi_uuid', 'extraction_status']

  it('lleva exactamente las columnas pedidas, en orden, y una fila con las rutas del contrato', () => {
    expect(EXTRACTION_SUMMARY_COLUMNS).toEqual(COLUMNS)
    const clabe = '012180001234567897'
    const s = syntheticStatement(
      { bank: 'BBVA', start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, count: 2 }, { kind: 'supplier_payment', amount: 30000 }], fiscal: { uuid: '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0', regime: '626' } },
      { ...holder, clabe },
      'csv1',
    )
    const csv = extractionSummaryCsv(extractionSummaryRows(s))
    expect(csv.split('\n')[0]).toBe(COLUMNS.join(','))
    expect(asRecords(csv)).toEqual([
      {
        file: 'synthetic-csv1.pdf',
        document_type: 'bank_statement',
        bank: 'BBVA',
        holder_name: holder.name,
        holder_rfc: holder.rfc,
        account_number: '65-XXXX-4',
        clabe,
        currency: 'MXN',
        period_start: '2026-09-01',
        period_end: '2026-09-30',
        opening_balance: '20000.00',
        closing_balance: '50000.00',
        total_credits: '60000.00',
        total_debits: '30000.00',
        credits_count: '2',
        debits_count: '1',
        transactions_extracted: '3',
        reconciled: 'true',
        cfdi_uuid: '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
        extraction_status: 'complete',
      },
    ])
  })

  it('una fila por cuenta, con comillas donde hace falta, y el CSV se lee de vuelta igual', () => {
    const base = syntheticStatement({ start: '2026-09-01', opening_balance: 1000, monthly: [{ kind: 'customer_payment', amount: 500 }] }, { name: 'Comercial "El Sol", S.A. de C.V.', rfc: 'CSO150304AB1', clabe: null }, 'csv2')
    const first = base.accounts[0]
    if (!first) throw new Error('el sintético no trae cuenta')
    const second = { ...first, id: 'a2', account_number: { ...first.account_number, value: '0123, 4567' }, periods: first.periods.map((p) => ({ ...p, id: `a2.${p.id}`, transactions: p.transactions.map((t) => ({ ...t, id: `a2.${t.id}` })) })) }
    const s = StatementExtraction.parse({ ...base, accounts: [first, second], flags: ['multi_account'] })
    const rows = extractionSummaryRows(s)
    expect(rows.map((r) => r.account_number)).toEqual(['65-XXXX-4', '0123, 4567'])
    const csv = extractionSummaryCsv(rows)
    expect(csv).toContain('"Comercial ""El Sol"", S.A. de C.V."')
    expect(csv).toContain('"0123, 4567"')
    const back = asRecords(csv)
    expect(back).toHaveLength(2)
    expect(back.map((r) => r.holder_name)).toEqual(['Comercial "El Sol", S.A. de C.V.', 'Comercial "El Sol", S.A. de C.V.'])
    expect(back.map((r) => r.account_number)).toEqual(['65-XXXX-4', '0123, 4567'])
    // Every row carries all the columns: the CSV does not misalign with values that contain a comma.
    expect(parseCsv(csv).every((r) => r.length === COLUMNS.length)).toBe(true)
  })

  it('varios periodos de una cuenta: del primero el saldo inicial, del último el final y se suman los totales impresos', () => {
    const s = syntheticStatement({ start: '2026-07-01', months: 3, opening_balance: 1000, monthly: [{ kind: 'customer_payment', amount: 600, count: 3 }, { kind: 'supplier_payment', amount: 300 }] }, holder, 'csv3')
    expect(s.accounts[0]?.periods).toHaveLength(3)
    const [row, ...rest] = asRecords(extractionSummaryCsv(extractionSummaryRows(s)))
    expect(rest).toEqual([])
    expect(row).toMatchObject({ period_start: '2026-07-01', period_end: '2026-09-30', opening_balance: '1000.00', closing_balance: '1900.00', total_credits: '1800.00', total_debits: '900.00', credits_count: '9', debits_count: '3', transactions_extracted: '12', reconciled: 'true' })
  })

  it('lo que el banco no imprimió o no cuadra no se inventa: la columna va vacía o en false', () => {
    const s = syntheticStatement({ start: '2026-09-01', opening_balance: 1000, monthly: [{ kind: 'customer_payment', amount: 500 }], reconciled: false }, holder, 'csv4')
    const first = s.accounts[0]
    if (!first) throw new Error('el sintético no trae cuenta')
    const period = first.periods[0]
    if (!period) throw new Error('el sintético no trae periodo')
    const sparse = StatementExtraction.parse({ ...s, bank_name: { ...s.bank_name, value: null }, accounts: [{ ...first, clabe: { ...first.clabe, value: null }, periods: [{ ...period, summary: { ...period.summary, total_credits: { ...period.summary.total_credits, value: null, source: null, verification: 'unverified' as const } } }] }] })
    const [row] = asRecords(extractionSummaryCsv(extractionSummaryRows(sparse)))
    // With no bank read, what the classifier said stays; the total that was not printed is empty
    // (not the sum of the transactions).
    expect(row).toMatchObject({ bank: 'BANCO FICTICIO', clabe: '', total_credits: '', total_debits: '0.00', reconciled: 'false', cfdi_uuid: '' })
  })

  it('un documento sin cuentas, o sin extracción, también deja su fila', () => {
    const s = syntheticStatement({ start: '2026-09-01', opening_balance: 1000, monthly: [{ kind: 'customer_payment', amount: 500 }] }, holder, 'csv5')
    const failed = StatementExtraction.parse({ ...s, accounts: [], extraction: { ...s.extraction, status: 'failed', failure_reason: 'prueba' } })
    expect(asRecords(extractionSummaryCsv(extractionSummaryRows(failed)))).toEqual([
      { ...Object.fromEntries(COLUMNS.map((c) => [c, ''])), file: 'synthetic-csv5.pdf', document_type: 'bank_statement', bank: 'BANCO FICTICIO', holder_name: holder.name, holder_rfc: holder.rfc, extraction_status: 'failed' },
    ])
    expect(asRecords(extractionSummaryCsv([missingExtractionRow('roto.pdf', true), missingExtractionRow('otro.pdf', false)]))).toEqual([
      { ...Object.fromEntries(COLUMNS.map((c) => [c, ''])), file: 'roto.pdf', extraction_status: 'failed' },
      { ...Object.fromEntries(COLUMNS.map((c) => [c, ''])), file: 'otro.pdf' },
    ])
  })
})
