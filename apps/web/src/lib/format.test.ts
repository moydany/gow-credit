import { describe, expect, it } from 'vitest'
import { ago, date, featureValue, jsonValue, money } from './format'

describe('formato es-MX', () => {
  it('muestra montos con peso y sin decimales salvo que se pidan', () => {
    expect(money(250000)).toMatch(/250,000/)
    expect(money(1234.5, true)).toMatch(/1,234\.50/)
    expect(money(null)).toBe('—')
  })

  it('una fecha sin hora no se corre por zona horaria', () => {
    expect(date('2026-03-01')).toMatch(/1/)
    expect(date('2026-03-01')).not.toMatch(/feb/i)
    expect(date(null)).toBe('—')
  })

  it('el tiempo relativo habla en español', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')
    expect(ago('2026-11-05T11:55:00Z', now)).toMatch(/5/)
    expect(ago('2026-11-05T11:59:50Z', now)).toBe('ahora')
  })

  it('los valores del perfil siguen la unidad del catálogo', () => {
    expect(featureValue('months_of_history', 7)).toBe('7 meses')
    expect(featureValue('payment_capacity_pct', 0.25)).toMatch(/25/)
    expect(featureValue('identity_match', 'mismatch')).toBe('No coincide')
    expect(featureValue('integrity_ok', true)).toBe('Sí')
    expect(featureValue('buro_score', null)).toBe('—')
  })

  it('los umbrales de las reglas se leen en español', () => {
    expect(jsonValue(['match', 'partial'])).toBe('Coincide, Parcial')
    expect(jsonValue(true)).toBe('Sí')
    expect(jsonValue(90)).toBe('90')
  })
})
