/**
 * Definición de terminado de la fase 4 (docs/00 §4): los escenarios de docs/06 pasan en modo
 * unitario, sin LLM. Cada archivo de catalog/ con modo unit es un caso.
 */
import { describe, expect, it } from 'vitest'
import { loadCatalog, loadPolicy } from './load.ts'
import { runUnit } from './run-unit.ts'

const unit = loadCatalog().filter((s) => s.modes.includes('unit'))

describe('escenarios de docs/06 en modo unit', () => {
  it('incluye los que pide la fase 4 (3, 5, 6 y 11) y los fiscales de docs/09 (21 a 25)', () => {
    const catalog = unit.map((s) => s.catalog)
    for (const n of [3, 5, 6, 11, 21, 22, 23, 24, 25]) expect(catalog).toContain(n)
  })

  it.each(unit.map((s) => [`${String(s.catalog ?? '-')} ${s.id}`, s] as const))('%s', async (_, scenario) => {
    const r = await runUnit(scenario, loadPolicy)
    const failed = r.checks.filter((c) => !c.ok)
    expect(failed, JSON.stringify({ status: r.decision.status, limit: r.decision.limit, score: r.decision.score, reasons: r.decision.reasons.map((x) => x.code) })).toEqual([])
  })
})
