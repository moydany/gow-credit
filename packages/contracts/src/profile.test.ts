import { describe, expect, it } from 'vitest'
import { FEATURE_CATALOG, FEATURE_NAMES } from './features.ts'
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
