/**
 * Replays an extraction from the hash-keyed response cache, calling no model: this is what CI
 * runs. If a response is missing from the cache, the extraction isn't scored (it would be a
 * partial output measuring the cache, not the model) and is reported as `cache_miss` with the
 * command that fills it.
 */
import { join, resolve } from 'node:path'
import type { StatementExtraction } from '@gow/contracts'
import { DEFAULT_OPTIONS, extractStatement } from '@gow/extraction'
import { CachingStructuredLlm, createLimiter, loadRootEnv, MastraStructuredLlm, readAnthropicEnv, ZERO_USAGE, type Classification, type Classifier, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'

export const REPO = resolve(import.meta.dirname, '../..')
export const DEV_DIR = join(REPO, 'data/dev')
export const GT_DIR = process.env.GROUND_TRUTH_DIR ?? join(REPO, 'data/ground-truth')
export const CACHE_DIR = process.env.LLM_CACHE_DIR ?? join(REPO, 'data/llm-cache')
export const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? join(REPO, 'data/eval-results')

/** Counts the responses that weren't in the cache. */
class MissRecorder implements StructuredLlm {
  readonly misses: string[] = []
  readonly #inner: StructuredLlm
  constructor(inner: StructuredLlm) {
    this.#inner = inner
  }
  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      return await this.#inner.call(req)
    } catch (err) {
      this.misses.push(`${req.purpose}:${req.model}`)
      throw err
    }
  }
}

/**
 * Classification labels and doesn't change movements; in replay it is pinned so Jev, which skips
 * the cache, isn't needed. Comparing classifiers is a separate eval (`classifier.eval.ts`).
 */
const replayClassifier: Classifier = {
  classify: (): Promise<Classification> =>
    Promise.resolve({ documentType: 'bank_statement', confidence: 1, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'replay', fallback: false, usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, promptId: null, responseCacheHit: true }),
}

export type ReplayResult = { status: 'ok'; doc: StatementExtraction } | { status: 'cache_miss'; misses: string[] }

/**
 * `live: true` calls the model for whatever is missing and stores the responses (paid run;
 * manual only, never in CI). Without `live`, cache only.
 */
export async function replayExtraction(pdfPath: string, model: string, opts: { cacheDir?: string; classifier?: Classifier; live?: boolean } = {}): Promise<ReplayResult> {
  let inner: StructuredLlm | null = null
  if (opts.live) {
    loadRootEnv()
    inner = new MastraStructuredLlm(readAnthropicEnv())
  }
  const recorder = new MissRecorder(new CachingStructuredLlm(inner, opts.cacheDir ?? CACHE_DIR, opts.live ? 'readwrite' : 'read'))
  const doc = await extractStatement(pdfPath, { llm: recorder, classifier: opts.classifier ?? replayClassifier }, { ...DEFAULT_OPTIONS, extractionModel: model, googleAvailable: true, limit: createLimiter(4) })
  if (recorder.misses.length > 0) return { status: 'cache_miss', misses: [...new Set(recorder.misses)] }
  return { status: 'ok', doc }
}
