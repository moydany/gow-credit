import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createLimiter } from './limit.ts'
import { boundText, JsonlLlmExchangeSink, RecordingStructuredLlm, withLlmScope, type LlmExchange, type LlmExchangeSink, type LlmScope } from './recording.ts'
import { LlmCallError, type StructuredLlm, type StructuredRequest } from './structured.ts'

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 }

function request(over: Partial<StructuredRequest<{ ok: boolean }>> = {}): StructuredRequest<{ ok: boolean }> {
  return {
    purpose: 'summary',
    model: 'claude-haiku-5-5',
    system: 'Eres un extractor.',
    document: { base64: 'JVBERi0=', sha256: 'a'.repeat(64), cache: true },
    instruction: 'Lee la portada.',
    schema: z.object({ ok: z.boolean() }),
    schemaName: 'summary.v1',
    promptVersion: 'summary.v3',
    effort: 'low',
    maxOutputTokens: 1000,
    serverFallback: false,
    ...over,
  }
}

class MemorySink implements LlmExchangeSink {
  readonly rows: { e: LlmExchange; scope: LlmScope }[] = []
  record(e: LlmExchange, scope: LlmScope): Promise<void> {
    this.rows.push({ e, scope })
    return Promise.resolve()
  }
}

const ok: StructuredLlm = {
  call: (req) => Promise.resolve({ object: req.schema.parse({ ok: true }), usage, costUsd: 0.0012, latencyMs: 840, model: 'claude-haiku-5-5', finishReason: 'stop', responseCacheHit: false }),
}

describe('RecordingStructuredLlm', () => {
  it('guarda el intercambio tal cual, sin el PDF, y devuelve el resultado sin tocarlo', async () => {
    const sink = new MemorySink()
    const llm = new RecordingStructuredLlm(ok, sink)
    const res = await withLlmScope({ tenantId: 't1', applicationId: 'a1' }, () => llm.call(request()))
    expect(res.object).toEqual({ ok: true })
    expect(sink.rows).toHaveLength(1)
    const [{ e, scope }] = sink.rows as [{ e: LlmExchange; scope: LlmScope }]
    expect(scope).toEqual({ tenantId: 't1', applicationId: 'a1' })
    expect(e).toMatchObject({ purpose: 'summary', system: 'Eres un extractor.', instruction: 'Lee la portada.', documentSha256: 'a'.repeat(64), outcome: 'ok', response: { ok: true }, usage, costUsd: 0.0012, latencyMs: 840, finishReason: 'stop', errorCode: null })
    expect(JSON.stringify(e)).not.toContain('JVBERi0=')
  })

  it('un error queda con su código y la salida cruda, y se vuelve a lanzar', async () => {
    const sink = new MemorySink()
    const failing: StructuredLlm = { call: () => Promise.reject(new LlmCallError('max_tokens', 'la respuesta se cortó', { rawOutput: '{"transactions":[{"amount":12' })) }
    const llm = new RecordingStructuredLlm(failing, sink)
    await expect(withLlmScope({ tenantId: 't1' }, () => llm.call(request()))).rejects.toThrow('la respuesta se cortó')
    expect(sink.rows[0]?.e).toMatchObject({ outcome: 'error', errorCode: 'max_tokens', errorMessage: 'la respuesta se cortó', rawOutput: '{"transactions":[{"amount":12', response: null, usage: null })
  })

  it('el ámbito llega a llamadas en paralelo que pasan por el limitador', async () => {
    const sink = new MemorySink()
    const slow: StructuredLlm = { call: async (req) => { await new Promise((r) => setTimeout(r, 5)); return ok.call(req) } }
    const llm = new RecordingStructuredLlm(slow, sink)
    const limit = createLimiter(1)
    await Promise.all([
      withLlmScope({ tenantId: 't1', applicationId: 'a1' }, () => Promise.all([limit(() => llm.call(request())), limit(() => llm.call(request()))])),
      withLlmScope({ tenantId: 't1', applicationId: 'a2' }, () => limit(() => llm.call(request()))),
    ])
    expect(sink.rows.map((r) => r.scope.applicationId).sort()).toEqual(['a1', 'a1', 'a2'])
  })

  it('si guardar falla, la llamada sigue y solo se avisa el tipo de error', async () => {
    const messages: string[] = []
    const broken: LlmExchangeSink = { record: () => Promise.reject(new TypeError('valor con datos del documento')) }
    const llm = new RecordingStructuredLlm(ok, broken, { onError: (m) => messages.push(m) })
    await expect(llm.call(request())).resolves.toMatchObject({ object: { ok: true } })
    expect(messages).toEqual(['no se guardó el intercambio con el modelo (summary): TypeError'])
  })

  it('el destino de standalone deja una línea JSON por intercambio en <solicitud>.llm.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gow-llm-'))
    const sink = new JsonlLlmExchangeSink(dir)
    const llm = new RecordingStructuredLlm(ok, sink)
    await withLlmScope({ applicationId: 'estado-01' }, async () => {
      await llm.call(request())
      await llm.call(request({ purpose: 'double_read' }))
    })
    const lines = readFileSync(sink.pathFor('estado-01'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { application_id: string; purpose: string })
    expect(lines.map((l) => [l.application_id, l.purpose])).toEqual([['estado-01', 'summary'], ['estado-01', 'double_read']])
  })

  it('recorta textos enormes y dice cuánto quitó', () => {
    expect(boundText('abcdef', 4)).toBe('abcd\n…[recortado: 2 caracteres más]')
    expect(boundText(null)).toBeNull()
  })
})
