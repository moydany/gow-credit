/* eslint-disable no-console -- local tool: prints only figures and codes, no document text */
// Usage: pnpm -F @gow/evals exec tsx src/ground-truth/probe.ts <bank> [--rows]
import { join, resolve } from 'node:path'
import { BANKS } from './banks.ts'
import { readLayout } from './layout.ts'
import { checkChain, parseTable } from './parse-table.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const [bankId, flag] = process.argv.slice(2)
const spec = BANKS.find((b) => b.bank === bankId)
if (!spec) throw new Error(`banco desconocido: ${String(bankId)}`)
const layout = await readLayout(join(REPO, 'data/dev', spec.file))
for (const table of spec.tables) {
  const rows = parseTable(layout.pages, table)
  const sections = [...new Set(rows.map((r) => r.section))]
  for (const s of sections) {
    const rs = rows.filter((r) => r.section === s)
    const c = checkChain(rs, null, { reverse: spec.reverseChronological ?? false })
    const problems = rs.filter((r) => r.problems.length > 0)
    console.log(`${s}: filas ${String(rs.length)} abonos ${String(c.creditsCount)} = ${c.credits.toFixed(2)} cargos ${String(c.debitsCount)} = ${c.debits.toFixed(2)} con saldo ${String(c.withBalance)} rupturas ${String(c.breaks.length)} problemas ${String(problems.length)} internos ${String(rs.filter((r) => r.internal_transfer).length)}`)
    const perPage = new Map<number, number>()
    for (const r of rs) perPage.set(r.page, (perPage.get(r.page) ?? 0) + 1)
    console.log(`  por página: ${[...perPage].map(([p, n]) => `${String(p)}:${String(n)}`).join(' ')}`)
    for (const b of c.breaks.slice(0, 8)) console.log(`  ruptura fila ${String(b.index)} p${String(b.page)} esperado ${b.expected.toFixed(2)} impreso ${b.printed.toFixed(2)} dif ${(b.printed - b.expected).toFixed(2)}`)
    for (const r of problems.slice(0, 8)) console.log(`  problema p${String(r.page)} ${r.date}: ${r.problems.join('; ')}`)
    if (flag === '--rows') for (const r of rs) console.log(`  ${r.date} p${String(r.page)} ${r.type} ${r.amount.toFixed(2)} bal ${String(r.balance)} ref ${r.reference ? 'sí' : 'no'} desc ${String(r.description.length)}c`)
  }
}
