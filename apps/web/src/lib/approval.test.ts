import { describe, expect, it } from 'vitest'
import { approvalOf } from './approval'

describe('lo aprobado contra lo pedido (ADR 0053)', () => {
  const line = { limit: 149937.24, reasons: [] }

  it('si lo pedido cabe en la línea se aprueba lo pedido', () => {
    expect(approvalOf(line, 50000)).toEqual({ label: 'Monto aprobado', value: 50000, note: 'Línea disponible hasta $149,937.24 MXN' })
  })

  it('si pide más que la línea se aprueba la línea', () => {
    expect(approvalOf(line, 200000)?.value).toBe(149937.24)
    expect(approvalOf(line, 200000)?.label).toBe('Línea aprobada')
  })

  it('sin monto, o con una decisión tomada a línea máxima, cuenta la línea', () => {
    expect(approvalOf(line, null)?.value).toBe(149937.24)
    expect(approvalOf({ ...line, reasons: [{ code: 'evaluated_at_max_line' }] }, 50000)?.value).toBe(149937.24)
  })

  it('sin línea no hay aprobación', () => {
    expect(approvalOf({ limit: null, reasons: [] }, 50000)).toBeNull()
  })
})
