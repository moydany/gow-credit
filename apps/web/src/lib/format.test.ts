import { describe, expect, it } from 'vitest'
import { ago, date, featureValue, jsonValue, localToday, money, moneyParts } from './format'

describe('formato es-MX', () => {
  it('muestra montos en pesos mexicanos, con centavos y la moneda', () => {
    expect(money(250000)).toBe('$250,000.00 MXN')
    expect(money(149937)).toBe('$149,937.00 MXN')
    expect(money(1234.5)).toBe('$1,234.50 MXN')
    expect(money(null)).toBe('—')
    expect(moneyParts(149937)).toEqual({ amount: '$149,937.00', currency: 'MXN' })
    expect(moneyParts(null)).toEqual({ amount: '—', currency: null })
  })

  it('una fecha sin hora no se corre por zona horaria', () => {
    expect(date('2026-03-01')).toMatch(/1/)
    expect(date('2026-03-01')).not.toMatch(/feb/i)
    expect(date(null)).toBe('—')
  })

  it('un instante con hora se muestra en la zona del navegador, no en UTC', () => {
    // 22:30 on November 6 in the zone of whoever runs the test; in UTC it may already be the 7th.
    const lateNight = new Date(2026, 10, 6, 22, 30)
    expect(date(lateNight.toISOString())).toMatch(/\b6\b/)
    expect(date(lateNight.toISOString())).not.toMatch(/\b7\b/)
    expect(localToday(lateNight)).toBe('2026-11-06')
    expect(localToday(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05')
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
