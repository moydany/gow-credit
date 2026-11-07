/**
 * Doble lectura del encabezado en documentos sin texto (docs/04 §3.6, ADR 0011). Sin red: modelo
 * falso y PDFs sintéticos (uno sin capa de texto, que va por visión, y uno con ella).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatementExtraction } from '@gow/contracts'
import { createLimiter, LlmCallError, type Classifier, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { assembleSummary } from './assemble.ts'
import { applyHeaderDoubleRead, compareHeaders, headerDoubleRead, type HeaderDoubleReadOptions } from './double-read.ts'
import { DEFAULT_OPTIONS, extractStatement } from './extract.ts'
import { IssueSink } from './issues.ts'
import type { CitedOut, ExtractionChunk, SummaryOut } from './llm-schema.ts'
import { PageText } from './page-text.ts'
import { SYNTHETIC_STATEMENT_LINES, syntheticStatementPdf } from './testing-synthetic-pdf.ts'

type FieldName = CitedOut['field']

/** Lo que imprime el estado de cuenta ficticio: cuadra 10,000 + 5,000 − 1,250.50 = 13,749.50. */
const BASE: Partial<Record<FieldName, string>> = {
  bank_name: 'BANCO FICTICIO S.A.',
  holder_name: 'COMERCIALIZADORA DE PRUEBA SA DE CV',
  holder_rfc: 'PEGJ850301AB1',
  account_number: '0123456789',
  clabe: '002010077777777771',
  period_start: '01/03/2026',
  period_end: '31/03/2026',
  statement_date: '31/03/2026',
  opening_balance: '10,000.00',
  closing_balance: '13,749.50',
  total_credits: '5,000.00',
  total_debits: '1,250.50',
  credits_count: '1',
  debits_count: '2',
}
const HEADER: FieldName[] = ['bank_name', 'holder_name', 'holder_rfc']
const ACCOUNT: FieldName[] = ['account_number', 'clabe']
const PERIOD: FieldName[] = ['period_start', 'period_end', 'statement_date', 'opening_balance', 'closing_balance', 'total_credits', 'total_debits', 'credits_count', 'debits_count']

type Overrides = Partial<Record<FieldName, string | null>>

/** Una lectura del encabezado: `over` cambia un valor y `null` lo quita (no se leyó). */
function summaryOf(over: Overrides = {}, refs: { account: string; period: string } = { account: 'A1', period: 'A1-P1' }): SummaryOut {
  const values = (names: FieldName[]): CitedOut[] =>
    names.flatMap((field) => {
      const value = field in over ? over[field] : BASE[field]
      return value === null || value === undefined ? [] : [{ field, value, page: 1, snippet: `${field}: ${value}` }]
    })
  return {
    document_kind: 'bank_statement',
    holder_type: 'legal_entity',
    values: values(HEADER),
    accounts: [
      {
        ref: refs.account,
        account_type: 'checking',
        currency: 'MXN',
        values: values(ACCOUNT),
        periods: [{ ref: refs.period, values: values(PERIOD), movement_pages: [1], prints_running_balance: true }],
      },
    ],
    fiscal_documents: [],
    suspicious_instructions: [],
  }
}
const chunk = (summary: SummaryOut): ExtractionChunk => ({ summary, transactions: [] })

const row = (date: string, amount: string, type: 'credit' | 'debit', balance: string, description: string) => ({
  account_ref: 'A1', period_ref: 'A1-P1', page: 1, date, settlement_date: '', description, reference: '', amount, type, balance, internal_transfer: false, snippet: `${description} ${amount} ${balance}`,
})
const TRANSACTIONS: ExtractionChunk = {
  summary: null,
  transactions: [
    row('2026-03-05', '5,000.00', 'credit', '15,000.00', 'SPEI RECIBIDO CLIENTE UNO'),
    row('2026-03-12', '1,000.00', 'debit', '14,000.00', 'PAGO PROVEEDOR PAPELERIA'),
    row('2026-03-31', '250.50', 'debit', '13,749.50', 'COMISION MANEJO DE CUENTA'),
  ],
}

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

interface Seen {
  purpose: string
  model: string
  effort: string
  schemaName: string
  instruction: string
  system: string
}

/** Modelo falso: la pasada 1 lee `first`, los bloques traen los movimientos y la doble lectura responde `second`. */
function fakeLlm(second: (req: StructuredRequest<unknown>) => ExtractionChunk | Error, first: SummaryOut = summaryOf()): StructuredLlm & { seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      seen.push({ purpose: req.purpose, model: req.model, effort: req.effort, schemaName: req.schemaName, instruction: req.instruction, system: req.system })
      const answer = req.purpose === 'double_read' ? second(req) : req.purpose === 'summary' ? chunk(first) : TRANSACTIONS
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve({ object: answer as T, usage: USAGE, costUsd: 0.001, latencyMs: 1, model: req.model, finishReason: 'stop', responseCacheHit: false })
    },
  }
}

const classifier: Classifier = {
  classify: () => Promise.resolve({ documentType: 'bank_statement', confidence: 0.99, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'claude-haiku-5-5', fallback: true, usage: USAGE, costUsd: 0, latencyMs: 1, promptId: 'classify_document.v2', responseCacheHit: false }),
}

const dir = mkdtempSync(join(tmpdir(), 'gow-double-read-'))
// Casi sin texto: la capa se evalúa como ausente y el documento va por visión.
const scannedPath = join(dir, 'escaneado.pdf')
writeFileSync(scannedPath, syntheticStatementPdf(['IMAGEN ESCANEADA']))
const textPath = join(dir, 'con-texto.pdf')
writeFileSync(textPath, syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES))

const extractOpts = { ...DEFAULT_OPTIONS, limit: createLimiter(2), googleAvailable: true }
const noText = new PageText({ pageTexts: [''], textLayer: 'absent', textRepaired: false })

// ---------------------------------------------------------------- comparación pura

describe('compareHeaders', () => {
  const statuses = (second: SummaryOut, first: SummaryOut = summaryOf(), text = noText) => Object.fromEntries(compareHeaders(first, second, text).map((r) => [r.field, r.status]))

  it('compara los catorce valores del encabezado, las cuentas y los periodos', () => {
    const readings = compareHeaders(summaryOf(), summaryOf(), noText)
    expect(readings.map((r) => r.field).sort()).toEqual(Object.keys(BASE).sort())
    expect(readings.every((r) => r.status === 'agree')).toBe(true)
    expect(readings.find((r) => r.field === 'closing_balance')).toMatchObject({ account: 0, period: 0, first: 13749.5, second: 13749.5 })
    expect(readings.find((r) => r.field === 'bank_name')).toMatchObject({ account: null, period: null })
  })

  it('tolera acentos, mayúsculas, puntuación, formato de montos y de fechas', () => {
    const second = summaryOf({
      bank_name: 'Banco Ficticio',
      holder_name: 'Comercializadora de Prueba, S.A. de C.V.',
      holder_rfc: 'pegj-850301-ab1',
      clabe: '0020 1007 7777 7777 71',
      period_start: '2026-03-01',
      closing_balance: '$13749.50',
      total_debits: '1250.5',
    })
    expect(Object.values(statuses(second)).every((s) => s === 'agree')).toBe(true)
  })

  it('un valor distinto es desacuerdo: una fecha, un dígito, un RFC, un conteo', () => {
    const s = statuses(summaryOf({ period_end: '30/03/2026', closing_balance: '13,749.60', holder_rfc: 'PEGJ850301AB2', debits_count: '3' }))
    expect(s).toMatchObject({ period_end: 'disagree', closing_balance: 'disagree', holder_rfc: 'disagree', debits_count: 'disagree', bank_name: 'agree', opening_balance: 'agree' })
  })

  it('un titular con otro nombre es desacuerdo; un banco contenido en el otro, no', () => {
    expect(statuses(summaryOf({ holder_name: 'COMERCIALIZADORA DE PRUEBA' })).holder_name).toBe('disagree')
    expect(statuses(summaryOf({ bank_name: 'BANCO FICTICIO S.A., INSTITUCION DE BANCA MULTIPLE' })).bank_name).toBe('agree')
    expect(statuses(summaryOf({ bank_name: 'BANCO REAL' })).bank_name).toBe('disagree')
  })

  it('lo que el segundo no leyó es solo_first; lo que el primero no leyó no se compara', () => {
    const readings = compareHeaders(summaryOf({ closing_balance: null }), summaryOf({ clabe: null }), noText)
    expect(readings.find((r) => r.field === 'clabe')).toMatchObject({ status: 'only_first', second: null })
    expect(readings.some((r) => r.field === 'closing_balance')).toBe(false)
  })

  it('empareja cuentas y periodos por ref, aunque el segundo los liste en otro orden', () => {
    const a1 = summaryOf()
    const a2 = summaryOf({ account_number: '9876543210', closing_balance: '500.00' }, { account: 'A2', period: 'A2-P1' })
    const first: SummaryOut = { ...a1, accounts: [...a1.accounts, ...a2.accounts] }
    const second: SummaryOut = { ...a1, accounts: [...a2.accounts, ...a1.accounts] }
    const readings = compareHeaders(first, second, noText)
    expect(readings.filter((r) => r.field === 'account_number').map((r) => r.status)).toEqual(['agree', 'agree'])
    expect(readings.filter((r) => r.field === 'closing_balance').map((r) => [r.account, r.first, r.second])).toEqual([[0, 13749.5, 13749.5], [1, 500, 500]])
  })

  it('si el segundo nombra distinto los refs pero trae la misma forma, empareja por posición', () => {
    const s = statuses(summaryOf({}, { account: 'Cuenta 1', period: 'Marzo' }))
    expect(Object.values(s).every((x) => x === 'agree')).toBe(true)
  })

  it('una cuenta que el segundo no trae queda solo_first completa', () => {
    const a1 = summaryOf()
    const a2 = summaryOf({ account_number: '9876543210' }, { account: 'A2', period: 'A2-P1' })
    const first: SummaryOut = { ...a1, accounts: [...a1.accounts, ...a2.accounts] }
    const readings = compareHeaders(first, a1, noText)
    expect(readings.filter((r) => r.account === 1).every((r) => r.status === 'only_first')).toBe(true)
    expect(readings.filter((r) => r.account === 0).every((r) => r.status === 'agree')).toBe(true)
  })
})

// ---------------------------------------------------------------- lectura y aplicación

describe('headerDoubleRead y applyHeaderDoubleRead', () => {
  const pdfInput = { base64: 'AAAA', sha256: 'a'.repeat(64), cache: true }
  const recorded: string[] = []
  const options = (over: Partial<HeaderDoubleReadOptions> = {}): HeaderDoubleReadOptions => ({
    text: noText,
    model: 'claude-opus-5-5',
    firstModel: 'gemini-3.8-flash',
    system: 'SISTEMA',
    instruction: 'INSTRUCCION DE LA PASADA 1',
    promptVersion: 'extract_summary.v2',
    limit: createLimiter(1),
    record: (purpose, prompt, effort, pages, r) => recorded.push(`${purpose}|${String(prompt)}|${String(effort)}|${pages.join(',')}|${r.model}`),
    ...over,
  })
  const run = async (second: (req: StructuredRequest<unknown>) => ExtractionChunk | Error, over: Partial<HeaderDoubleReadOptions> = {}) => {
    const first = summaryOf()
    const summary = assembleSummary(first, noText)
    const issues = new IssueSink()
    const llm = fakeLlm(second)
    const read = await headerDoubleRead({ llm }, first, pdfInput, options(over))
    const flag = applyHeaderDoubleRead(read, summary, issues)
    return { read, flag, summary, issues, llm }
  }

  it('repite la pasada 1 con el otro modelo, a effort medio, y registra la llamada', async () => {
    recorded.length = 0
    const { llm } = await run(() => chunk(summaryOf()))
    expect(llm.seen).toEqual([{ purpose: 'double_read', model: 'claude-opus-5-5', effort: 'medium', schemaName: 'extraction_chunk.v2', instruction: 'INSTRUCCION DE LA PASADA 1', system: 'SISTEMA' }])
    expect(recorded).toEqual(['double_read|extract_summary.v2|medium||claude-opus-5-5'])
  })

  it('acuerdo total: todo queda verified con la cita de la primera lectura y sin issues', async () => {
    const { flag, summary, issues } = await run(() => chunk(summaryOf()))
    expect(flag).toBe(true)
    expect(issues.issues).toEqual([])
    const p = summary.accounts[0]?.periods[0]
    for (const f of [summary.bankName, summary.holder.name, summary.holder.rfc, summary.accounts[0]?.account_number, summary.accounts[0]?.clabe, p?.period_start, p?.period_end, p?.statement_date, p?.summary.opening_balance, p?.summary.closing_balance, p?.summary.total_credits, p?.summary.total_debits, p?.summary.credits_count, p?.summary.debits_count]) {
      expect(f).toMatchObject({ verification: 'verified', provenance: 'extracted' })
      expect(f?.confidence).toBeGreaterThanOrEqual(0.9)
    }
    expect(summary.bankName.source).toEqual({ page: 1, snippet: 'bank_name: BANCO FICTICIO S.A.' })
    expect(p?.period_end).toMatchObject({ value: '2026-03-31', source: { page: 1, snippet: 'period_end: 31/03/2026' } })
  })

  it('una fecha distinta: conflict en esa y verified en el resto', async () => {
    const { flag, summary, issues } = await run(() => chunk(summaryOf({ period_end: '30/03/2026' })))
    expect(flag).toBe(true)
    const p = summary.accounts[0]?.periods[0]
    expect(p?.period_end).toMatchObject({ value: '2026-03-31', verification: 'conflict' })
    expect(p?.period_end.confidence).toBeLessThanOrEqual(0.3)
    expect(p?.period_start.verification).toBe('verified')
    expect(summary.holder.name.verification).toBe('verified')
    expect(issues.issues).toHaveLength(1)
    expect(issues.issues[0]).toMatchObject({
      code: 'header_read_conflict',
      severity: 'warning',
      path: '/accounts/0/periods/0/period_end',
      page: 1,
      account_id: 'a1',
      period_id: 'a1.p1',
      details: { first: '2026-03-31', second: '2026-03-30' },
    })
  })

  it('el issue apunta al campo y no repite valores en el mensaje', async () => {
    const { issues } = await run(() => chunk(summaryOf({ bank_name: 'OTRO BANCO', holder_name: 'OTRA PERSONA', closing_balance: '99.00', clabe: '012180000000000001' })))
    expect(issues.issues.map((i) => i.path).sort()).toEqual(['/accounts/0/clabe', '/accounts/0/periods/0/summary/closing_balance', '/bank_name', '/holder/name'])
    expect(issues.issues.find((i) => i.path === '/holder/name')).toMatchObject({ account_id: null, period_id: null, details: { first: 'COMERCIALIZADORA DE PRUEBA SA DE CV', second: 'OTRA PERSONA' } })
    for (const i of issues.issues) {
      expect(i.message).toMatch(/^Las dos lecturas del documento no coinciden en /)
      for (const secret of ['OTRO BANCO', 'OTRA PERSONA', 'COMERCIALIZADORA', '99.00', '13,749', '0020100777']) expect(i.message).not.toContain(secret)
    }
  })

  it('lo que solo leyó la primera lectura queda como estaba', async () => {
    const { flag, summary, issues } = await run(() => chunk(summaryOf({ clabe: null })))
    expect(flag).toBe(true)
    expect(summary.accounts[0]?.clabe).toMatchObject({ value: '002010077777777771', verification: 'unverified' })
    expect(issues.issues).toEqual([])
  })

  it('un valor sin cita no se verifica aunque coincida (el contrato exige fuente)', async () => {
    const first = summaryOf()
    const bare = { ...first, values: first.values.map((v) => (v.field === 'bank_name' ? { ...v, page: 0, snippet: '' } : v)) }
    const summary = assembleSummary(bare, noText)
    const read = await headerDoubleRead({ llm: fakeLlm(() => chunk(summaryOf())) }, bare, pdfInput, options())
    expect(applyHeaderDoubleRead(read, summary, new IssueSink())).toBe(true)
    expect(summary.bankName).toMatchObject({ value: 'BANCO FICTICIO S.A.', source: null, verification: 'unverified' })
    expect(summary.holder.name.verification).toBe('verified')
  })

  it.each([
    ['proveedor caído', new LlmCallError('api_error', 'Anthropic respondió 529', { status: 529, retryable: true }), 'api_error'],
    ['sin llave', new LlmCallError('missing_api_key', 'falta ANTHROPIC_API_KEY'), 'missing_api_key'],
    ['sin respuesta en caché (--cache read)', new Error('respuesta no está en caché (double_read) y no hay cliente de modelo'), 'caché'],
  ])('si falla (%s): sin bandera, sin conflicto y un issue informativo', async (_name, failure, expected) => {
    const { flag, summary, issues, read } = await run(() => failure)
    expect(read.status).toBe('failed')
    expect(flag).toBe(false)
    expect(issues.issues).toHaveLength(1)
    expect(issues.issues[0]).toMatchObject({ code: 'block_failed', severity: 'info' })
    expect(issues.issues[0]?.message).toContain(expected)
    expect(summary.bankName.verification).toBe('unverified')
    expect(summary.accounts[0]?.periods[0]?.period_end.verification).toBe('unverified')
  })

  it('una segunda lectura sin resumen cuenta como falla', async () => {
    const { read, flag, issues } = await run(() => ({ summary: null, transactions: [] }))
    expect(read).toEqual({ status: 'failed', reason: 'la segunda lectura no devolvió resumen' })
    expect(flag).toBe(false)
    expect(issues.issues[0]?.code).toBe('block_failed')
  })

  it('con el mismo modelo en las dos lecturas no llama: no sería una segunda opinión', async () => {
    const { read, flag, issues, llm } = await run(() => new Error('no debió llamarse'), { model: 'claude-opus-5-5', firstModel: 'claude-opus-5-5' })
    expect(llm.seen).toEqual([])
    expect(read.status).toBe('failed')
    expect(flag).toBe(false)
    expect(issues.issues[0]).toMatchObject({ code: 'block_failed', severity: 'info' })
  })

  it('lo ya verificado contra el texto local no se vuelve a juzgar ni se llama si todo lo está', async () => {
    const all = Object.entries(BASE).map(([f, v]) => `${f}: ${v}`)
    const text = (lines: string[]) => new PageText({ pageTexts: [lines.join('\n')], textLayer: 'ok', textRepaired: false })

    // Todo verificado por el texto: sin llamada.
    const full = text(all)
    expect(assembleSummary(summaryOf(), full).bankName.verification).toBe('verified')
    const llmFull = fakeLlm(() => new Error('no debió llamarse'))
    expect(await headerDoubleRead({ llm: llmFull }, summaryOf(), pdfInput, options({ text: full }))).toEqual({ status: 'skipped' })
    expect(llmFull.seen).toEqual([])

    // Solo el banco está en el texto: lo demás se relee y el banco no se degrada aunque el segundo lea otro.
    const partial = text(['bank_name: BANCO FICTICIO S.A.'])
    const summary = assembleSummary(summaryOf(), partial)
    const issues = new IssueSink()
    const read = await headerDoubleRead({ llm: fakeLlm(() => chunk(summaryOf({ bank_name: 'OTRO BANCO', closing_balance: '1.00' }))) }, summaryOf(), pdfInput, options({ text: partial }))
    expect(applyHeaderDoubleRead(read, summary, issues)).toBe(true)
    expect(summary.bankName.verification).toBe('verified')
    expect(issues.issues.map((i) => i.path)).toEqual(['/accounts/0/periods/0/summary/closing_balance'])
  })
})

// ---------------------------------------------------------------- de punta a punta

describe('extractStatement: documento sin texto', () => {
  it('acuerdo total: bandera, llamada registrada con la otra familia y el encabezado verificado', async () => {
    const llm = fakeLlm(() => chunk(summaryOf()))
    const doc = await extractStatement(scannedPath, { llm, classifier }, extractOpts)
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    expect(doc.document.route).toBe('vision_only')
    expect(doc.flags).toEqual(expect.arrayContaining(['vision_only', 'header_double_read']))
    expect(doc.extraction.status).toBe('complete')
    expect(doc.accounts[0]?.periods[0]?.reconciliation?.status).toBe('reconciled')

    expect(llm.seen.filter((s) => s.purpose === 'double_read')).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', effort: 'medium', schemaName: 'extraction_chunk.v2' }),
    ])
    const first = llm.seen.find((s) => s.purpose === 'summary')
    const second = llm.seen.find((s) => s.purpose === 'double_read')
    expect(second?.instruction).toBe(first?.instruction)
    expect(second?.system).toBe(first?.system)
    expect(first?.model).toBe('gemini-3.8-flash')
    const call = doc.extraction.calls.find((c) => c.purpose === 'double_read')
    expect(call).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', pages: [], cost_usd: 0.001, response_cache_hit: false })
    expect(call?.prompt).toBe(doc.extraction.calls.find((c) => c.purpose === 'summary')?.prompt)

    const p = doc.accounts[0]?.periods[0]
    for (const f of [doc.bank_name, doc.holder.name, doc.holder.rfc, doc.accounts[0]?.account_number, doc.accounts[0]?.clabe, p?.period_start, p?.period_end, p?.statement_date, p?.summary.credits_count, p?.summary.debits_count]) {
      expect(f?.verification).toBe('verified')
    }
    expect(doc.issues.filter((i) => i.code === 'header_read_conflict')).toEqual([])
  })

  it('una fecha distinta: conflict en esa, verified en el resto y el issue en la extracción', async () => {
    const llm = fakeLlm(() => chunk(summaryOf({ period_end: '30/03/2026' })))
    const doc = await extractStatement(scannedPath, { llm, classifier }, extractOpts)
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    const p = doc.accounts[0]?.periods[0]
    expect(p?.period_end).toMatchObject({ value: '2026-03-31', verification: 'conflict' })
    expect(p?.period_start.verification).toBe('verified')
    expect(doc.holder.name.verification).toBe('verified')
    expect(doc.flags).toContain('header_double_read')
    const conflicts = doc.issues.filter((i) => i.code === 'header_read_conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ severity: 'warning', path: '/accounts/0/periods/0/period_end', details: { first: '2026-03-31', second: '2026-03-30' } })
  })

  it('el cuadre aritmético y los validadores de formato mandan sobre la doble lectura', async () => {
    // Saldo final leído distinto en la segunda lectura, pero el periodo cuadra con la primera: queda verificado por la aritmética.
    // Una CLABE que no pasa el dígito verificador no se verifica aunque las dos lecturas coincidan.
    const bad = { clabe: '002010077777777772' }
    const llm = fakeLlm(() => chunk(summaryOf({ ...bad, closing_balance: '13,000.00' })), summaryOf(bad))
    const doc = await extractStatement(scannedPath, { llm, classifier }, extractOpts)
    const p = doc.accounts[0]?.periods[0]
    expect(p?.reconciliation?.status).toBe('reconciled')
    expect(p?.summary.closing_balance.verification).toBe('verified')
    expect(doc.accounts[0]?.clabe.verification).toBe('unverified')
    expect(doc.issues.some((i) => i.code === 'invalid_clabe')).toBe(true)
  })

  it('si la segunda lectura falla: sin bandera, sin conflicto, el resto igual que hoy', async () => {
    const llm = fakeLlm(() => new LlmCallError('api_error', 'Anthropic respondió 529', { status: 529, retryable: true }))
    const doc = await extractStatement(scannedPath, { llm, classifier }, extractOpts)
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    expect(doc.flags).toContain('vision_only')
    expect(doc.flags).not.toContain('header_double_read')
    expect(doc.flags).not.toContain('provider_fallback')
    expect(doc.extraction.status).toBe('complete')
    expect(doc.extraction.calls.some((c) => c.purpose === 'double_read')).toBe(false)
    expect(doc.issues.some((i) => i.code === 'header_read_conflict')).toBe(false)
    expect(doc.issues.find((i) => i.message.startsWith('No se hizo la doble lectura del encabezado'))).toMatchObject({ code: 'block_failed', severity: 'info' })
    expect(doc.bank_name.verification).toBe('unverified')
    expect(doc.accounts[0]?.periods[0]?.period_end.verification).toBe('unverified')
    expect(doc.accounts[0]?.periods[0]?.reconciliation?.status).toBe('reconciled')
  })

  it('con --cache read y sin respuesta en caché se comporta igual que una falla', async () => {
    const llm = fakeLlm(() => new Error('respuesta no está en caché (double_read) y no hay cliente de modelo'))
    const doc = await extractStatement(scannedPath, { llm, classifier }, extractOpts)
    expect(doc.flags).not.toContain('header_double_read')
    expect(doc.extraction.status).toBe('complete')
    expect(doc.issues.filter((i) => i.code === 'block_failed' && i.severity === 'info')).toHaveLength(1)
  })

  it('sin llave de Google el principal ya es Opus: no hay segunda familia y no se llama', async () => {
    const llm = fakeLlm(() => new Error('no debió llamarse'))
    const doc = await extractStatement(scannedPath, { llm, classifier }, { ...extractOpts, googleAvailable: false })
    expect(doc.extraction.extraction_model).toBe('claude-opus-5-5')
    expect(llm.seen.some((s) => s.purpose === 'double_read')).toBe(false)
    expect(doc.flags).not.toContain('header_double_read')
    expect(doc.issues.some((i) => i.code === 'block_failed' && i.message.includes('segunda lectura es el mismo'))).toBe(true)
  })
})

describe('extractStatement: documento con texto', () => {
  it('no hay doble lectura de encabezado: el texto local ya lo verifica', async () => {
    const llm = fakeLlm(() => new Error('no debió llamarse'))
    const doc = await extractStatement(textPath, { llm, classifier }, extractOpts)
    expect(doc.document.route).toBe('text_and_vision')
    expect(llm.seen.some((s) => s.purpose === 'double_read')).toBe(false)
    expect(doc.flags).not.toContain('header_double_read')
    expect(doc.extraction.calls.some((c) => c.purpose === 'double_read')).toBe(false)
  })
})
