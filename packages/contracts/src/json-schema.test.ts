import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderSchema, SCHEMA_DIR } from '../scripts/export-json-schema.ts'
import { FEATURE_NAMES } from './features.ts'
import { PUBLISHED_SCHEMAS, toPublishedJsonSchema } from './json-schema.ts'
import { parseLimitFormula } from './limit-formula.ts'

describe('JSON Schema publicado en docs/schema/', () => {
  it.each(Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[])('%s está al día con Zod (si falla: pnpm schema:export)', (name) => {
    const committed = readFileSync(`${SCHEMA_DIR}${name}.schema.json`, 'utf8')
    expect(committed).toBe(renderSchema(name))
  })

  it('la política expone el catálogo como enum y los defaults como opcionales', () => {
    const schema = toPublishedJsonSchema('policy') as { $defs: Record<string, { properties: Record<string, { enum?: string[] }>; required?: string[] }> }
    expect(schema.$defs.Condition?.properties.feature?.enum).toEqual(FEATURE_NAMES)
    expect(schema.$defs.Gate?.required).not.toContain('onUnknown')
  })
})

describe('parseLimitFormula', () => {
  it('acepta la fórmula de la política base', () => {
    expect(parseLimitFormula('min(band, debt_capacity - existing_exposure_balance, program_available_limit)')).toEqual({
      ok: true,
      formula: {
        terms: [{ type: 'band' }, { type: 'difference', minuend: 'debt_capacity', subtrahend: 'existing_exposure_balance' }, { type: 'feature', feature: 'program_available_limit' }],
      },
    })
  })

  it('acepta un solo término', () => {
    expect(parseLimitFormula('band')).toEqual({ ok: true, formula: { terms: [{ type: 'band' }] } })
  })

  it.each([
    ['', 'la fórmula está vacía'],
    ['min()', 'min() necesita al menos un término'],
    ['min(band,)', 'término 2 vacío'],
    ['min(band, band)', 'band debe aparecer exactamente una vez (aparece 2)'],
    ['min(band, ventas)', 'feature desconocida "ventas"'],
    ['min(band - debt_capacity)', 'término 1: band no puede ir en una resta'],
    ['max(band, debt_capacity)', 'forma no reconocida'],
  ])('rechaza %j', (formula, message) => {
    const res = parseLimitFormula(formula)
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toContain(message)
  })
})
