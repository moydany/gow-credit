/**
 * `extractStatement` with multi-page synthetic PDFs: several statements, missing, repeated and
 * rotated pages. Fake models, no network.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatementExtraction } from '@gow/contracts'
import { createLimiter, type Classifier, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, extractStatement } from './extract.ts'
import type { ExtractionChunk } from './llm-schema.ts'
import { multipleStatementsReason } from './pdf.ts'
import { SYNTHETIC_STATEMENT_LINES, syntheticStatementPages, syntheticStatementPdf } from './testing-synthetic-pdf.ts'

const dir = mkdtempSync(join(tmpdir(), 'gow-extract-pages-'))
let counter = 0
const write = (bytes: Uint8Array): string => {
  counter += 1
  const path = join(dir, `doc-${String(counter)}.pdf`)
  writeFileSync(path, bytes)
  return path
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const rotateOf = async (bytes: Uint8Array) => (await (await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise).getPage(1)).rotate

const MOVEMENTS = [
  ['05/03   SPEI RECIBIDO CLIENTE UNO                         5,000.00   15,000.00', '12/03   PAGO PROVEEDOR PAPELERIA             1,000.00                14,000.00'],
  ['31/03   COMISION MANEJO DE CUENTA              250.50                13,749.50'],
] as const
const HEADER = ['BANCO FICTICIO S.A. - ESTADO DE CUENTA', 'Titular: COMERCIALIZADORA DE PRUEBA SA DE CV   RFC: XAXX010101000', 'Periodo: del 01/03/2026 al 31/03/2026', 'Saldo inicial: 10,000.00   Depositos: 5,000.00   Retiros: 1,250.50   Saldo final: 13,749.50']
/** A three-page statement (header, two transactions, one transaction); each page prints "Pág n de total". */
const statementPages = (total = 3): string[][] => [
  [...HEADER, `Pág ${String(1)} de ${String(total)}`],
  ['FECHA   DESCRIPCION                          CARGO       ABONO      SALDO', ...MOVEMENTS[0], `Pág ${String(2)} de ${String(total)}`],
  ['FECHA   DESCRIPCION                          CARGO       ABONO      SALDO', ...MOVEMENTS[1], `Pág ${String(3)} de ${String(total)}`],
]


const cited = (field: string, value: string, snippet: string, page = 1) => ({ field, value, page, snippet }) as never
const fiscalOut = (uuid: string, certifiedAt: string) => ({
  kind: 'income' as const,
  page: 1,
  snippet: 'representación impresa de un CFDI',
  values: [cited('uuid', uuid, 'Folio fiscal'), cited('certified_at', certifiedAt, 'Fecha de certificación')],
  issuer_seal_present: false,
  sat_seal_present: false,
  original_chain_present: false,
  seals_look_truncated: 'unknown' as const,
})

function summaryChunk(movementPages: number[], fiscal: ReturnType<typeof fiscalOut>[] = []): ExtractionChunk {
  return {
    summary: {
      document_kind: 'bank_statement',
      holder_type: 'legal_entity',
      values: [cited('bank_name', 'BANCO FICTICIO S.A.', 'BANCO FICTICIO S.A.')],
      accounts: [
        {
          ref: 'A1',
          account_type: 'checking',
          currency: 'MXN',
          values: [],
          periods: [
            {
              ref: 'A1-P1',
              values: [cited('period_start', '01/03/2026', 'del 01/03/2026'), cited('period_end', '31/03/2026', 'al 31/03/2026'), cited('opening_balance', '10,000.00', 'Saldo inicial: 10,000.00'), cited('closing_balance', '13,749.50', 'Saldo final: 13,749.50')],
              movement_pages: movementPages,
              prints_running_balance: true,
            },
          ],
        },
      ],
      fiscal_documents: fiscal,
      suspicious_instructions: [],
    },
    transactions: [],
  }
}

const txRow = (page: number, date: string, amount: string, type: 'credit' | 'debit', balance: string, description: string) => ({
  account_ref: 'A1', period_ref: 'A1-P1', page, date, settlement_date: '', description, reference: '', amount, type, balance, internal_transfer: false, snippet: `${description} ${amount} ${balance}`,
})

interface Seen {
  purpose: string
  document: StructuredRequest<unknown>['document']
}

function fakeModels(summary: ExtractionChunk, rows: ExtractionChunk['transactions'] = []) {
  const seen: Seen[] = []
  const llm: StructuredLlm = {
    call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      seen.push({ purpose: req.purpose, document: req.document })
      const object = req.purpose === 'summary' ? summary : { summary: null, transactions: rows }
      return Promise.resolve({ object: object as T, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0.001, latencyMs: 1, model: req.model, finishReason: 'stop', responseCacheHit: false })
    },
  }
  const classifier: Classifier = {
    classify: (input) => {
      seen.push({ purpose: 'classify', document: input.pdf })
      return Promise.resolve({ documentType: 'bank_statement', confidence: 0.99, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'claude-haiku-5-5', fallback: true, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, latencyMs: 1, promptId: 'classify_document.v2', responseCacheHit: false })
    },
  }
  return { seen, deps: { llm, classifier } }
}
const opts = { ...DEFAULT_OPTIONS, limit: createLimiter(2), googleAvailable: true }

describe('extractStatement: varios estados de cuenta', () => {
  const second = statementPages(3).map((lines) => lines.map((l) => l.replace('01/03/2026', '01/04/2026').replace('31/03/2026', '30/04/2026').replace('05/03', '05/04').replace('12/03', '12/04').replace('31/03', '30/04')))
  const twoStatements = () => write(syntheticStatementPages([...statementPages(3), ...second]))

  it('modo full: corta antes de clasificar y de extraer; falla con el motivo', async () => {
    const { seen, deps } = fakeModels(summaryChunk([2, 3]))
    const doc = await extractStatement(twoStatements(), deps, { ...opts, rejectMultipleStatements: true })
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    expect(seen).toEqual([])
    expect(doc.extraction.status).toBe('failed')
    expect(doc.extraction.failure_reason).toBe(multipleStatementsReason(2))
    expect(doc.extraction.failure_reason).toBe('el PDF trae 2 estados de cuenta')
    expect(doc.flags).toContain('multiple_statements')
    expect(doc.issues.find((i) => i.code === 'multiple_statements')).toMatchObject({ severity: 'error', details: { documents: 2, restarts_at: [4] } })
    expect(doc.extraction.calls).toEqual([])
    expect(doc.accounts).toEqual([])
  })

  it('standalone: sin la opción se extrae igual y la bandera queda', async () => {
    const { seen, deps } = fakeModels(summaryChunk([2, 3]))
    const doc = await extractStatement(twoStatements(), deps, opts)
    expect(seen.map((s) => s.purpose)).toContain('summary')
    expect(doc.extraction.status).not.toBe('failed')
    expect(doc.flags).toContain('multiple_statements')
    expect(doc.extraction.failure_reason).toBeNull()
  })

  it('un documento de varias páginas completo no se corta en el modo full', async () => {
    const { seen, deps } = fakeModels(summaryChunk([2, 3]))
    const doc = await extractStatement(write(syntheticStatementPages(statementPages())), deps, { ...opts, rejectMultipleStatements: true })
    expect(seen.map((s) => s.purpose)).toContain('summary')
    expect(doc.flags).not.toContain('multiple_statements')
    expect(doc.flags).not.toContain('pages_missing')
  })

  it('sin numeración impresa, dos CFDI de ingreso en días distintos son dos estados: el modo full corta tras la pasada 1', async () => {
    const fiscal = [fiscalOut('A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', '2026-03-31T10:00:00'), fiscalOut('B1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', '2026-04-30T10:00:00')]
    const path = write(syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES))
    const full = fakeModels(summaryChunk([1], fiscal))
    const cut = await extractStatement(path, full.deps, { ...opts, rejectMultipleStatements: true })
    expect(full.seen.map((s) => s.purpose)).toEqual(['classify', 'summary'])
    expect(cut.extraction.status).toBe('failed')
    expect(cut.extraction.failure_reason).toBe('el PDF trae 2 estados de cuenta')
    expect(cut.flags).toContain('multiple_statements')
    expect(cut.issues.find((i) => i.code === 'multiple_statements')?.details).toMatchObject({ documents: 2, basis: 'cfdi' })

    const standalone = fakeModels(summaryChunk([1], fiscal))
    const kept = await extractStatement(path, standalone.deps, opts)
    expect(kept.flags).toContain('multiple_statements')
    expect(standalone.seen.map((s) => s.purpose)).toContain('transactions')
  })

  it('con numeración impresa continua, los CFDI no deciden', async () => {
    const fiscal = [fiscalOut('A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', '2026-03-31T10:00:00'), fiscalOut('B1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', '2026-04-30T10:00:00')]
    const { deps } = fakeModels(summaryChunk([2, 3], fiscal))
    const doc = await extractStatement(write(syntheticStatementPages(statementPages())), deps, { ...opts, rejectMultipleStatements: true })
    expect(doc.flags).not.toContain('multiple_statements')
  })

  it('multi_account y multi_period solos no son varios estados', async () => {
    const chunk = summaryChunk([1])
    const period = chunk.summary?.accounts[0]?.periods[0]
    if (period) chunk.summary?.accounts[0]?.periods.push({ ...period, ref: 'A1-P2' })
    const { deps } = fakeModels(chunk)
    const doc = await extractStatement(write(syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES)), deps, { ...opts, rejectMultipleStatements: true })
    expect(doc.flags).toContain('multi_period')
    expect(doc.flags).not.toContain('multiple_statements')
  })
})

describe('extractStatement: páginas que faltan, repetidas y giradas', () => {
  it('1/3 y 3/3: bandera pages_missing y un issue con la página que falta', async () => {
    const [p1, , p3] = statementPages()
    const { deps } = fakeModels(summaryChunk([2]), [txRow(2, '2026-03-31', '250.50', 'debit', '13,749.50', 'COMISION MANEJO DE CUENTA')])
    const doc = await extractStatement(write(syntheticStatementPages([p1 ?? [], p3 ?? []])), deps, opts)
    expect(doc.flags).toContain('pages_missing')
    expect(doc.issues.find((i) => i.code === 'page_missing')).toMatchObject({ severity: 'warning', details: { missing: [2], total: 3 } })
  })

  it('página repetida: sus filas se descartan antes de cuadrar y el periodo cuadra', async () => {
    const [p1, p2, p3] = statementPages()
    const bytes = syntheticStatementPages([p1 ?? [], p2 ?? [], p2 ?? [], p3 ?? []])
    const first = txRow(2, '2026-03-05', '5,000.00', 'credit', '15,000.00', 'SPEI RECIBIDO CLIENTE UNO')
    const second = txRow(2, '2026-03-12', '1,000.00', 'debit', '14,000.00', 'PAGO PROVEEDOR PAPELERIA')
    const rows = [first, second, { ...first, page: 3 }, { ...second, page: 3 }, txRow(4, '2026-03-31', '250.50', 'debit', '13,749.50', 'COMISION MANEJO DE CUENTA')]
    const { seen, deps } = fakeModels(summaryChunk([2, 3, 4]), rows)
    const doc = await extractStatement(write(bytes), deps, opts)
    const period = doc.accounts[0]?.periods[0]
    expect(period?.transactions.map((t) => [t.source.page, t.amount])).toEqual([[2, 5000], [2, 1000], [4, 250.5]])
    expect(period?.reconciliation?.status).toBe('reconciled')
    expect(doc.flags).toContain('pages_duplicated')
    expect(doc.flags).not.toContain('reconciliation_failed')
    expect(doc.issues.find((i) => i.code === 'duplicate_page_removed')).toMatchObject({ severity: 'warning', page: 3, details: { same_as: 2 } })
    expect(doc.issues.some((i) => i.code === 'count_mismatch')).toBe(false)
    // The repeated page is not sent to the model: the block carries only the distinct pages.
    expect(seen.filter((s) => s.purpose === 'transactions')).toHaveLength(1)
    expect(doc.extraction.calls.find((c) => c.purpose === 'transactions')?.pages).toEqual([2, 4])
  })

  it('/Rotate 90: el modelo recibe la copia enderezada y el hash sigue siendo el del original', async () => {
    const original = syntheticStatementPages(statementPages(), { rotate: 90 })
    const { seen, deps } = fakeModels(summaryChunk([2, 3]))
    const doc = await extractStatement(write(original), deps, opts)
    expect(doc.flags).toContain('rotated_pages')
    expect(doc.issues.filter((i) => i.code === 'page_rotated')).toHaveLength(3)
    expect(doc.document.sha256).toBe(sha(original))
    expect(doc.document.size_bytes).toBe(original.byteLength)
    const sent = seen.filter((s) => s.document !== null)
    expect(sent.length).toBeGreaterThan(2)
    for (const call of sent) {
      expect(call.document?.sha256).toBe(sha(original))
      const copy = Buffer.from(call.document?.base64 ?? '', 'base64')
      expect(await rotateOf(copy)).toBe(0)
    }
  })

  it('un PDF derecho se manda tal cual', async () => {
    const original = syntheticStatementPages(statementPages())
    const { seen, deps } = fakeModels(summaryChunk([2, 3]))
    await extractStatement(write(original), deps, opts)
    expect(seen.every((s) => s.document === null || s.document.base64 === original.toString('base64'))).toBe(true)
  })
})
