import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePolicy, type PolicyInput } from './policy.ts'

const BASE_POLICY_PATH = new URL('../../../policies/gow-base.v1.json', import.meta.url)

function basePolicy(): PolicyInput {
  return JSON.parse(readFileSync(BASE_POLICY_PATH, 'utf8')) as PolicyInput
}

/** Deep copy of the base policy with one change applied. */
function withChange(change: (p: PolicyInput) => void): PolicyInput {
  const p = basePolicy()
  change(p)
  return p
}

function errorsOf(input: unknown): { path: string; message: string }[] {
  const res = parsePolicy(input)
  if (res.ok) throw new Error('se esperaba una política inválida')
  return res.errors
}

describe('política base (policies/gow-base.v1.json)', () => {
  it('es válida y aplica los defaults', () => {
    const res = parsePolicy(basePolicy())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.policy.gates.find((g) => g.id === 'doc_recent')?.onUnknown).toBe('fail')
    // Identity is not a gate: it is compared and reported, but does not decide.
    expect(res.policy.gates.some((g) => g.id === 'identity')).toBe(false)
    expect(res.policy.score.dimensions.find((d) => d.id === 'capacity')?.inverse).toBe(false)
  })
})

describe('definición de terminado de la fase 1: operador incompatible con el tipo de feature', () => {
  it('rechaza "<=" sobre una feature enum con un mensaje que dice qué usar', () => {
    const errors = errorsOf(
      withChange((p) => {
        p.gates[1] = { id: 'identity', when: { feature: 'identity_match', op: '<=', value: 1 }, onFail: { status: 'human_review' } }
      }),
    )
    expect(errors).toEqual([
      {
        path: 'gates[1].when.op',
        message: 'el operador "<=" no aplica a "identity_match", que es enum (match, partial, mismatch); para ese tipo usa "in", "not_in"',
      },
    ])
    const res = parsePolicy(withChange((p) => (p.gates[1] = { id: 'identity', when: { feature: 'identity_match', op: '<=', value: 1 }, onFail: { status: 'human_review' } })))
    expect(res.ok ? '' : res.message).toContain('política inválida:\n  - gates[1].when.op: el operador "<=" no aplica a "identity_match"')
  })

  it.each([
    ['in sobre numérica', { feature: 'months_of_history', op: 'in', value: ['3'] }, 'gates[0].when.op', 'que es int'],
    ['empty sobre numérica', { feature: 'operating_income_monthly', op: 'empty' }, 'gates[0].when.op', 'que es money'],
    ['< sobre bool', { feature: 'integrity_ok', op: '<', value: 1 }, 'gates[0].when.op', 'que es bool'],
    ['== sobre lista', { feature: 'red_flags', op: '==', value: 0 }, 'gates[0].when.op', 'que es enum_list'],
    ['valor no numérico', { feature: 'document_age_days', op: '<=', value: true }, 'gates[0].when.value', 'el valor debe ser un número'],
    ['valor no booleano', { feature: 'integrity_ok', op: '==', value: 1 }, 'gates[0].when.value', 'true o false'],
    ['valor fuera del enum', { feature: 'identity_match', op: 'in', value: ['match', 'unknown'] }, 'gates[0].when.value[1]', '"unknown" no es un valor de "identity_match"'],
    ['empty con valor', { feature: 'red_flags', op: 'empty', value: 0 }, 'gates[0].when.value', 'no lleva valor'],
  ])('%s', (_name, when, path, fragment) => {
    const errors = errorsOf(withChange((p) => (p.gates[0] = { id: 'g', when: when as never, onFail: { status: 'human_review' } })))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe(path)
    expect(errors[0]?.message).toContain(fragment)
  })

  it('rechaza una feature que no está en el catálogo', () => {
    const errors = errorsOf(withChange((p) => (p.gates[0] = { id: 'g', when: { feature: 'ventas_totales' as never, op: '>', value: 1 }, onFail: { status: 'human_review' } })))
    expect(errors[0]).toEqual({ path: 'gates[0].when.feature', message: 'feature desconocida "ventas_totales"; el catálogo (docs/03 §3) no la tiene' })
  })

  it('aplica la misma regla de tipos a los topes', () => {
    const errors = errorsOf(withChange((p) => p.decision.caps?.push({ when: { feature: 'sat_status', op: '>', value: 0 }, maxStatus: 'not_qualified' })))
    expect(errors[0]?.path).toBe('decision.caps[2].when.op')
  })
})

describe('compuertas', () => {
  it('needs_clarification exige ask', () => {
    const errors = errorsOf(withChange((p) => (p.gates[0] = { id: 'g', when: { feature: 'document_age_days', op: '<=', value: 90 }, onFail: { status: 'needs_clarification' } })))
    expect(errors[0]).toEqual({ path: 'gates[0].onFail.ask', message: 'una compuerta que manda a needs_clarification debe decir qué preguntar (ask)' })
  })

  it('onUnknown "ask" exige onFail.ask', () => {
    const errors = errorsOf(withChange((p) => (p.gates[0] = { id: 'g', when: { feature: 'document_age_days', op: '<=', value: 90 }, onFail: { status: 'human_review' }, onUnknown: 'ask' })))
    expect(errors.map((e) => e.path)).toEqual(['gates[0].onUnknown'])
  })

  it('rechaza llaves desconocidas (typos del tenant)', () => {
    const errors = errorsOf(withChange((p) => Object.assign(p.gates[0] ?? {}, { onfail: { status: 'human_review' } })))
    expect(errors[0]?.path).toBe('gates[0]')
    expect(errors[0]?.message).toContain('onfail')
  })

  it('rechaza ids repetidos entre compuertas y dimensiones', () => {
    const errors = errorsOf(withChange((p) => p.score.dimensions[0] && (p.score.dimensions[0].id = 'integrity')))
    const at = basePolicy().gates.findIndex((g) => g.id === 'integrity')
    expect(errors[0]).toEqual({ path: 'score.dimensions[0].id', message: `id repetido "integrity" (ya se usa en gates.${String(at)}.id)` })
  })
})

describe('dimensiones', () => {
  it('exigen feature numérica', () => {
    const errors = errorsOf(withChange((p) => p.score.dimensions[1] && (p.score.dimensions[1].feature = 'identity_match')))
    expect(errors[0]?.path).toBe('score.dimensions[1].feature')
    expect(errors[0]?.message).toContain('necesita una feature numérica')
  })

  it('exigen que los pesos sumen 100', () => {
    const errors = errorsOf(withChange((p) => p.score.dimensions[0] && (p.score.dimensions[0].weight = 30)))
    expect(errors[0]).toEqual({ path: 'score.dimensions', message: 'los pesos de las dimensiones deben sumar 100 (suman 95)' })
  })

  it('exigen coherencia entre inverse y el orden de zeroAt/fullAt', () => {
    const errors = errorsOf(withChange((p) => p.score.dimensions[3] && (p.score.dimensions[3].inverse = false)))
    expect(errors[0]?.path).toBe('score.dimensions[3].inverse')
  })
})

describe('bandas y fórmula de línea', () => {
  it('van de mayor a menor y la última empieza en 0', () => {
    const errors = errorsOf(
      withChange((p) => {
        p.decision.bands = [
          { min: 50, status: 'qualified_with_limit', limit: { pctOf: 'operating_income_monthly', pct: 25 } },
          { min: 70, status: 'qualified', limit: { pctOf: 'operating_income_monthly', pct: 50 } },
          { min: 10, status: 'not_qualified' },
        ]
      }),
    )
    expect(errors.map((e) => e.path)).toEqual(['decision.bands[1].min', 'decision.bands[1].status', 'decision.bands[2].min'])
  })

  it('una banda que califica exige limit sobre una feature money', () => {
    const errors = errorsOf(withChange((p) => p.decision.bands[0] && (p.decision.bands[0].limit = { pctOf: 'payment_capacity_pct', pct: 50 })))
    expect(errors[0]?.path).toBe('decision.bands[0].limit.pctOf')
  })

  it.each([
    ['min(band, payment_capacity_pct)', 'es ratio; en la fórmula de línea solo caben features de tipo money'],
    ['min(debt_capacity, program_available_limit)', 'band debe aparecer exactamente una vez'],
    ['min(band, max(debt_capacity))', 'no se permiten paréntesis anidados'],
    ['min(band, debt_capacity - existing_exposure_balance - requested_amount)', 'solo se permite una resta'],
    ['band * 2', 'no es un término válido'],
  ])('rechaza la fórmula %s', (formula, fragment) => {
    const errors = errorsOf(withChange((p) => (p.decision.limitFormula = formula)))
    expect(errors[0]?.path).toBe('decision.limitFormula')
    expect(errors[0]?.message).toContain(fragment)
  })
})
