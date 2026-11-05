import { describe, expect, it } from 'vitest'
import { locate, norm } from './locate'

const page = norm('ESTADO DE CUENTA 04/02/2026 PAGO A TERCEROS REF. 0426020100492978 SUC C 0342 CAJA -17,000.00 SALDO 229,397.41')

describe('locate: ubicar el fragmento citado en la capa de texto', () => {
  it('encuentra el fragmento completo sin importar mayúsculas, acentos ni espacios', () => {
    const hit = locate(page, 'Pago a terceros REF. 0426020100492978')
    expect(hit).not.toBeNull()
    expect(page.slice(hit?.start, hit?.end)).toBe(norm('Pago a terceros REF. 0426020100492978'))
  })

  it('si el PDF parte el texto distinto, cae al inicio, al final o al token más largo', () => {
    // El fragmento citado trae una palabra que la capa de texto no tiene; el inicio sí está.
    expect(locate(page, 'PAGO A TERCEROS REF. 0426020100492978 palabra-que-no-esta-en-el-pdf')).not.toBeNull()
    expect(locate(page, 'texto ajeno 0426020100492978')).not.toBeNull()
  })

  it('devuelve null cuando nada coincide o el fragmento no tiene contenido', () => {
    expect(locate(page, 'XYZ nada parecido')).toBeNull()
    expect(locate(page, '   ')).toBeNull()
  })
})
