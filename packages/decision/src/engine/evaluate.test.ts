import { parsePolicy, type FeatureName, type Profile, type Verification } from '@gow/contracts'
import { sampleProfile } from '@gow/contracts/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { basePolicyTemplate, clonePolicy } from '../template.ts'
import { withFeatures } from './counterfactuals.ts'
import { evaluate } from './evaluate.ts'

const policy = basePolicyTemplate()

/** La base ya no tiene compuerta de identidad (ADR 0052); las pruebas del motor la agregan para probar `onUnknown` y lo no verificado. */
function withIdentityGate() {
  const raw = structuredClone(basePolicyTemplate()) as unknown as { gates: unknown[] }
  raw.gates.splice(1, 0, { id: 'identity', when: { feature: 'identity_match', op: 'in', value: ['match'] }, onFail: { status: 'needs_clarification', ask: 'identity_fields' }, onUnknown: 'ask' })
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('política de prueba inválida')
  return parsed.policy
}

type Values = Parameters<typeof sampleProfile>[0]

/** Perfil sano para la política base: puntaje 100, sin topes. */
const HEALTHY: Values = {
  document_age_days: 10,
  identity_match: 'match',
  integrity_ok: true,
  red_flags: [],
  existing_exposure_days_past_due: 0,
  existing_exposure_balance: 0,
  operating_income_monthly: 300000,
  requested_amount: 100000,
  buyer_payments_count: 4,
  payment_capacity_pct: 0.5,
  debt_service_monthly: 15000,
  recurring_income_share: 0.6,
  months_of_history: 6,
  debt_capacity: 450000,
}

function profile(values: Values = {}, meta: Partial<Record<FeatureName, { verification?: Verification; confidence?: number }>> = {}): Profile {
  const p = sampleProfile({ ...HEALTHY, ...values })
  for (const [name, m] of Object.entries(meta) as [FeatureName, { verification?: Verification; confidence?: number }][]) {
    Object.assign(p.features[name], m)
  }
  return p
}

const codes = (d: ReturnType<typeof evaluate>) => d.reasons.map((r) => r.code)

describe('evaluate(policy, profile) con la política base', () => {
  it('un perfil sano califica con la línea de la banda', () => {
    const d = evaluate(policy, profile(), { policyId: 'gow-base.v1' })
    expect([d.status, d.score, d.limit]).toEqual(['qualified', 100, 150000])
    expect(d.band).toEqual({ index: 0, min: 70, status: 'qualified' })
    expect(codes(d)).toContain('limit_band')
    expect(d.next_steps).toEqual([])
    expect(d.policy).toEqual({ id: 'gow-base.v1', version: 1 })
    expect(d.decided_at).toBe(d.profile.computed_at)
  })

  it('es determinístico y no muta el perfil', () => {
    const p = profile({ months_of_history: 1 })
    const copy = structuredClone(p)
    expect(evaluate(policy, p)).toEqual(evaluate(policy, p))
    expect(p).toEqual(copy)
  })

  describe('compuertas', () => {
    it('documento viejo → aclaración: pedir estado reciente', () => {
      const d = evaluate(policy, profile({ document_age_days: 120 }))
      expect(d.status).toBe('needs_clarification')
      expect(d.clarification).toEqual({ topics: ['recent_statement'], issue_ids: [], transactions: [] })
      expect(d.limit).toBeNull()
      expect(d.next_steps[0]).toMatchObject({ code: 'pass_gates', feature: 'document_age_days', current_value: 120, target_value: 90, to: { status: 'qualified' } })
    })

    it('identidad desconocida → onUnknown ask', () => {
      const d = evaluate(withIdentityGate(), profile({ identity_match: null }))
      expect(d.clarification?.topics).toEqual(['identity_fields'])
      expect(d.evaluation.gates.find((g) => g.id === 'identity')).toMatchObject({ outcome: 'unknown', effect: 'needs_clarification', ask: 'identity_fields' })
    })

    it('descuadre o banderas rojas → revisión humana', () => {
      expect(evaluate(policy, profile({ integrity_ok: false })).status).toBe('human_review')
      expect(evaluate(policy, profile({ integrity_ok: null })).status).toBe('human_review')
      expect(evaluate(policy, profile({ red_flags: ['garnishment'] })).status).toBe('human_review')
    })

    it('atraso con el prestamista → no califica; el siguiente paso dice cuánto regularizar', () => {
      const d = evaluate(policy, profile({ existing_exposure_days_past_due: 45, existing_exposure_past_due_amount: 30000 }))
      expect(d.status).toBe('not_qualified')
      expect(codes(d)).toContain('gate_no_arrears')
      expect(d.next_steps[0]).toMatchObject({
        code: 'pass_gates',
        feature: 'existing_exposure_days_past_due',
        current_value: 45,
        target_value: 0,
        related: [{ feature: 'existing_exposure_past_due_amount', current_value: 30000, target_value: 0 }],
        to: { status: 'qualified' },
      })
    })

    it('sin dato de créditos vigentes la compuerta de atraso pasa (onUnknown pass)', () => {
      expect(evaluate(policy, profile({ existing_exposure_days_past_due: null })).status).toBe('qualified')
    })

    it('not_qualified gana a human_review y a needs_clarification', () => {
      const d = evaluate(policy, profile({ existing_exposure_days_past_due: 10, integrity_ok: false, document_age_days: 200 }))
      expect(d.status).toBe('not_qualified')
      expect(d.clarification).toBeNull()
    })
  })

  describe('topes y bandas', () => {
    it('un mes de historia topa en qualified_with_limit y la línea baja a la banda de 25 %', () => {
      const d = evaluate(policy, profile({ months_of_history: 1 }))
      expect([d.status, d.limit]).toEqual(['qualified_with_limit', 75000])
      expect(codes(d)).toContain('cap_months_of_history')
      expect(d.next_steps[0]).toMatchObject({ code: 'cap_months_of_history', current_value: 1, target_value: 3, to: { status: 'qualified' } })
    })

    it('sin pagos del comprador: tope aunque el puntaje dé la banda alta (escenario 11)', () => {
      const d = evaluate(policy, profile({ buyer_payments_count: 0 }))
      expect([d.score, d.band?.status, d.status]).toEqual([75, 'qualified', 'qualified_with_limit'])
    })

    it('un tope sobre una feature desconocida aplica (conservador)', () => {
      expect(evaluate(policy, profile({ months_of_history: null })).status).toBe('qualified_with_limit')
    })

    it('sin contrafactual de una sola dimensión cuando ninguna alcanza sola la banda siguiente', () => {
    const d = evaluate(policy, profile({ operating_income_monthly: 40000, buyer_payments_count: 0, payment_capacity_pct: 0.05, recurring_income_share: 0.1 }))
    expect([d.status, d.next_steps]).toEqual(['not_qualified', []])
  })

  it('puntaje bajo no califica y propone cuánto ingreso o cuánto menos pedir', () => {
      const d = evaluate(policy, profile({ operating_income_monthly: 40000, buyer_payments_count: 2, payment_capacity_pct: 0.3, recurring_income_share: 0.3 }))
      expect([d.status, d.score]).toEqual(['not_qualified', 36.25])
      const step = d.next_steps.find((s) => s.code === 'improve_capacity')
      expect(step?.to.status).toBe('qualified_with_limit')
      expect(d.next_steps.map((s) => s.code)).toContain('reduce_requested_amount')
    })
  })

  describe('línea', () => {
    it('la exposición vigente reduce la línea (escenario 5)', () => {
      const d = evaluate(policy, profile({ existing_exposure_balance: 400000 }))
      expect([d.status, d.limit]).toEqual(['qualified', 50000])
      expect(codes(d)).toContain('existing_exposure')
      expect(d.evaluation.limit?.terms).toEqual([
        { term: 'band', value: 150000 },
        { term: 'debt_capacity - existing_exposure_balance', value: 50000 },
        { term: 'program_available_limit', value: null },
      ])
    })

    it('el cupo del programa topa la línea (escenario 10)', () => {
      const d = evaluate(policy, profile({ program_available_limit: 20000 }))
      expect([d.status, d.limit]).toEqual(['qualified', 20000])
      expect(codes(d)).toContain('program_limit')
    })

    it('sin línea disponible no califica aunque el puntaje alcance', () => {
      const d = evaluate(policy, profile({ existing_exposure_balance: 500000 }))
      expect([d.status, d.limit]).toEqual(['not_qualified', null])
      expect(codes(d)).toContain('no_available_line')
    })

    it('sin dato de exposición se toma 0 y se dice', () => {
      const d = evaluate(policy, profile({ existing_exposure_balance: null }))
      expect(d.limit).toBe(150000)
      expect(codes(d)).toContain('assumed_zero_existing_exposure_balance')
    })
  })

  describe('docs/04 §5: nunca decidir sobre lo no verificado', () => {
    it('ingresos no verificados que cambian la banda → revisión humana', () => {
      const d = evaluate(policy, profile({ operating_income_monthly: 300000, buyer_payments_count: 0 }, { operating_income_monthly: { verification: 'unverified' } }))
      expect(d.status).toBe('human_review')
      expect(codes(d)).toContain('decision_depends_on_unverified')
      expect(d.evaluation.dimensions.find((x) => x.id === 'capacity')).toMatchObject({ used: false, excluded_reason: 'unverified', points: 0 })
    })

    it('confianza baja en la clasificación → se pregunta por los abonos', () => {
      const d = evaluate(policy, profile({}, { operating_income_monthly: { confidence: 0.6 } }))
      expect(d.status).toBe('needs_clarification')
      expect(d.clarification?.topics).toEqual(['deposit_classification'])
    })

    it('un dato dudoso que no cambia la banda no detiene la decisión', () => {
      const d = evaluate(policy, profile({}, { recurring_income_share: { verification: 'conflict' } }))
      expect([d.status, d.score]).toEqual(['qualified', 90])
      expect(codes(d)).not.toContain('decision_depends_on_unverified')
    })

    it('una compuerta sobre un dato no verificado ni pasa ni reprueba', () => {
      const d = evaluate(policy, profile({}, { integrity_ok: { verification: 'unverified' } }))
      expect(d.status).toBe('human_review')
      const idd = evaluate(withIdentityGate(), profile({}, { identity_match: { verification: 'conflict' } }))
      expect([idd.status, idd.clarification?.topics]).toEqual(['needs_clarification', ['identity_fields']])
    })

    it('un tope sobre un dato no verificado que cambia el estado → aclaración o revisión', () => {
      const d = evaluate(policy, profile({ months_of_history: 1 }, { months_of_history: { verification: 'unverified' } }))
      expect([d.status, d.clarification?.topics]).toEqual(['needs_clarification', ['additional_months']])
    })
  })

  it('sin rondas de aclaración disponibles → revisión humana', () => {
    const d = evaluate(policy, profile({ document_age_days: 120 }), { clarificationRoundsUsed: 2 })
    expect(d.status).toBe('human_review')
    expect(codes(d)).toContain('clarification_rounds_exhausted')
  })

  it('cada contrafactual da exactamente el resultado que dice', () => {
    const cases: Values[] = [{ months_of_history: 1 }, { document_age_days: 300, identity_match: null }, { existing_exposure_days_past_due: 15 }, { operating_income_monthly: 50000, buyer_payments_count: 1 }]
    for (const v of cases) {
      const p = profile(v)
      const d = evaluate(policy, p)
      expect(d.next_steps.length, JSON.stringify(v)).toBeGreaterThan(0)
      for (const s of d.next_steps) {
        const to = evaluate(policy, withFeatures(p, [{ feature: s.feature, value: s.target_value }, ...s.related.map((r) => ({ feature: r.feature, value: r.target_value }))]))
        expect({ status: to.status, score: to.score, limit: to.limit }, s.code).toEqual(s.to)
      }
    }
  })
})

describe('plantilla y políticas versionadas', () => {
  it('clonar la plantilla no la modifica', () => {
    const tenant = clonePolicy(basePolicyTemplate(), { version: 2, name: 'Fintech Demo v2' })
    tenant.gates.pop()
    expect(basePolicyTemplate().gates).toHaveLength(4)
    expect(tenant.version).toBe(2)
  })

  it('todas las políticas de policies/ son válidas', () => {
    const root = new URL('../../../../policies/', import.meta.url)
    const files = readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const res = parsePolicy(JSON.parse(readFileSync(new URL(f, root), 'utf8')))
      expect(res.ok, `${f}: ${res.ok ? '' : res.message}`).toBe(true)
    }
  })
})
