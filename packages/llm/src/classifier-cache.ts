/**
 * Cache of document classifications keyed by input hash (Jev does not go through the structured
 * response cache). Used by the eval comparing Jev with Haiku and by `pnpm run evaluate`, with the
 * same key: what one classified, the other replays at no cost. Real documents go to
 * data/llm-cache/classifier (not versioned); synthetic adversarial ones to evals/fixtures.
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
    // With a classification prompt different from the code's (activated in the backoffice), its id
     // goes in the key so a classification stored under another prompt is not reused. Otherwise the usual key.
    const prompt = promptCacheTag('classify_document')
    return createHash('sha256').update(JSON.stringify({ v: 1, label: this.#label, text: input.textSample, pdf: input.pdf.sha256, ...(prompt ? { prompt } : {}) })).digest('hex')
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const key = this.#key(input)
    const path = join(this.#dir, `${this.#label}-${key.slice(0, 32)}.json`)
    // From cache it costs nothing: costUsd 0 and latency 0 (token usage stays, to estimate at list price).
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
