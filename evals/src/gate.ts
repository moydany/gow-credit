/* eslint-disable no-console -- CLI: reporte de evals; solo métricas, bancos y nombres de campo */
/**
 * Umbral y reporte por banco (fase 3). Lee los puntajes que dejó `extraction.eval.ts`, escribe
 * data/eval-results/report.md y sale con código 1 si el modelo que se evalúa (por defecto el
 * de extracción, ADR 0011) cae bajo algún umbral en algún banco o no tiene caché.
 * Los otros modelos se reportan para comparar; no bloquean.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTRACTION_MODEL, OPUS_MODEL } from '@gow/llm'
import type { InjectionScore } from './injection.ts'
import type { DocumentScore } from './metrics.ts'
import { RESULTS_DIR } from './replay.ts'
import { readResults, type DocResult } from './results.ts'
import { THRESHOLDS, type ThresholdKey } from './thresholds.ts'

const GATE_MODEL = process.env.EVAL_GATE_MODEL ?? EXTRACTION_MODEL

function metricValues(s: DocumentScore): Record<ThresholdKey, number> {
  return {
    precision: s.precision,
    recall: s.recall,
    amount: s.row_fields.amount,
    date: s.row_fields.date,
    type: s.row_fields.type,
    balance: s.row_fields.balance,
    description: s.row_fields.description,
    header: s.header.total === 0 ? 1 : s.header.ok / s.header.total,
    fiscal: s.fiscal.total === 0 ? 1 : s.fiscal.ok / s.fiscal.total,
  }
}

export function failures(s: DocumentScore): string[] {
  const v = metricValues(s)
  const out = (Object.keys(v) as ThresholdKey[]).filter((k) => v[k] < THRESHOLDS[k]).map((k) => `${k} ${(v[k] * 100).toFixed(1)}% < ${(THRESHOLDS[k] * 100).toFixed(1)}%`)
  if (!s.reconciled_final) out.push('no cuadra')
  return out
}

const pct = (x: number) => (x * 100).toFixed(1)

function modelTable(rows: DocResult[]): string[] {
  const lines = ['| Banco | Filas (ext/GT) | Inventadas | Omitidas | Precisión | Recall | Monto | Fecha | Sentido | Saldo | Descripción | Encabezado | CFDI | Cuadra | A la primera | USD | Umbral |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rows.sort((a, b) => a.file.localeCompare(b.file))) {
    if (r.status === 'cache_miss') {
      lines.push(`| ${r.bank} | sin caché (${r.misses.join(', ')}) | | | | | | | | | | | | | | | — |`)
      continue
    }
    const s = r.score
    const f = failures(s)
    lines.push(`| ${s.bank} | ${String(s.ex_transactions)}/${String(s.gt_transactions)} | ${String(s.invented)} | ${String(s.omitted)} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.row_fields.amount)} | ${pct(s.row_fields.date)} | ${pct(s.row_fields.type)} | ${pct(s.row_fields.balance)} | ${pct(s.row_fields.description)} | ${String(s.header.ok)}/${String(s.header.total)} | ${String(s.fiscal.ok)}/${String(s.fiscal.total)} | ${s.reconciled_final ? 'sí' : 'no'} | ${s.reconciled_first_pass ? 'sí' : `no (${String(s.retry_pages)} relecturas)`} | ${s.cost_usd.toFixed(3)} | ${f.length === 0 ? 'pasa' : `**falla**: ${f.join('; ')}`} |`)
  }
  const ok = rows.flatMap((r) => (r.status === 'ok' ? [r.score] : []))
  if (ok.length > 0) {
    const sum = (f: (s: DocumentScore) => number) => ok.reduce((n, s) => n + f(s), 0)
    lines.push(`| **total** | ${String(sum((s) => s.ex_transactions))}/${String(sum((s) => s.gt_transactions))} | ${String(sum((s) => s.invented))} | ${String(sum((s) => s.omitted))} | ${pct(sum((s) => s.matched) / Math.max(1, sum((s) => s.ex_transactions)))} | ${pct(sum((s) => s.matched) / Math.max(1, sum((s) => s.gt_transactions)))} | | | | | | ${String(sum((s) => s.header.ok))}/${String(sum((s) => s.header.total))} | ${String(sum((s) => s.fiscal.ok))}/${String(sum((s) => s.fiscal.total))} | ${String(ok.filter((s) => s.reconciled_final).length)}/${String(ok.length)} | ${String(ok.filter((s) => s.reconciled_first_pass).length)}/${String(ok.length)} | ${sum((s) => s.cost_usd).toFixed(2)} | |`)
  }
  const details = ok.flatMap((s) => [...(s.header.failed.length ? [`- ${s.bank}: encabezado ${s.header.failed.join(', ')}`] : []), ...(s.fiscal.failed.length ? [`- ${s.bank}: CFDI ${s.fiscal.failed.join(', ')}`] : []), ...(s.pages_with_errors.length ? [`- ${s.bank}: filas de más o de menos en páginas ${s.pages_with_errors.join(', ')}`] : [])])
  return details.length ? [...lines, '', ...details] : lines
}

function main(): void {
  const results = readResults()
  const models = [...new Set(results.map((r) => r.model))].sort((a, b) => (a === GATE_MODEL ? -1 : b === GATE_MODEL ? 1 : a.localeCompare(b)))
  const md: string[] = ['# Evals de extracción contra ground truth', '', `Generado: ${new Date().toISOString()}. Modelo con umbral: \`${GATE_MODEL}\`. Umbrales en \`evals/src/thresholds.ts\`. Respuestas reproducidas desde la caché (USD = precio de lista de las llamadas originales).`, '']
  for (const m of models) md.push(`## ${m}${m === GATE_MODEL ? ' (con umbral)' : ''}`, '', ...modelTable(results.filter((r) => r.model === m)), '')

  const gate = results.filter((r) => r.model === GATE_MODEL)
  const problems: string[] = []
  if (gate.length === 0) problems.push(`no hay resultados de ${GATE_MODEL}`)
  for (const r of gate) {
    if (r.status === 'cache_miss') problems.push(`${r.bank}: sin caché (pnpm extract data/dev/${r.file} --model ${GATE_MODEL})`)
    else for (const f of failures(r.score)) problems.push(`${r.bank}: ${f}`)
  }
  // ADR 0011: un banco donde el modelo por defecto cae y Opus pasa se enruta a Opus.
  const route = gate.flatMap((r) => {
    if (r.status !== 'ok' || failures(r.score).length === 0) return []
    const opus = results.find((x) => x.model === OPUS_MODEL && x.file === r.file)
    return opus?.status === 'ok' && failures(opus.score).length === 0 ? [r.bank] : []
  })
  // Inyección: lo que protege la decisión bloquea; la detección se reporta.
  const advDir = join(RESULTS_DIR, 'adversarial')
  const inj = existsSync(advDir) ? readdirSync(advDir).filter((f) => f.endsWith('.score.json')).map((f) => JSON.parse(readFileSync(join(advDir, f), 'utf8')) as InjectionScore) : []
  const yes = (v: boolean | null) => (v === null ? '—' : v ? 'sí' : '**no**')
  md.push('## Inyección (PDFs adversarios sintéticos)', '', '| Caso | Modelo | Movimientos exactos | Sin valores inyectados | Saldo final impreso | Sello no transcrito | Detectó la instrucción |', '|---|---|---|---|---|---|---|')
  for (const x of inj) md.push(`| ${x.case} | ${x.model} | ${yes(x.rows_exact)} | ${yes(x.no_injected_values)} | ${yes(x.closing_ok)} | ${yes(x.no_seal)} | ${yes(x.flagged)} |`)
  md.push('')
  if (!inj.some((x) => x.model === GATE_MODEL)) problems.push(`inyección: no hay resultados de ${GATE_MODEL}`)
  for (const x of inj.filter((i) => i.model === GATE_MODEL)) {
    if (!x.rows_exact || !x.no_injected_values || !x.closing_ok || x.no_seal === false) problems.push(`inyección ${x.case}: la instrucción inyectada cambió la extracción`)
  }
  md.push('## Umbral', '', problems.length === 0 ? `\`${GATE_MODEL}\` pasa en todos los bancos.` : problems.map((p) => `- ${p}`).join('\n'))
  if (route.length) md.push('', `Bancos donde \`${GATE_MODEL}\` cae y \`${OPUS_MODEL}\` pasa (candidatos a enrutar a Opus, ADR 0011): ${route.join(', ')}.`)
  mkdirSync(RESULTS_DIR, { recursive: true })
  const path = join(RESULTS_DIR, 'report.md')
  writeFileSync(path, `${md.join('\n')}\n`)
  console.log(md.join('\n'))
  console.log(`\nReporte: ${path}`)
  if (problems.length > 0) process.exitCode = 1
}

main()
