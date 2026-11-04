/* eslint-disable no-console -- script de inspección: la salida en consola es el resultado */
// Resumen de las extracciones en una carpeta: cuadre, conteos, verificación e issues por documento.
// No imprime nombres, RFC ni descripciones: solo cifras y códigos.
// Uso: node scripts/inspect-extractions.mjs [data/out/extractions]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'data/out/extractions'
for (const f of readdirSync(dir).filter((x) => x.startsWith('EDC_') && x.endsWith('.json')).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const ps = d.accounts.flatMap((a) => a.periods.map((p) => ({ ...p, acct: a })))
  const ver = {}
  for (const p of ps) for (const t of p.transactions) ver[t.verification] = (ver[t.verification] ?? 0) + 1
  console.log(`${f.padEnd(40)} ${d.extraction.status} route=${d.document.route} fiscal=${d.fiscal_documents?.length ?? '-'} cost=${d.extraction.cost_usd} ${JSON.stringify(ver)}`)
  for (const p of ps) {
    const r = p.reconciliation
    if (!r) continue
    const g = r.global ? r.global.difference : '-'
    const rb = r.running_balance ? `${r.running_balance.rows_checked}/${r.running_balance.breaks.length}` : '-'
    console.log(`   ${p.id} ${p.acct.account_type.value ?? '?'} ${p.period_start.value}..${p.period_end.value} tx=${p.transactions.length} ${r.status} global=${g} cred=${r.totals.credits.ok} deb=${r.totals.debits.ok} n=${r.totals.credits_count.extracted}+${r.totals.debits_count.extracted}/${r.totals.credits_count.printed ?? '?'}+${r.totals.debits_count.printed ?? '?'} rb(checked/breaks)=${rb}`)
  }
  for (const i of d.issues.filter((x) => x.severity !== 'info')) console.log(`   ${i.severity}: ${i.code} ${i.message.slice(0, 150)}`)
}
