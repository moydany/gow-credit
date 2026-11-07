/**
 * Caché de clasificaciones de documento por hash de la entrada (Jev no pasa por la caché de
 * respuestas estructuradas). La usan la eval que compara Jev contra Haiku y `pnpm run evaluate`,
 * con la misma llave: lo que clasificó una, la otra lo reproduce sin costo. Los documentos reales
 * van a data/llm-cache/classifier (no se versiona); los adversarios sintéticos a evals/fixtures.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Classification, Classifier, ClassifierInput } from './classifier.ts'
import { promptCacheTag } from './prompts.ts'

export class CachedClassifier implements Classifier {
  readonly #inner: Classifier | null
  readonly #dir: string
  readonly #label: string
  misses = 0
  constructor(label: string, inner: Classifier | null, dir: string) {
    this.#label = label
    this.#inner = inner
    this.#dir = dir
  }

  #key(input: ClassifierInput): string {
    // Con un prompt de clasificación distinto al del código (activado en el backoffice, ADR 0065), su id
    // entra en la llave: la clasificación guardada con otro prompt no se reutiliza. Sin él, la llave de siempre.
    const prompt = promptCacheTag('classify_document')
    return createHash('sha256').update(JSON.stringify({ v: 1, label: this.#label, text: input.textSample, pdf: input.pdf.sha256, ...(prompt ? { prompt } : {}) })).digest('hex')
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const key = this.#key(input)
    const path = join(this.#dir, `${this.#label}-${key.slice(0, 32)}.json`)
    // De caché no cuesta: costUsd 0 y latencia 0 (el uso de tokens queda, para estimar a precio de lista).
    if (existsSync(path)) return { ...(JSON.parse(readFileSync(path, 'utf8')) as Classification), costUsd: 0, latencyMs: 0, responseCacheHit: true }
    if (!this.#inner) {
      this.misses++
      throw new Error(`clasificación de ${this.#label} no está en caché`)
    }
    const res = await this.#inner.classify(input)
    mkdirSync(this.#dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(res, null, 2)}\n`)
    return res
  }
}
