/* eslint-disable no-console -- CLI; scenarios only carry made-up data */
/**
 * pnpm scenario run <id>              one scenario (unit mode)
 * pnpm scenario run --all             every catalog scenario with unit mode
 * pnpm scenario run --all --policy policies/examples/fiscal-anchors.v1.json
 *                                     what would another policy do? (doesn't compare with expect)
 * pnpm scenario run --all --mode full the full-mode ones: real API, queue, worker and Mastra on the
 *                                     docker compose Postgres; no model calls
 */
import { postgresAvailable } from '@gow/db/testing'
import { loadCatalog, loadPolicy } from './load.ts'
import { runFull } from './run-full.ts'
import { runUnit } from './run-unit.ts'

function printFullScenarioResult(s: ReturnType<typeof loadCatalog>[0], r: Awaited<ReturnType<typeof runFull>>): void {
  const d = r.decision
  console.log(`${r.ok ? '✓' : '✗'} ${String(s.catalog ?? '-').padStart(2)} ${s.id}: solicitud ${r.applicationStatus ?? '-'}${d ? ` · veredicto ${d.status}${d.limit !== null ? ` línea ${d.limit.toLocaleString('es-MX')}` : ''}` : ''}`)
  for (const c of r.checks.filter((x) => !x.ok)) console.log(`    ${c.name}: esperado ${JSON.stringify(c.expected)}, obtenido ${JSON.stringify(c.actual)}`)
}

async function runFullMode(selected: ReturnType<typeof loadCatalog>): Promise<number> {
  if (!(await postgresAvailable())) {
    console.error('El modo full necesita el Postgres local: docker compose up -d')
    return 2
  }
  let failed = 0
  let ran = 0
  for (const s of selected.filter((x) => x.modes.includes('full'))) {
    const r = await runFull(s, loadPolicy)
    if (r.skipped) {
      console.log(`- ${String(s.catalog ?? '-').padStart(2)} ${s.id}: se salta (${r.skipped})`)
      continue
    }
    ran++
    printFullScenarioResult(s, r)
    if (!r.ok) failed++
  }
  console.log(`\n${String(ran - failed)} de ${String(ran)} escenarios full pasan`)
  return failed > 0 ? 1 : 0
}

interface ScenarioCliArgs {
  policyRef?: string
  mode: string
  ids: string[]
  all: boolean
}

function parseCliArgs(rest: string[]): ScenarioCliArgs {
  const policyIdx = rest.indexOf('--policy')
  const policyRef = policyIdx >= 0 ? rest[policyIdx + 1] : undefined
  const modeIdx = rest.indexOf('--mode')
  const mode = (modeIdx >= 0 ? rest[modeIdx + 1] : undefined) ?? 'unit'
  const ids = rest.filter((a, i) => !a.startsWith('--') && !(policyIdx >= 0 && i === policyIdx + 1) && !(modeIdx >= 0 && i === modeIdx + 1))
  const all = rest.includes('--all')
  return { policyRef, mode, ids, all }
}

function printUnitScenarioResult(s: ReturnType<typeof loadCatalog>[0], r: Awaited<ReturnType<typeof runUnit>>, override?: ReturnType<typeof loadPolicy>): void {
  const d = r.decision
  const summary = `${d.status}${d.limit !== null ? ` línea ${d.limit.toLocaleString('es-MX')}` : ''} · puntaje ${String(d.score)}`
  if (override) {
    console.log(`· ${s.id} [${override.id}]: ${summary} (esperado con ${s.tenant.policy}: ${s.expect.status})`)
    return
  }
  console.log(`${r.ok ? '✓' : '✗'} ${String(s.catalog ?? '-').padStart(2)} ${s.id}: ${summary}`)
  for (const c of r.checks.filter((x) => !x.ok)) console.log(`    ${c.name}: esperado ${JSON.stringify(c.expected)}, obtenido ${JSON.stringify(c.actual)}`)
}

async function runUnitMode(selected: ReturnType<typeof loadCatalog>, policyRef?: string): Promise<number> {
  const override = policyRef ? loadPolicy(policyRef) : undefined
  let failed = 0
  let ran = 0
  for (const s of selected) {
    if (!s.modes.includes('unit')) {
      console.log(`- ${s.id}: solo modo full (--mode full)`)
      continue
    }
    ran++
    const r = await runUnit(s, loadPolicy, override)
    printUnitScenarioResult(s, r, override)
    if (!r.ok) failed++
  }
  if (!override) console.log(`\n${String(ran - failed)} de ${String(ran)} escenarios unit pasan`)
  return failed > 0 ? 1 : 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'run') {
    console.error('uso: pnpm scenario run <id> | --all [--policy <ruta.json>] [--mode unit|full]')
    return 2
  }
  const { policyRef, mode, ids, all } = parseCliArgs(rest)
  const catalog = loadCatalog()
  const selected = all ? catalog : catalog.filter((s) => ids.includes(s.id))
  const missing = ids.filter((id) => !catalog.some((s) => s.id === id))
  if (missing.length > 0 || selected.length === 0) {
    console.error(`escenario desconocido: ${missing.join(', ') || '(ninguno)'}; hay: ${catalog.map((s) => s.id).join(', ')}`)
    return 2
  }
  if (mode === 'full') return runFullMode(selected)
  return runUnitMode(selected, policyRef)
}

process.exitCode = await main(process.argv.slice(2))
