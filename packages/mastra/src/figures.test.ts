import { describe, expect, it } from 'vitest'
import { checkFigures, pesos, spanishDate } from './figures.ts'

const facts = [
  { name: 'amount', value: 150000 },
  { name: 'date', value: '2025-06-15' },
  { name: 'description', value: 'SPEI RECIBIDO OPERACION REF 4471' },
  { name: 'income_share', value: 0.42 },
  { name: 'months', value: 3 },
]

describe('filtro de cifras (docs/04 §4)', () => {
  it('acepta cifras y fechas que están en los hechos, en sus formas usuales', () => {
    expect(checkFigures('¿El abono de $150,000.00 del 15 de junio de 2025 (REF 4471) es pago de un cliente?', facts)).toEqual({ ok: true, unsupported: [] })
    expect(checkFigures('El 15 de junio recibiste 150000 pesos; equivale al 42% de tus ingresos en 3 meses.', facts).ok).toBe(true)
    expect(checkFigures('Abono del 2025-06-15 por $150,000', facts).ok).toBe(true)
    expect(checkFigures('Con tres meses de historial', facts).ok).toBe(true)
  })

  it('rechaza cifras inventadas', () => {
    expect(checkFigures('El abono de $151,000.00 del 15 de junio', facts).unsupported).toEqual(['151,000.00'])
    expect(checkFigures('El abono del 16 de junio de 2025', facts).unsupported).toEqual(['16 de junio de 2025'])
    expect(checkFigures('del 15 de junio de 2024', facts).ok).toBe(false)
    expect(checkFigures('en cuatro meses', facts).unsupported).toEqual(['cuatro'])
    expect(checkFigures('unos 150 mil pesos', facts).unsupported).toEqual(['150', 'mil'])
  })

  it('no cuenta identificadores pegados a letras', () => {
    expect(checkFigures('Pregunta q1: ¿el movimiento T20 es tuyo?', facts).ok).toBe(true)
  })

  it('formatea como las plantillas', () => {
    expect(spanishDate('2025-06-15')).toBe('15 de junio de 2025')
    expect(pesos(150000.5)).toBe('$150,000.50')
    expect(checkFigures(`${pesos(150000)} del ${spanishDate('2025-06-15')}`, facts).ok).toBe(true)
  })
})
