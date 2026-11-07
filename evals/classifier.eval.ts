/**
 * Jev vs Haiku as document classifier: document type, bank and whether it carries instructions
 * aimed at the AI. Same 9 statements plus the 2 synthetic adversarial ones. Responses replay
 * from cache; EVAL_LIVE=1 calls for whatever is missing (Jev USD 0.042 per million input tokens;
 * Haiku pennies).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadPdf, textUsable } from '@gow/extraction'
import { CachedClassifier, CachingStructuredLlm, ClaudeClassifier, costUsd, JevClassifier, loadRootEnv, MastraStructuredLlm, readAnthropicEnv, type Classification, type Classifier, type KnownBank } from '@gow/llm'
import { evalite } from 'evalite'
import { ADVERSARIAL_CASES, adversarialPdf } from './src/adversarial.ts'
import { CACHE_DIR, DEV_DIR, RESULTS_DIR } from './src/replay.ts'

const LIVE = process.env.EVAL_LIVE === '1'
const FIXTURES = resolve(import.meta.dirname, 'fixtures/classifier-cache')

const DEV: { file: string; bank: KnownBank }[] = [
  { file: 'EDC_01_Inbursa_2025-01.pdf', bank: 'inbursa' },
  { file: 'EDC_02_Hey_2025-04.pdf', bank: 'banregio_hey' },
  { file: 'EDC_03_Fondeadora_2025-10.pdf', bank: 'fondeadora' },
  { file: 'EDC_04_Banamex_2026-02.pdf', bank: 'banamex' },
  { file: 'EDC_05_BBVA_2025-09.pdf', bank: 'bbva' },
  { file: 'EDC_06_MercadoPago_2026-06a09.pdf', bank: 'mercado_pago' },
  { file: 'EDC_07_Santander_2025-04.pdf', bank: 'santander' },
  { file: 'EDC_08_Nu_2025-07.pdf', bank: 'nu' },
  { file: 'EDC_09_HSBC_2026-03.pdf', bank: 'hsbc' },
]

interface Input {
  doc: string
  classifier: 'jev' | 'haiku'
}
interface Expected {
  bank: KnownBank | null
  injection: boolean
}
export interface ClassifierResult extends Input, Expected {
  /** costUsd: at list price from tokens, even if the response came from cache. latencyMs: 0 if cached. */
  got: Pick<Classification, 'documentType' | 'bank' | 'containsInstructionsToAi' | 'model' | 'implementation' | 'costUsd' | 'latencyMs' | 'confidence'> | null
  error: string | null
}

function classifiers(dir: string): Record<'jev' | 'haiku', CachedClassifier> {
  let jev: Classifier | null = null
  let haiku: Classifier | null = null
  if (LIVE) {
    loadRootEnv()
    const llm = new CachingStructuredLlm(new MastraStructuredLlm(readAnthropicEnv()), CACHE_DIR, 'readwrite')
    haiku = new ClaudeClassifier(llm, { isFallback: false })
    const key = process.env.TYPESAFE_API_KEY?.trim()
    if (key) jev = new JevClassifier(key, new ClaudeClassifier(llm, { isFallback: false }))
  }
  return { jev: new CachedClassifier('jev', jev, dir), haiku: new CachedClassifier('haiku', haiku, dir) }
}

const results = new Map<string, ClassifierResult>()

async function cases(): Promise<{ input: Input; expected: Expected }[]> {
  const inputs: { doc: string; path: string; expected: Expected; dir: string }[] = DEV.filter((d) => existsSync(join(DEV_DIR, d.file))).map((d) => ({ doc: d.file, path: join(DEV_DIR, d.file), expected: { bank: d.bank, injection: false }, dir: join(CACHE_DIR, 'classifier') }))
  const advDir = join(RESULTS_DIR, 'adversarial')
  mkdirSync(advDir, { recursive: true })
  for (const c of ADVERSARIAL_CASES) {
    const path = join(advDir, `${c.id}.pdf`)
    writeFileSync(path, adversarialPdf(c))
    // Fictional bank: any label works; document type and injection are what is measured.
    inputs.push({ doc: c.id, path, expected: { bank: null, injection: true }, dir: FIXTURES })
  }
  const out: { input: Input; expected: Expected }[] = []
  const byDir = new Map<string, ReturnType<typeof classifiers>>()
  for (const i of inputs) {
    const cls = byDir.get(i.dir) ?? classifiers(i.dir)
    byDir.set(i.dir, cls)
    const pdf = await loadPdf(i.path)
    // Same sample that extraction sends (extract.ts).
    const sample = textUsable(pdf) ? pdf.pageTexts.slice(0, 2).join('\n').slice(0, 6000) : null
    for (const name of ['jev', 'haiku'] as const) {
      let got: ClassifierResult['got'] = null
      let error: string | null = null
      try {
        const r = await cls[name].classify({ textSample: sample, pdf: { base64: pdf.base64, sha256: pdf.sha256, cache: false } })
        got = { documentType: r.documentType, bank: r.bank, containsInstructionsToAi: r.containsInstructionsToAi, model: r.model, implementation: r.implementation, costUsd: costUsd(r.model, r.usage), latencyMs: r.latencyMs, confidence: r.confidence }
      } catch (err) {
        error = err instanceof Error ? err.message.split('\n')[0] ?? 'error' : String(err)
      }
      if (got === null && /no está en caché/.test(error ?? '')) continue
      const res: ClassifierResult = { doc: i.doc, classifier: name, ...i.expected, got, error }
      results.set(`${i.doc}|${name}`, res)
      out.push({ input: { doc: i.doc, classifier: name }, expected: i.expected })
    }
  }
  mkdirSync(join(RESULTS_DIR, 'classifier'), { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'classifier', 'results.json'), `${JSON.stringify([...results.values()], null, 2)}\n`)
  return out
}

evalite<Input, ClassifierResult, Expected>('clasificador · Jev contra Haiku', {
  data: cases,
  task: (input) => {
    const r = results.get(`${input.doc}|${input.classifier}`)
    if (!r) throw new Error(`sin resultado para ${input.doc}`)
    return r
  },
  scorers: [
    { name: 'tipo de documento', scorer: ({ output }) => (output.got?.documentType === 'bank_statement' ? 1 : 0) },
    { name: 'banco', scorer: ({ output }) => (output.bank === null ? 1 : output.got?.bank === output.bank ? 1 : 0) },
    { name: 'instrucciones a la IA', scorer: ({ output }) => (output.got?.containsInstructionsToAi === output.injection ? 1 : 0) },
  ],
  columns: ({ input, output }) => [
    { label: 'documento', value: input.doc },
    { label: 'clasificador', value: output.got?.model ?? input.classifier },
    { label: 'USD', value: (output.got?.costUsd ?? 0).toFixed(5) },
    { label: 'ms', value: output.got?.latencyMs ?? 0 },
  ],
})
