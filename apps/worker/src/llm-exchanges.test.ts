/**
 * Grabación de intercambios con el modelo en Postgres (ADR 0064), con el rol del worker: inserta en
 * el tenant del ámbito, no puede leer lo que guardó, limpia lo que Postgres no acepta y, sin tenant,
 * no guarda nada. Necesita el Postgres de docker compose; sin él se salta.
 */
import { randomUUID } from 'node:crypto'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { LlmCallError, RecordingStructuredLlm, withLlmScope, type StructuredLlm, type StructuredRequest } from '@gow/llm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DbLlmExchangeSink } from './llm-exchanges.ts'

const available = await postgresAvailable()

const req: StructuredRequest<{ name: string }> = {
  purpose: 'extraction.summary',
  model: 'gemini-3.8-flash',
  system: 'Extrae la portada.',
  document: { base64: 'JVBERi0=', sha256: 'b'.repeat(64), cache: true },
  instruction: 'Páginas 1-2.',
  schema: z.object({ name: z.string() }),
  schemaName: 'summary.v1',
  promptVersion: 'summary.v3',
  effort: 'medium',
  maxOutputTokens: 4000,
  serverFallback: false,
}

describe.skipIf(!available)('intercambios con el modelo en Postgres (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  const tenant = randomUUID()
  const supplier = randomUUID()
  const application = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))
    await admin.query("INSERT INTO app.tenants (id, name) VALUES ($1, 'Fintech Demo')", [tenant])
    await admin.query("INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, 'Proveedor')", [supplier, tenant])
    await admin.query('INSERT INTO app.applications (id, tenant_id, supplier_id) VALUES ($1, $2, $3)', [application, tenant, supplier])
  }, 60_000)

  afterAll(async () => {
    await admin.end()
    await worker.close()
    await tdb.drop()
  })

  it('cada llamada, bien o mal, queda en la solicitud del ámbito; sin tenant no se guarda', async () => {
    const answers: StructuredLlm = {
      call: (r) => Promise.resolve({ object: r.schema.parse({ name: 'Distribuidora\u0000 Ficticia' }), usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0.0004, latencyMs: 1500, model: 'gemini-3.8-flash', finishReason: 'stop', responseCacheHit: false }),
    }
    const fails: StructuredLlm = { call: () => Promise.reject(new LlmCallError('invalid_output', 'la salida no valida contra el esquema', { rawOutput: '{"nombre": 3}' })) }
    const sink = new DbLlmExchangeSink(worker.db)
    const errors: string[] = []
    const good = new RecordingStructuredLlm(answers, sink, { onError: (m) => errors.push(m) })
    const bad = new RecordingStructuredLlm(fails, sink, { onError: (m) => errors.push(m) })

    await withLlmScope({ tenantId: tenant, applicationId: application }, async () => {
      await good.call(req)
      await expect(bad.call(req)).rejects.toThrow(LlmCallError)
    })
    await good.call(req)
    expect(errors).toEqual([])

    const rows = await admin.query('SELECT application_id, purpose, outcome, system, instruction, document_sha256, response, raw_output, error_code, usage, cost_usd, latency_ms FROM app.llm_exchanges WHERE tenant_id = $1 ORDER BY outcome DESC', [tenant])
    expect(rows.rows).toEqual([
      { application_id: application, purpose: 'extraction.summary', outcome: 'ok', system: 'Extrae la portada.', instruction: 'Páginas 1-2.', document_sha256: 'b'.repeat(64), response: { name: 'Distribuidora Ficticia' }, raw_output: null, error_code: null, usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, cost_usd: '0.000400', latency_ms: 1500 },
      { application_id: application, purpose: 'extraction.summary', outcome: 'error', system: 'Extrae la portada.', instruction: 'Páginas 1-2.', document_sha256: 'b'.repeat(64), response: null, raw_output: '{"nombre": 3}', error_code: 'invalid_output', usage: null, cost_usd: '0.000000', latency_ms: expect.any(Number) as number },
    ])
  })

  it('el worker inserta pero no lee los intercambios', async () => {
    const c = new pg.Client({ connectionString: tdb.url('worker') })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
      await expect(c.query('SELECT id FROM app.llm_exchanges')).rejects.toThrow(/permission denied/)
    } finally {
      await c.query('ROLLBACK')
      await c.end()
    }
  })
})
