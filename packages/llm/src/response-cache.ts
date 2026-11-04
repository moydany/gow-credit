/**
 * Caché de respuestas por hash de la entrada (docs/07 E). Con la misma entrada (modelo,
 * prompt, esquema, documento, instrucción, effort) devuelve la respuesta guardada sin llamar
 * al modelo: corridas repetibles sobre los documentos de desarrollo y CI sin llamadas.
 *
 * Las respuestas contienen datos del documento, así que el directorio por defecto vive en
 * data/ (ignorado por git). Si se versiona para CI se decide junto con el ground truth.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TokenUsage } from '@gow/contracts'
import { z } from 'zod'
import type { StructuredLlm, StructuredRequest, StructuredResult } from './structured.ts'

export type CacheMode = 'off' | 'read' | 'readwrite'

interface Entry {
  key: string
  model: string
  purpose: string
  object: unknown
  usage: TokenUsage
  original_cost_usd: number
  finish_reason: string
  created_at: string
}

export function requestKey(req: StructuredRequest<unknown>): string {
  const schemaJson = JSON.stringify(z.toJSONSchema(req.schema, { unrepresentable: 'any' }))
  const material = JSON.stringify({
    v: 1,
    model: req.model,
    system: req.system,
    document: req.document?.sha256 ?? null,
    instruction: req.instruction,
    schemaName: req.schemaName,
    schema: schemaJson,
    promptVersion: req.promptVersion,
    effort: req.effort,
    maxOutputTokens: req.maxOutputTokens,
  })
  return createHash('sha256').update(material).digest('hex')
}

export class CachingStructuredLlm implements StructuredLlm {
  readonly #inner: StructuredLlm | null
  readonly #dir: string
  readonly #mode: CacheMode

  /** `inner` puede ser null: modo solo-caché (CI sin llave); un miss falla. */
  constructor(inner: StructuredLlm | null, dir: string, mode: CacheMode) {
    this.#inner = inner
    this.#dir = dir
    this.#mode = mode
    if (mode === 'readwrite') mkdirSync(dir, { recursive: true })
  }

  #path(key: string): string {
    return join(this.#dir, key.slice(0, 2), `${key}.json`)
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const key = this.#mode === 'off' ? '' : requestKey(req)
    if (this.#mode !== 'off') {
      const path = this.#path(key)
      if (existsSync(path)) {
        const entry = JSON.parse(readFileSync(path, 'utf8')) as Entry
        const parsed = req.schema.safeParse(entry.object)
        if (parsed.success) {
          return { object: parsed.data, usage: entry.usage, costUsd: 0, latencyMs: 0, model: entry.model, finishReason: entry.finish_reason, responseCacheHit: true }
        }
      }
    }
    if (!this.#inner) throw new Error(`respuesta no está en caché (${req.purpose}) y no hay cliente de modelo`)
    const res = await this.#inner.call(req)
    if (this.#mode === 'readwrite') {
      const path = this.#path(key)
      mkdirSync(join(this.#dir, key.slice(0, 2)), { recursive: true })
      const entry: Entry = { key, model: res.model, purpose: req.purpose, object: res.object, usage: res.usage, original_cost_usd: res.costUsd, finish_reason: res.finishReason, created_at: new Date().toISOString() }
      // Escritura atómica: un proceso interrumpido no deja una entrada a medias.
      writeFileSync(`${path}.tmp`, JSON.stringify(entry))
      renameSync(`${path}.tmp`, path)
    }
    return res
  }
}
