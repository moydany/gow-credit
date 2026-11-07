import { describe, expect, it } from 'vitest'
import { calendarToday } from './calendar.ts'

describe('hoy del negocio (ADR 0046)', () => {
  it('a las 22:30 del 6 de noviembre en la Ciudad de México es 6, aunque en UTC ya sea 7', () => {
    const late = new Date('2026-11-07T04:30:00Z')
    expect(calendarToday('America/Mexico_City', late)).toBe('2026-11-06')
    expect(calendarToday('UTC', late)).toBe('2026-11-07')
    expect(calendarToday(undefined, late)).toBe('2026-11-06')
  })
})
