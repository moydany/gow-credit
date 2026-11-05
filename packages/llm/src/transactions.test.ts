import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CacheMissError, JsonFileCache } from './json-cache.ts'
import { ZERO_USAGE } from './models.ts'
import type { StructuredLlm, StructuredRequest, StructuredResult } from './structured.ts'
import { allowedCategories, classifyTransactionRows, ClaudeTransactionClassifier, createTransactionClassifier, JevTransactionClassifier, type TransactionRow } from './transactions.ts'

const rows: TransactionRow[] = [
  { id: 't1', date: '2026-09-02', type: 'credit', amount: 5000, description: 'SPEI RECIBIDO CLIENTE UNO', reference: null },
  { id: 't2', date: '2026-09-03', type: 'debit', amount: 1200, description: 'PAGO A TERCERO', reference: 'REF 9' },
  { id: 't3', date: '2026-09-04', type: 'credit', amount: 800, description: 'OPERACION 77', reference: null },
]

/** Responde con etiquetas fijas y guarda lo que recibió. */
class FakeLlm implements StructuredLlm {
  readonly requests: StructuredRequest<unknown>[] = []
  constructor(readonly labels: { id: string; category: string }[]) {}
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req)
    const object = req.schema.parse({ labels: this.labels })
    return Promise.resolve({ object, usage: { ...ZERO_USAGE, input_tokens: 100, output_tokens: 20 }, costUsd: 0.00002, latencyMs: 5, model: req.model, finishReason: 'stop', responseCacheHit: false })
  }
}

const noLimit = <T>(task: () => Promise<T>) => task()

describe('clasificación de movimientos', () => {
  it('las opciones dependen del sentido', () => {
    expect(allowedCategories('credit')).toContain('loan_disbursement')
    expect(allowedCategories('credit')).not.toContain('payroll')
    expect(allowedCategories('debit')).toContain('loan_payment')
    expect(allowedCategories('debit')).not.toContain('customer_payment')
  })

  it('Haiku: descarta etiquetas que no corresponden al sentido y las de ids ajenos', async () => {
    const llm = new FakeLlm([
      { id: 't1', category: 'customer_payment' },
      { id: 't2', category: 'customer_payment' },
      { id: 't3', category: 'loan_disbursement' },
      { id: 'x9', category: 'other' },
    ])
    const c = new ClaudeTransactionClassifier(llm, { isFallback: true })
    const r = await classifyTransactionRows(c, rows, { bank: 'Banco Ficticio', limit: noLimit, batchSize: 2 })
    expect(r.labels.map((l) => [l.id, l.category])).toEqual([
      ['t1', 'customer_payment'],
      ['t3', 'loan_disbursement'],
    ])
    expect(r.batches).toHaveLength(2)
    expect(llm.requests[0]?.promptVersion).toBe('classify_transactions.v1')
    expect(llm.requests[0]?.instruction).toContain('Banco Ficticio')
  })

  it('sin llave de Jev clasifica Haiku y lo marca como respaldo', () => {
    const cache = new JsonFileCache(mkdtempSync(join(tmpdir(), 'gow-tx-')), 'off')
    const c = createTransactionClassifier(new FakeLlm([]), cache, {})
    expect([c.implementation, c.fallback, c.calibrated]).toEqual(['claude', true, false])
    const jev = createTransactionClassifier(new FakeLlm([]), cache, { TYPESAFE_API_KEY: 'llave-de-prueba' })
    expect([jev.implementation, jev.fallback, jev.calibrated]).toEqual(['jev', false, true])
  })

  it('Jev con caché de solo lectura y sin respuesta guardada falla sin llamar a la red', async () => {
    const cache = new JsonFileCache(mkdtempSync(join(tmpdir(), 'gow-tx-')), 'read')
    const jev = new JevTransactionClassifier('llave-de-prueba', cache)
    await expect(jev.classifyBatch(rows, { bank: null })).rejects.toBeInstanceOf(CacheMissError)
  })

  it('la caché devuelve lo guardado sin volver a calcular', async () => {
    const cache = new JsonFileCache(mkdtempSync(join(tmpdir(), 'gow-tx-')), 'readwrite')
    let calls = 0
    const compute = () => {
      calls++
      return Promise.resolve({ n: 1 })
    }
    expect(await cache.through('k1', 'prueba', compute)).toEqual({ value: { n: 1 }, hit: false })
    expect(await cache.through('k1', 'prueba', compute)).toEqual({ value: { n: 1 }, hit: true })
    expect(calls).toBe(1)
  })
})
