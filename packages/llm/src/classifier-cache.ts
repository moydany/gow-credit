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
    return createHash('sha256').update(JSON.stringify({ v: 1, label: this.#label, text: input.textSample, pdf: input.pdf.sha256 })).digest('hex')
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const key = this.#key(input)
    const path = join(this.#dir, `${this.#label}-${key.slice(0, 32)}.json`)
    if (existsSync(path)) return { ...(JSON.parse(readFileSync(path, 'utf8')) as Classification), responseCacheHit: true }
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
