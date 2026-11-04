/**
 * Reproduce una extracción desde la caché de respuestas por hash (docs/07 E), sin llamar a
 * ningún modelo: es lo que corre en CI. Si falta una respuesta en la caché, la extracción no
 * se puntúa (sería una salida parcial que mide la caché, no el modelo) y se reporta como
 * `cache_miss` con el comando que la llena.
 */
import { join, resolve } from 'node:path'
import type { StatementExtraction } from '@gow/contracts'
import { DEFAULT_OPTIONS, extractStatement } from '@gow/extraction'
import { CachingStructuredLlm, createLimiter, ZERO_USAGE, type Classification, type Classifier, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'

export const REPO = resolve(import.meta.dirname, '../..')
export const DEV_DIR = join(REPO, 'data/dev')
export const GT_DIR = process.env.GROUND_TRUTH_DIR ?? join(REPO, 'data/ground-truth')
export const CACHE_DIR = process.env.LLM_CACHE_DIR ?? join(REPO, 'data/llm-cache')
export const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? join(REPO, 'data/eval-results')

/** Cuenta las respuestas que no estaban en la caché. */
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
 * La clasificación etiqueta y no cambia los movimientos (ADR 0002); en el replay se fija para
 * que Jev, que no pasa por la caché, no haga falta. La comparación de clasificadores es otra
 * eval (`classifier.eval.ts`).
 */
const replayClassifier: Classifier = {
  classify: (): Promise<Classification> =>
    Promise.resolve({ documentType: 'bank_statement', confidence: 1, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'replay', fallback: false, usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, promptId: null, responseCacheHit: true }),
}

export type ReplayResult = { status: 'ok'; doc: StatementExtraction } | { status: 'cache_miss'; misses: string[] }

export async function replayExtraction(pdfPath: string, model: string, opts: { cacheDir?: string; classifier?: Classifier } = {}): Promise<ReplayResult> {
  const recorder = new MissRecorder(new CachingStructuredLlm(null, opts.cacheDir ?? CACHE_DIR, 'read'))
  const doc = await extractStatement(pdfPath, { llm: recorder, classifier: opts.classifier ?? replayClassifier }, { ...DEFAULT_OPTIONS, extractionModel: model, googleAvailable: true, limit: createLimiter(4) })
  if (recorder.misses.length > 0) return { status: 'cache_miss', misses: [...new Set(recorder.misses)] }
  return { status: 'ok', doc }
}
