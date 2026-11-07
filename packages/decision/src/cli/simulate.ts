/* eslint-disable no-console -- CLI; the portfolio is synthetic and real profiles only print counts */
/**
 * Simulates a draft policy against the current one.
 *
 *   pnpm simulate --policy <draft.json> [--baseline <current.json>|base]
 *                                  [--portfolio 200] [--profiles <folder with profile .json files>]
 *
 * Without --profiles it uses a synthetic portfolio (fixed seed). With --profiles it reads the
 * JSON that `pnpm decide` writes (data/out/profiles/, not versioned).
 */
import { parsePolicy, Profile, type Policy, type SimulationCase } from '@gow/contracts'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { simulatePolicy } from '../simulate.ts'
import { BASE_POLICY_ID, basePolicyTemplate } from '../template.ts'
import { syntheticPortfolio } from '../testing/portfolio.ts'

const ROOT = resolve(import.meta.dirname, '../../../../')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function policyFrom(ref: string): { id: string; policy: Policy } {
  if (ref === 'base') return { id: BASE_POLICY_ID, policy: basePolicyTemplate() }
  const res = parsePolicy(JSON.parse(readFileSync(resolve(ROOT, ref), 'utf8')))
  if (!res.ok) throw new Error(`${ref}: ${res.message}`)
  return { id: basename(ref, '.json'), policy: res.policy }
}

function profilesFrom(dir: string): SimulationCase[] {
  const abs = resolve(ROOT, dir)
  return readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .map((f, i) => {
      const json = JSON.parse(readFileSync(join(abs, f), 'utf8')) as { profile?: unknown }
      return { id: `r${String(i + 1).padStart(3, '0')}`, profile: Profile.parse(json.profile ?? json), outcome: null }
    })
}

const draftRef = arg('policy')
if (!draftRef) {
  console.error('uso: simulate --policy <borrador.json> [--baseline <vigente.json>|base] [--portfolio N] [--profiles <carpeta>]')
  process.exit(2)
}
const draft = policyFrom(draftRef)
const baseline = policyFrom(arg('baseline') ?? 'base')
const profilesDir = arg('profiles')
const cases = profilesDir ? profilesFrom(profilesDir) : syntheticPortfolio(Number(arg('portfolio') ?? 200))
const r = simulatePolicy(draft, cases, baseline)

console.log(`Simulación de ${draft.id} contra ${baseline.id} sobre ${String(r.total)} perfiles ${profilesDir ? `de ${profilesDir}` : 'sintéticos (semilla 42)'}`)
console.log(`  por estado: ${Object.entries(r.by_status).map(([s, n]) => `${s} ${String(n)}`).join(' · ')}`)
if (r.transitions) {
  const t = r.transitions
  console.log(`  contra la vigente: ${String(t.upgraded)} mejoran, ${String(t.downgraded)} empeoran, ${String(t.unchanged)} igual; línea sube en ${String(t.limit_increased)}, baja en ${String(t.limit_decreased)}`)
}
for (const o of r.outcomes) console.log(`  mora observada en ${o.status}: ${String(o.bad)} de ${String(o.with_outcome)}${o.bad_rate !== null ? ` (${(o.bad_rate * 100).toFixed(1)} %)` : ''}`)
