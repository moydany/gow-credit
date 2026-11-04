/**
 * Eval de extracción contra ground truth (fase 3, docs/04 §6). Cada modelo se reproduce desde
 * la caché de respuestas: CI no llama a ningún modelo. Llenar la caché de un modelo nuevo es
 * una corrida pagada aparte: `pnpm extract data/dev --model <modelo>`.
 *
 * EVAL_MODELS (coma) elige los modelos; por defecto Gemini y Opus, los que tienen caché de los
 * 9 documentos. Sonnet y Haiku se agregan con EVAL_MODELS tras llenar su caché.
 * Los puntajes por documento quedan en data/eval-results/; `src/gate.ts` aplica los umbrales
 * por banco y escribe el reporte.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GEMINI_FLASH, OPUS_MODEL } from '@gow/llm'
import { evalite } from 'evalite'
import { GroundTruth } from './src/ground-truth/schema.ts'
import { scoreDocument, type DocumentScore } from './src/metrics.ts'
import { DEV_DIR, GT_DIR, replayExtraction, RESULTS_DIR } from './src/replay.ts'
import { writeResult } from './src/results.ts'

const DOCS = [
  'EDC_01_Inbursa_2025-01.pdf',
  'EDC_02_Hey_2025-04.pdf',
  'EDC_03_Fondeadora_2025-10.pdf',
  'EDC_04_Banamex_2026-02.pdf',
  'EDC_05_BBVA_2025-09.pdf',
  'EDC_06_MercadoPago_2026-06a09.pdf',
  'EDC_07_Santander_2025-04.pdf',
  'EDC_08_Nu_2025-07.pdf',
  'EDC_09_HSBC_2026-03.pdf',
]
const MODELS = (process.env.EVAL_MODELS ?? [GEMINI_FLASH, OPUS_MODEL].join(',')).split(',').map((m) => m.trim()).filter(Boolean)

const computed = new Map<string, DocumentScore>()
const keyOf = (i: { model: string; file: string }) => `${i.model}|${i.file}`

interface Input {
  model: string
  file: string
  bank: string
}

async function scored(model: string): Promise<{ input: Input; expected: DocumentScore }[]> {
  rmSync(join(RESULTS_DIR, 'extraction', model.replace(/[^a-z0-9.-]/gi, '_')), { recursive: true, force: true })
  const out: { input: Input; expected: DocumentScore }[] = []
  for (const file of DOCS) {
    const gtPath = join(GT_DIR, file.replace(/\.pdf$/, '.json'))
    if (!existsSync(gtPath) || !existsSync(join(DEV_DIR, file))) continue
    const gt = GroundTruth.parse(JSON.parse(readFileSync(gtPath, 'utf8')))
    if (!gt.gated) continue
    const r = await replayExtraction(join(DEV_DIR, file), model)
    if (r.status === 'cache_miss') {
      writeResult({ model, file, bank: gt.bank, status: 'cache_miss', misses: r.misses })
      continue
    }
    const score = scoreDocument(r.doc, gt)
    writeResult({ model, file, bank: gt.bank, status: 'ok', score })
    computed.set(keyOf({ model, file }), score)
    out.push({ input: { model, file, bank: gt.bank }, expected: score })
  }
  return out
}

const s = (name: string, f: (x: DocumentScore) => number) => ({ name, scorer: ({ output }: { output: DocumentScore }) => f(output) })

for (const model of MODELS) {
  evalite<Input, DocumentScore, DocumentScore>(`extracción · ${model}`, {
    data: () => scored(model),
    // El trabajo (replay y puntaje) se hace en `data`, una vez por documento; la tarea lo entrega.
    task: (input) => {
      const score = computed.get(keyOf(input))
      if (!score) throw new Error(`sin puntaje para ${input.file}`)
      return score
    },
    scorers: [
      s('precisión (no inventa filas)', (x) => x.precision),
      s('recall (no omite filas)', (x) => x.recall),
      s('monto', (x) => x.row_fields.amount),
      s('fecha', (x) => x.row_fields.date),
      s('sentido', (x) => x.row_fields.type),
      s('saldo', (x) => x.row_fields.balance),
      s('descripción (difusa)', (x) => x.row_fields.description),
      s('encabezado por campo', (x) => (x.header.total === 0 ? 1 : x.header.ok / x.header.total)),
      s('CFDI por campo', (x) => (x.fiscal.total === 0 ? 1 : x.fiscal.ok / x.fiscal.total)),
      s('cuadre a la primera', (x) => (x.reconciled_first_pass ? 1 : 0)),
    ],
    columns: ({ input, output }) => [
      { label: 'banco', value: input.bank },
      { label: 'filas', value: `${String(output.ex_transactions)}/${String(output.gt_transactions)}` },
      { label: 'inventadas', value: output.invented },
      { label: 'omitidas', value: output.omitted },
      { label: 'USD', value: output.cost_usd.toFixed(3) },
    ],
  })
}
