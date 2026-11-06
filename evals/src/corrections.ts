/* eslint-disable no-console -- CLI: solo conteos por documento y nombres de campo, nunca valores */
/**
 * pnpm -F @gow/evals corrections [--model <id>]
 *
 * Las correcciones del analista como conjunto de regresión (ADR 0020, fase 8). Lee
 * `data/corrections/<sha256>.json` (de `pnpm corrections:export`), busca el PDF con ese hash en
 * `data/dev/` o en CORRECTIONS_PDF_DIR, repite la extracción desde la caché con el modelo actual y
 * clasifica cada corrección:
 *
 * - `fixed`: el modelo actual ya lee el valor correcto.
 * - `same_error`: vuelve a leer lo que el analista corrigió.
 * - `other`: lee un tercer valor.
 * - `not_in_document`: el valor leído era null (dato redactado o ausente). El analista confirmó un
 *   dato que el documento no trae; no es error de extracción y no cuenta en la tasa.
 *
 * Es informativa: no bloquea `pnpm eval`. Un error que el analista corrigió y el modelo sigue
 * cometiendo es el primer candidato a ground truth y a cambio de prompt.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CorrectionsExport, type CorrectionTarget } from '@gow/contracts'
import { readValue } from '@gow/extraction/corrections'
import { EXTRACTION_MODEL } from '@gow/llm'
import { DEV_DIR, REPO, replayExtraction, RESULTS_DIR } from './replay.ts'

export type Verdict = 'fixed' | 'same_error' | 'other' | 'not_in_document'

const norm = (v: string | number | null): string | number | null => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : v)
export function same(a: string | number | null, b: string | number | null): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 0.005
  return x === y
}

export function verdict(now: string | number | null, read: string | number | null, correct: string | number): Verdict {
  if (read === null) return 'not_in_document'
  if (same(now, correct)) return 'fixed'
  if (same(now, read)) return 'same_error'
  return 'other'
}

const label = (t: CorrectionTarget) => `${t.kind}.${t.field}`

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { model: { type: 'string', default: EXTRACTION_MODEL } } })
  const dir = process.env.CORRECTIONS_DIR ?? join(REPO, 'data/corrections')
  const pdfDirs = [DEV_DIR, ...(process.env.CORRECTIONS_PDF_DIR ? [process.env.CORRECTIONS_PDF_DIR] : [])]
  if (!existsSync(dir)) {
    console.log(`No hay ${dir}. Exporta primero: pnpm corrections:export --tenant <id>`)
    return
  }
  const byHash = new Map<string, string>()
  for (const d of pdfDirs.filter(existsSync)) {
    for (const f of readdirSync(d).filter((x) => x.toLowerCase().endsWith('.pdf'))) byHash.set(createHash('sha256').update(readFileSync(join(d, f))).digest('hex'), join(d, f))
  }
  const totals: Record<Verdict, number> = { fixed: 0, same_error: 0, other: 0, not_in_document: 0 }
  const lines = ['# Correcciones del analista contra el modelo actual', '', `Modelo \`${values.model}\`, extracción desde caché.`, '', '| Documento | Campo | Página | Resultado |', '|---|---|---|---|']
  let skipped = 0
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const file = CorrectionsExport.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    const pdf = byHash.get(file.document_sha256)
    const short = file.document_sha256.slice(0, 12)
    if (!pdf) {
      skipped++
      lines.push(`| ${short} | — | — | sin PDF con ese hash |`)
      continue
    }
    const r = await replayExtraction(pdf, values.model)
    if (r.status !== 'ok') {
      skipped++
      lines.push(`| ${short} | — | — | sin caché (${r.misses.join(', ')}) |`)
      continue
    }
    for (const c of file.corrections) {
      let now: string | number | null
      try {
        now = readValue(r.doc, c.target)
      } catch {
        now = null
      }
      const v = verdict(now, c.read_value, c.value)
      totals[v]++
      lines.push(`| ${short} | ${label(c.target)} | ${c.page === null ? '—' : String(c.page)} | ${v} |`)
    }
  }
  const counted = totals.fixed + totals.same_error + totals.other
  const summary = `Corregidas por el modelo actual: ${String(totals.fixed)} de ${String(counted)} · mismo error: ${String(totals.same_error)} · otro valor: ${String(totals.other)} · dato que el documento no trae: ${String(totals.not_in_document)}${skipped ? ` · documentos sin PDF o sin caché: ${String(skipped)}` : ''}`
  lines.push('', summary, '')
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'corrections.md'), lines.join('\n'))
  console.log(summary)
  console.log(`Reporte: ${join(RESULTS_DIR, 'corrections.md')}`)
}

if (process.argv[1]?.endsWith('corrections.ts')) await main()
