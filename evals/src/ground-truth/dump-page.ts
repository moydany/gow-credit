/* eslint-disable no-console -- herramienta local para escribir parsers: imprime texto del documento, nunca se usa en CI ni en logs */
// Uso: pnpm -F @gow/evals exec tsx src/ground-truth/dump-page.ts <pdf> <página> [desde] [hasta]
import { readLayout } from './layout.ts'

const [path, pageArg, from, to] = process.argv.slice(2)
if (!path || !pageArg) throw new Error('uso: dump-page <pdf> <página> [desde] [hasta]')
const layout = await readLayout(path)
const lines = layout.pages[Number(pageArg) - 1] ?? []
for (const [i, l] of lines.entries()) {
  if (from && i < Number(from)) continue
  if (to && i > Number(to)) break
  console.log(`${String(i).padStart(3)} y=${l.y.toFixed(0).padStart(4)} ${l.segments.map((s) => `[${s.x.toFixed(0)}-${s.x2.toFixed(0)}]${s.str}`).join('  ')}`)
}
