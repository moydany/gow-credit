/* eslint-disable no-console -- CLI: conteos, nombres de archivo y referencias de fila; los valores solo van a data/ */
/**
 * Muestra del ground truth revisada por una persona (ADR 0001, procedencia `human_review`).
 *
 *   pnpm -F @gow/evals gt:review sample [--per-doc 8] [--seed 20261105]
 *   pnpm -F @gow/evals gt:review record [--reviewer <iniciales>]
 *
 * `sample` elige filas por documento (al menos una por página con movimientos, el resto al azar
 * con semilla fija) y escribe en `data/ground-truth/review/` una hoja por documento (`<doc>.md`,
 * con fecha, concepto, monto, sentido y saldo para cotejar contra el PDF) y `review.json`, donde
 * quien revisa marca cada fila `ok: true` o `false`. Esos archivos traen datos del documento y no
 * se versionan.
 *
 * `record` exige todas las filas marcadas y escribe `evals/ground-truth/human-review.json`, que sí
 * se versiona: por documento, el hash del ground truth revisado, cuántas filas, cuántas bien, las
 * referencias de las que no (cuenta, periodo, índice y página; nunca valores), iniciales y fecha.
 * Sale con 1 si alguna fila está mal: el ground truth se corrige antes de seguir midiendo.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { GT_DIR, REPO } from '../replay.ts'
import { GroundTruth, GT_VERSION, type GtTransaction } from './schema.ts'

const REVIEW_DIR = join(GT_DIR, 'review')
const RECORD_PATH = join(REPO, 'evals/ground-truth/human-review.json')

export interface SampledRow {
  ref: string
  page: number
  tx: GtTransaction
}

/** PRNG con semilla (mulberry32): la misma semilla da la misma muestra. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Una fila por página primero (en orden de página) y luego al azar hasta `perDoc`. */
export function sampleRows(gt: GroundTruth, perDoc: number, seed: number): SampledRow[] {
  const all: SampledRow[] = gt.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions.map((tx, i) => ({ ref: `${p.key.startsWith(a.key) ? p.key : `${a.key}.${p.key}`}.${String(i)}`, page: tx.page, tx }))))
  const rand = prng(seed ^ parseInt(gt.sha256.slice(0, 8), 16))
  const shuffled = all.map((r) => ({ r, k: rand() })).sort((x, y) => x.k - y.k).map((x) => x.r)
  const picked = new Map<string, SampledRow>()
  for (const page of [...new Set(all.map((r) => r.page))].sort((x, y) => x - y)) {
    const first = shuffled.find((r) => r.page === page)
    if (first && picked.size < perDoc) picked.set(first.ref, first)
  }
  for (const r of shuffled) {
    if (picked.size >= perDoc) break
    picked.set(r.ref, r)
  }
  return [...picked.values()].sort((x, y) => x.page - y.page || x.ref.localeCompare(y.ref, 'en', { numeric: true }))
}

const ReviewFile = z.strictObject({
  version: z.literal(1),
  seed: z.int(),
  per_doc: z.int().min(1),
  documents: z.array(z.strictObject({
    file: z.string(),
    sha256: z.string(),
    gt_sha256: z.string(),
    rows: z.array(z.strictObject({ ref: z.string(), page: z.int().min(1), ok: z.boolean().nullable() })),
  })),
})

export const HumanReviewRecord = z.strictObject({
  version: z.literal(1),
  gt_version: z.string(),
  seed: z.int(),
  per_doc: z.int(),
  reviewer: z.string().max(10).describe('Iniciales, no el nombre'),
  reviewed_at: z.iso.date(),
  documents: z.array(z.strictObject({ file: z.string(), sha256: z.string(), gt_sha256: z.string(), sampled: z.int(), ok: z.int(), wrong: z.array(z.strictObject({ ref: z.string(), page: z.int() })) })),
})

const money = (n: number | null) => (n === null ? '—' : n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ')

function sample(perDoc: number, seed: number): void {
  const files = readdirSync(GT_DIR).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`no hay ground truth en ${GT_DIR}`)
  mkdirSync(REVIEW_DIR, { recursive: true })
  const docs: z.infer<typeof ReviewFile>['documents'] = []
  for (const f of files) {
    const raw = readFileSync(join(GT_DIR, f))
    const gt = GroundTruth.parse(JSON.parse(raw.toString('utf8')))
    const rows = sampleRows(gt, perDoc, seed)
    docs.push({ file: gt.file_name, sha256: gt.sha256, gt_sha256: createHash('sha256').update(raw).digest('hex'), rows: rows.map((r) => ({ ref: r.ref, page: r.page, ok: null })) })
    const md = [
      `# Revisión: ${gt.file_name}`,
      '',
      'Abre el PDF en cada página y compara la fila completa. En review.json marca `ok: true` si fecha, concepto (primera línea), monto, sentido y saldo coinciden con lo impreso; `false` si algo no.',
      '',
      '| Ref | Pág. | Fecha | Concepto (primera línea) | Monto | Sentido | Saldo |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.ref} | ${String(r.page)} | ${r.tx.date} | ${cell(r.tx.description_head)} | ${money(r.tx.amount)} | ${r.tx.type === 'credit' ? 'abono' : 'cargo'} | ${money(r.tx.balance)} |`),
      '',
    ].join('\n')
    writeFileSync(join(REVIEW_DIR, f.replace(/\.json$/, '.md')), md)
  }
  writeFileSync(join(REVIEW_DIR, 'review.json'), `${JSON.stringify({ version: 1, seed, per_doc: perDoc, documents: docs }, null, 2)}\n`)
  console.log(`${String(docs.length)} documento(s), ${String(docs.reduce((n, d) => n + d.rows.length, 0))} fila(s) para revisar en ${REVIEW_DIR}`)
}

function record(reviewer: string): void {
  const path = join(REVIEW_DIR, 'review.json')
  if (!existsSync(path)) throw new Error('falta review.json: corre primero gt:review sample')
  const review = ReviewFile.parse(JSON.parse(readFileSync(path, 'utf8')))
  const missing = review.documents.flatMap((d) => d.rows.filter((r) => r.ok === null).map((r) => `${d.file} ${r.ref}`))
  if (missing.length > 0) {
    console.error(`Faltan ${String(missing.length)} fila(s) por marcar, por ejemplo: ${missing.slice(0, 3).join('; ')}`)
    process.exit(65)
  }
  // El ground truth no debe haber cambiado entre la muestra y el registro.
  for (const d of review.documents) {
    const now = createHash('sha256').update(readFileSync(join(GT_DIR, d.file.replace(/\.pdf$/i, '.json')))).digest('hex')
    if (now !== d.gt_sha256) throw new Error(`el ground truth de ${d.file} cambió desde la muestra; vuelve a correr sample`)
  }
  const out = HumanReviewRecord.parse({
    version: 1,
    gt_version: GT_VERSION,
    seed: review.seed,
    per_doc: review.per_doc,
    reviewer,
    reviewed_at: new Date().toISOString().slice(0, 10),
    documents: review.documents.map((d) => ({ file: d.file, sha256: d.sha256, gt_sha256: d.gt_sha256, sampled: d.rows.length, ok: d.rows.filter((r) => r.ok).length, wrong: d.rows.filter((r) => r.ok === false).map((r) => ({ ref: r.ref, page: r.page })) })),
  })
  writeFileSync(RECORD_PATH, `${JSON.stringify(out, null, 2)}\n`)
  const total = out.documents.reduce((n, d) => n + d.sampled, 0)
  const ok = out.documents.reduce((n, d) => n + d.ok, 0)
  console.log(`${String(ok)} de ${String(total)} filas coinciden con el PDF. Registro: ${RECORD_PATH}`)
  for (const d of out.documents.filter((x) => x.wrong.length > 0)) console.log(`  ${d.file}: ${d.wrong.map((w) => `${w.ref} (pág. ${String(w.page)})`).join(', ')}`)
  if (ok < total) process.exit(1)
}

if (process.argv[1]?.endsWith('review.ts')) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'per-doc': { type: 'string', default: '8' }, seed: { type: 'string', default: '20261105' }, reviewer: { type: 'string' } } })
  if (positionals[0] === 'sample') sample(Math.max(1, Number(values['per-doc']) || 8), Number(values.seed) || 20261105)
  else if (positionals[0] === 'record' && values.reviewer) record(values.reviewer.slice(0, 10))
  else {
    console.error('uso: pnpm -F @gow/evals gt:review sample [--per-doc 8] [--seed N] | record --reviewer <iniciales>')
    process.exit(64)
  }
}
