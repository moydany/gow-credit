/**
 * El catálogo en modo full (docs/06 §7): API, cola, worker y Mastra reales sobre una base nueva por
 * escenario, sin llamadas a modelos. Necesita el Postgres de docker compose; el caso 16 además
 * necesita data/dev y su caché, y sin ellos se salta.
 */
import { postgresAvailable } from '@gow/db/testing'
import { describe, expect, it } from 'vitest'
import { loadCatalog, loadPolicy } from './load.ts'
import { runFull } from './run-full.ts'

const available = await postgresAvailable()
const full = loadCatalog().filter((s) => s.modes.includes('full'))

describe.skipIf(!available)('escenarios en modo full (necesita el Postgres de docker compose)', () => {
  it('el catálogo incluye los casos que pide la fase 6', () => {
    expect(full.map((s) => s.catalog).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(expect.arrayContaining([1, 5, 6, 12, 15, 16, 19]))
  })

  it.each(full.map((s) => [s.id, s] as const))('%s', async (_id, scenario) => {
    const r = await runFull(scenario, loadPolicy)
    if (r.skipped) return
    expect(r.checks.filter((c) => !c.ok)).toEqual([])
  }, 120_000)
})
