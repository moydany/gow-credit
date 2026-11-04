/* eslint-disable no-console -- CLI; la salida en consola no lleva montos, nombres ni RFC */
/**
 * Perfil y veredicto sobre extracciones ya hechas, sin llamar a ningún modelo.
 *
 *   pnpm decide <extracción.json>... [--as-of AAAA-MM-DD] [--policy <json>|base]
 *                                  [--amount N] [--out data/out/profiles]
 *
 * El perfil completo y la decisión van a `--out` (por defecto data/out/profiles/, que no se
 * versiona). En consola solo se imprime lo que no identifica a nadie: cobertura, clasificación,
 * features desconocidas, estado y códigos de razón.
 */
import { parsePolicy, StatementExtraction, type Policy } from '@gow/contracts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { decide } from '../decide.ts'
import { BASE_POLICY_ID, basePolicyTemplate } from '../template.ts'

const ROOT = resolve(import.meta.dirname, '../../../../')
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1]?.startsWith('--') ?? false))
if (files.length === 0) {
  console.error('uso: pnpm decide <extracción.json>... [--as-of AAAA-MM-DD] [--policy <json>|base] [--amount N] [--out <carpeta>]')
  process.exit(2)
}
const asOf = flag('as-of') ?? new Date().toISOString().slice(0, 10)
const policyRef = flag('policy') ?? 'base'
let policy: Policy = basePolicyTemplate()
let policyId = BASE_POLICY_ID
if (policyRef !== 'base') {
  const res = parsePolicy(JSON.parse(readFileSync(resolve(ROOT, policyRef), 'utf8')))
  if (!res.ok) throw new Error(res.message)
  policy = res.policy
  policyId = basename(policyRef, '.json')
}
const amount = flag('amount')
const out = resolve(ROOT, flag('out') ?? 'data/out/profiles')
mkdirSync(out, { recursive: true })

for (const file of files) {
  // pnpm corre el script desde el paquete; las rutas del usuario son relativas a donde lo llamó.
  const statement = StatementExtraction.parse(JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')))
  const request = amount ? { amount: Number(amount), maturity: null, buyer: null } : null
  const { decision, ledger } = decide({ policy, policyId, statements: [statement], request, supplier: null, computedAt: `${asOf}T12:00:00.000Z` })
  const name = basename(file, '.json')
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ profile: decision.profile, decision }, null, 2)}\n`)

  const rows = ledger.rows
  const byRules = rows.filter((r) => r.classifiedBy === 'rules').length
  const unknown = Object.entries(decision.profile.features).filter(([, f]) => f.value === null).map(([k]) => k)
  const months = decision.profile.features.months_of_history.value
  console.log(name)
  console.log(`  ${String(rows.length)} movimientos, ${String(months ?? '?')} mes(es); clasificados por reglas ${String(byRules)}, por modelo ${String(rows.length - byRules)}`)
  console.log(`  desconocidas (${String(unknown.length)}): ${unknown.join(', ')}`)
  console.log(`  integridad ${String(decision.profile.features.integrity_ok.value)} · ancla fiscal ${String(decision.profile.features.fiscal_anchor_ok.value)} · régimen ${String(decision.profile.features.fiscal_regime.value)}`)
  console.log(`  ${policyId}: ${decision.status}; razones ${decision.reasons.map((r) => r.code).join(', ')}`)
}
console.log(`\nperfiles y decisiones en ${out}`)
