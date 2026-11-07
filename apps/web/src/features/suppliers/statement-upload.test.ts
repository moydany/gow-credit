import { describe, expect, it } from 'vitest'
import { parsePesos } from './StatementUpload'

describe('monto a solicitar en la página del proveedor', () => {
  it('lee pesos como se escriben y rechaza lo demás', () => {
    expect(parsePesos('150000')).toBe(150000)
    expect(parsePesos('$150,000.50')).toBe(150000.5)
    expect(parsePesos('150 mil')).toBe(150000)
    expect(parsePesos('1.2 millones')).toBe(1200000)
    for (const t of ['', 'mucho', '0', '-5', '2000000000']) expect(parsePesos(t)).toBeNull()
  })
})
