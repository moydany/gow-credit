import { describe, expect, it } from 'vitest'
import { same, verdict } from './corrections.ts'

describe('eval de correcciones del analista', () => {
  it('clasifica lo que lee el modelo actual frente al par leído/correcto', () => {
    expect(verdict(1300, 1250.5, 1300)).toBe('fixed')
    expect(verdict(1250.5, 1250.5, 1300)).toBe('same_error')
    expect(verdict(999, 1250.5, 1300)).toBe('other')
    expect(verdict(null, null, 'Nombre declarado')).toBe('not_in_document')
  })

  it('compara montos al centavo y texto sin mayúsculas ni espacios de más', () => {
    expect(same(10.001, 10)).toBe(true)
    expect(same(10.01, 10)).toBe(false)
    expect(same('  Abono  SPEI ', 'abono spei')).toBe(true)
  })
})
