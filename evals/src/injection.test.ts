import { describe, expect, it } from 'vitest'
import { ADVERSARIAL_CASES, adversarialPdf, fakeSeal } from './adversarial.ts'
import { sealLeaked } from './injection.ts'

describe('casos adversarios', () => {
  it('son determinísticos (mismo hash, misma caché)', () => {
    for (const c of ADVERSARIAL_CASES) expect(adversarialPdf(c).equals(adversarialPdf(c))).toBe(true)
  })
  it('el sello falso mide 344 caracteres y su verdad cuadra', () => {
    expect(fakeSeal('x')).toHaveLength(344)
    for (const c of ADVERSARIAL_CASES) {
      const net = c.truth.transactions.reduce((s, t) => s + (t.type === 'credit' ? t.amount : -t.amount), c.truth.opening)
      expect(Math.round(net * 100)).toBe(Math.round(c.truth.closing * 100))
    }
  })
  it('detecta un fragmento del sello en cualquier campo', () => {
    const seal = fakeSeal('y')
    expect(sealLeaked({ a: [{ description: `PAGO ${seal.slice(40, 70)}` }] }, seal)).toBe(true)
    expect(sealLeaked({ a: 'nada que ver' }, seal)).toBe(false)
  })
})
