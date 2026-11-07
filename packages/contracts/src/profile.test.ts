import { describe, expect, it } from 'vitest'
import { DOCUMENT_TAMPER_SIGNALS, FEATURE_CATALOG, FEATURE_CATALOG_VERSION, FEATURE_NAMES } from './features.ts'
import { Profile, ProfileFeatures } from './profile.ts'
import { sampleProfile } from './testing/fixtures.ts'

describe('catálogo y perfil', () => {
  it('el perfil tiene exactamente las features del catálogo', () => {
    expect(Object.keys(ProfileFeatures.shape).sort()).toEqual([...FEATURE_NAMES].sort())
  })

  it('incluye las features que agrega docs/06 §5', () => {
    for (const f of ['existing_exposure_balance', 'existing_exposure_days_past_due', 'existing_exposure_payment_ratio', 'external_debt_signal', 'program_available_limit', 'prior_applications']) {
      expect(FEATURE_CATALOG).toHaveProperty(f)
    }
  })

  it('catálogo 1.1.0: las features del bloque fiscal de docs/09 §5 y §9', () => {
    for (const f of ['fiscal_regime', 'cfdi_sat_status', 'fiscal_anchor_ok', 'statement_reuse_count', 'statement_seen_elsewhere_days', 'sat_list_status', 'income_from_listed_rfc_share', 'regime_income_plausible']) {
      expect(FEATURE_CATALOG).toHaveProperty(f)
    }
  })

  it('catálogo 1.2.0: las señales de robustez documental llegan al motor (ADR 0058)', () => {
    expect(FEATURE_CATALOG_VERSION).toBe('1.2.0')
    expect(FEATURE_CATALOG.document_pages_missing).toMatchObject({ kind: 'bool', source: 'statement' })
    expect(FEATURE_CATALOG.document_tamper_signals).toMatchObject({ kind: 'enum_list', source: 'statement' })
    expect(FEATURE_CATALOG.document_tamper_signals.values).toEqual(DOCUMENT_TAMPER_SIGNALS)
    const p = sampleProfile({ document_pages_missing: true, document_tamper_signals: ['prompt_injection', 'pages_duplicated'] })
    expect(Profile.safeParse(p).success).toBe(true)
    ;(p.features.document_tamper_signals as { value: unknown }).value = ['otra_senal']
    expect(Profile.safeParse(p).success).toBe(false)
  })

  it('el monto vencido existe para que next_steps diga cuánto regularizar (escenario 6)', () => {
    expect(FEATURE_CATALOG.existing_exposure_past_due_amount.kind).toBe('money')
  })

  it('un régimen fiscal fuera de la lista no valida: se normaliza a other al calcular', () => {
    const p = sampleProfile({ fiscal_regime: '626' })
    expect(Profile.safeParse(p).success).toBe(true)
    ;(p.features.fiscal_regime as { value: unknown }).value = '999'
    expect(Profile.safeParse(p).success).toBe(false)
  })

  it('un perfil sin datos es válido: todo desconocido es null', () => {
    expect(Profile.safeParse(sampleProfile()).success).toBe(true)
  })

  it('valida el tipo de cada feature', () => {
    const ok = sampleProfile({ months_of_history: 1, identity_match: 'match', red_flags: [], integrity_ok: true, free_cash_flow_monthly: -1500.25 })
    expect(Profile.safeParse(ok).success).toBe(true)

    const badEnum = sampleProfile()
    ;(badEnum.features.identity_match as { value: unknown }).value = 'unknown'
    const res = Profile.safeParse(badEnum)
    expect(res.success).toBe(false)
    expect(res.error?.issues[0]?.path.join('.')).toBe('features.identity_match.value')

    const badInt = sampleProfile()
    ;(badInt.features.months_of_history as { value: unknown }).value = 2.5
    expect(Profile.safeParse(badInt).success).toBe(false)
  })
})
