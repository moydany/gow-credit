/* eslint-disable no-console -- CLI: prints only metrics, field names and pages */
// Scores already-written extractions (contract JSON) against the ground truth.
// Usage: tsx src/score-dir.ts <extractions-folder> [--json out.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StatementExtraction } from '@gow/contracts'
import { GroundTruth } from './ground-truth/schema.ts'
import { scoreDocument, type DocumentScore } from './metrics.ts'

const REPO = resolve(import.meta.dirname, '../..')
const USER_CWD = process.env.INIT_CWD ?? process.cwd()
const [dirArg, flag, out] = process.argv.slice(2)
if (!dirArg) throw new Error('uso: score-dir <carpeta> [--json salida.json]')
const dir = resolve(USER_CWD, dirArg)
const scores: DocumentScore[] = []
for (const f of readdirSync(dir).filter((x) => x.startsWith('EDC_') && x.endsWith('.json')).sort()) {
  const gtPath = join(REPO, 'data/ground-truth', f)
  if (!existsSync(gtPath)) continue
  const parsed = StatementExtraction.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')))
  if (!parsed.success) {
    console.log(`${f}: no cumple el contrato actual, se omite`)
    continue
  }
  scores.push(scoreDocument(parsed.data, GroundTruth.parse(JSON.parse(readFileSync(gtPath, 'utf8')))))
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
for (const s of scores) {
  console.log(`${s.bank.padEnd(12)} mov ${String(s.ex_transactions).padStart(4)}/${String(s.gt_transactions).padStart(4)} prec ${pct(s.precision)} recall ${pct(s.recall)} inv ${String(s.invented)} omit ${String(s.omitted)} | fecha ${pct(s.row_fields.date)} monto ${pct(s.row_fields.amount)} sentido ${pct(s.row_fields.type)} saldo ${pct(s.row_fields.balance)} desc ${pct(s.row_fields.description)} int ${pct(s.row_fields.internal_transfer)} | enc ${String(s.header.ok)}/${String(s.header.total)} cfdi ${String(s.fiscal.ok)}/${String(s.fiscal.total)} | cuadre ${s.reconciled_final ? 'sí' : 'no'} 1ª ${s.reconciled_first_pass ? 'sí' : 'no'} | USD ${s.cost_usd.toFixed(3)}`)
  if (s.header.failed.length) console.log(`     encabezado: ${s.header.failed.join(', ')}`)
  if (s.fiscal.failed.length) console.log(`     cfdi: ${s.fiscal.failed.join(', ')}`)
  if (s.pages_with_errors.length) console.log(`     páginas con filas de más o de menos: ${s.pages_with_errors.join(', ')}`)
}
if (flag === '--json' && out) writeFileSync(resolve(USER_CWD, out), `${JSON.stringify(scores, null, 2)}\n`)
