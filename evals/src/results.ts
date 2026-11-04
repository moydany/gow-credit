/** Resultados de una corrida de evals por modelo y documento, en data/eval-results/ (no se versiona). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentScore } from './metrics.ts'
import { RESULTS_DIR } from './replay.ts'

export type DocResult = { model: string; file: string; bank: string; status: 'ok'; score: DocumentScore } | { model: string; file: string; bank: string; status: 'cache_miss'; misses: string[] }

const safe = (model: string) => model.replace(/[^a-z0-9.-]/gi, '_')

export function writeResult(r: DocResult): void {
  const dir = join(RESULTS_DIR, 'extraction', safe(r.model))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${r.file.replace(/\.pdf$/, '')}.json`), `${JSON.stringify(r, null, 2)}\n`)
}

export function readResults(): DocResult[] {
  const root = join(RESULTS_DIR, 'extraction')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((m) => readdirSync(join(root, m)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(root, m, f), 'utf8')) as DocResult))
}
