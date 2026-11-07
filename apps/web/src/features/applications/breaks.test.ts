import { describe, expect, it } from 'vitest'
import { suggestAmount } from './breaks'

describe('suggestAmount: el monto que hace cuadrar el saldo corrido', () => {
  it('un abono leído de más baja por la diferencia', () => {
    // Fondeadora: 64,901.92 + 84,544.26 = 149,446.18, pero el PDF imprime 99,446.18.
    expect(suggestAmount({ type: 'credit', amount: 84544.26 }, -50000)).toBe(34544.26)
  })

  it('un cargo leído de menos sube por la diferencia', () => {
    expect(suggestAmount({ type: 'debit', amount: 1000 }, -200)).toBe(1200)
  })

  it('sin monto positivo que cuadre no sugiere nada', () => {
    expect(suggestAmount({ type: 'credit', amount: 100 }, -500)).toBeNull()
  })
})
