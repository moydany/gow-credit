/**
 * Escenario de `06` en modo unitario: falla del proveedor de extracción. Google cae y el
 * documento termina extraído con Opus, con el mismo contrato. Sin red: modelo falso y PDF
 * sintético (un estado que cuadra: 10,000 + 5,000 − 1,250.50 = 13,749.50).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatementExtraction } from '@gow/contracts'
import { createLimiter, LlmCallError, type Classifier, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, extractStatement } from './extract.ts'
import type { ExtractionChunk } from './llm-schema.ts'
import { planModels } from './router.ts'
import { SYNTHETIC_STATEMENT_LINES, syntheticStatementPdf } from './testing-synthetic-pdf.ts'

const dir = mkdtempSync(join(tmpdir(), 'gow-router-'))
const pdfPath = join(dir, 'synthetic.pdf')
writeFileSync(pdfPath, syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES))

const cited = (field: string, value: string, snippet: string) => ({ field, value, page: 1, snippet }) as never
const SUMMARY: ExtractionChunk = {
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
            values: [
              cited('period_start', '01/03/2026', 'del 01/03/2026'),
              cited('period_end', '31/03/2026', 'al 31/03/2026'),
              cited('opening_balance', '10,000.00', 'Saldo inicial: 10,000.00'),
              cited('closing_balance', '13,749.50', 'Saldo final: 13,749.50'),
            ],
            movement_pages: [1],
            prints_running_balance: true,
          },
        ],
      },
    ],
    fiscal_documents: [],
    suspicious_instructions: [],
  },
  transactions: [],
}
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

/** Modelo falso: Gemini se comporta según `gemini`; Claude responde bien. */
function fakeLlm(gemini: (req: StructuredRequest<unknown>) => ExtractionChunk | Error): StructuredLlm & { models: string[] } {
  const models: string[] = []
  return {
    models,
    call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      models.push(`${req.model}:${req.purpose}`)
      const answer = req.model.startsWith('gemini-') ? gemini(req) : req.purpose === 'summary' ? SUMMARY : TRANSACTIONS
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve({ object: answer as T, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0.001, latencyMs: 1, model: req.model, finishReason: 'stop', responseCacheHit: false })
    },
  }
}

const classifier: Classifier = {
  classify: () => Promise.resolve({ documentType: 'bank_statement', confidence: 0.99, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'claude-haiku-5-5', fallback: true, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, latencyMs: 1, promptId: 'classify_document.v2', responseCacheHit: false }),
}
const opts = { ...DEFAULT_OPTIONS, limit: createLimiter(2), googleAvailable: true }

describe('router de modelos (ADR 0011)', () => {
  it('escenario: Google cae y el documento termina en Opus con el mismo contrato', async () => {
    const llm = fakeLlm(() => new LlmCallError('api_error', 'Google respondió 503: unavailable', { status: 503, retryable: true }))
    const doc = await extractStatement(pdfPath, { llm, classifier }, opts)
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    expect(doc.extraction.extraction_model).toBe('claude-opus-5-5')
    expect(doc.flags).toContain('provider_fallback')
    expect(doc.accounts[0]?.periods[0]?.reconciliation?.status).toBe('reconciled')
    expect(doc.accounts[0]?.periods[0]?.transactions).toHaveLength(3)
    expect(llm.models.filter((m) => m.startsWith('gemini-'))).toEqual(['gemini-3.8-flash:summary', 'gemini-3.8-flash:summary'])
    expect(doc.extraction.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(doc.issues.find((i) => i.message.includes('Falló el proveedor de gemini-3.8-flash'))?.severity).toBe('warning')
  })

  it('con Google sano, Gemini extrae y Claude no participa', async () => {
    const llm = fakeLlm((req) => (req.purpose === 'summary' ? SUMMARY : TRANSACTIONS))
    const doc = await extractStatement(pdfPath, { llm, classifier }, opts)
    expect(doc.extraction.extraction_model).toBe('gemini-3.8-flash')
    expect(doc.extraction.calls.slice(1).every((c) => c.model === 'gemini-3.8-flash')).toBe(true)
    expect(doc.flags).not.toContain('provider_fallback')
  })

  it('dos salidas inválidas seguidas en un bloque: el bloque se repite con la emergencia por calidad', async () => {
    const llm = fakeLlm((req) => (req.purpose === 'summary' ? SUMMARY : new LlmCallError('invalid_output', 'la salida no valida contra el esquema', { retryable: true })))
    const doc = await extractStatement(pdfPath, { llm, classifier }, opts)
    expect(doc.flags).toContain('quality_fallback')
    expect(doc.extraction.calls.filter((c) => c.purpose === 'transactions').map((c) => c.model)).toEqual(['claude-opus-5-5'])
    expect(doc.accounts[0]?.periods[0]?.reconciliation?.status).toBe('reconciled')
  })

  it('sin llave de Google, extrae con Opus desde el principio', async () => {
    const llm = fakeLlm(() => new Error('no debió llamarse a Gemini'))
    const doc = await extractStatement(pdfPath, { llm, classifier }, { ...opts, googleAvailable: false })
    expect(doc.extraction.extraction_model).toBe('claude-opus-5-5')
    expect(llm.models.some((m) => m.startsWith('gemini-'))).toBe(false)
  })

  it('la doble lectura va con Claude: Opus con effort alto, Haiku si no', () => {
    expect(planModels({ googleAvailable: true, retryEffort: 'high' }).doubleRead).toBe('claude-opus-5-5')
    expect(planModels({ googleAvailable: true, retryEffort: 'medium' }).doubleRead).toBe('claude-haiku-5-5')
  })
})

describe('corte temprano del modo full (ADR 0002 y 0042)', () => {
  const tdc = (confidence: number): Classifier => ({
    classify: async (input) => ({ ...(await classifier.classify(input)), documentType: 'credit_card_statement', confidence }),
  })

  it('con el umbral, una TDC segura no se extrae: solo se paga la clasificación', async () => {
    const llm = fakeLlm(() => new Error('no debió extraerse'))
    const doc = await extractStatement(pdfPath, { llm, classifier: tdc(0.95) }, { ...opts, rejectNotStatementAbove: 0.9 })
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
    expect(llm.models).toEqual([])
    expect(doc.extraction.status).toBe('failed')
    expect(doc.flags).toContain('not_a_bank_statement')
    expect(doc.classification).toMatchObject({ document_type: 'credit_card_statement', confidence: 0.95 })
    expect(doc.extraction.calls.map((c) => c.purpose)).toEqual(['classify'])
  })

  it('por debajo del umbral, o sin umbral (standalone), se extrae igual', async () => {
    const low = fakeLlm((req) => (req.purpose === 'summary' ? SUMMARY : TRANSACTIONS))
    await extractStatement(pdfPath, { llm: low, classifier: tdc(0.6) }, { ...opts, rejectNotStatementAbove: 0.9 })
    expect(low.models.length).toBeGreaterThan(0)
    const none = fakeLlm((req) => (req.purpose === 'summary' ? SUMMARY : TRANSACTIONS))
    await extractStatement(pdfPath, { llm: none, classifier: tdc(1) }, opts)
    expect(none.models.length).toBeGreaterThan(0)
  })
})

describe('RFC del titular sin homoclave (ADR 0044)', () => {
  const withRfc = (rfc: string): ExtractionChunk => ({
    ...SUMMARY,
    summary: SUMMARY.summary ? { ...SUMMARY.summary, values: [...SUMMARY.summary.values, cited('holder_rfc', rfc, `RFC: ${rfc}`)] } : null,
  })

  it('una raíz válida no se marca como error ni baja la confianza; un RFC roto sí', async () => {
    const root = await extractStatement(pdfPath, { llm: fakeLlm((req) => (req.purpose === 'summary' ? withRfc('PEGJ850301') : TRANSACTIONS)), classifier }, opts)
    expect(root.holder.rfc.value).toBe('PEGJ850301')
    expect(root.holder.rfc.confidence).toBeGreaterThan(0.3)
    expect(root.issues.find((i) => i.code === 'invalid_rfc')?.severity).toBe('info')
    const broken = await extractStatement(pdfPath, { llm: fakeLlm((req) => (req.purpose === 'summary' ? withRfc('PEGJ85') : TRANSACTIONS)), classifier }, opts)
    expect(broken.holder.rfc.verification).toBe('unverified')
    expect(broken.issues.find((i) => i.code === 'invalid_rfc')?.severity).toBe('warning')
  })
})
