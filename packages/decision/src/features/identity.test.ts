import { rfcRoot } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import { compareRfc } from './statement.ts'

// RFCs inventados con fecha válida; el dígito verificador no invalida (se reporta).
const REGISTERED_INDIVIDUAL = 'PEGJ850301AB4'
const REGISTERED_COMPANY = 'DNO150304AB1'

describe('RFC sin homoclave (ADR 0043)', () => {
  it('reconoce la raíz de persona física y moral, con fecha válida', () => {
    expect(rfcRoot('pegj 850301')).toBe('PEGJ850301')
    expect(rfcRoot('DNO150304')).toBe('DNO150304')
    expect(rfcRoot('PEGJ851301')).toBeNull()
    expect(rfcRoot(REGISTERED_INDIVIDUAL)).toBeNull()
  })

  it('compara la raíz contra el inicio del RFC registrado', () => {
    expect(compareRfc('PEGJ850301', REGISTERED_INDIVIDUAL)).toBe('root')
    expect(compareRfc('DNO150304', REGISTERED_COMPANY)).toBe('root')
    expect(compareRfc('PEGJ850302', REGISTERED_INDIVIDUAL)).toBe('mismatch')
    // Una raíz de persona física no se compara contra un RFC de persona moral.
    expect(compareRfc('PEGJ850301', REGISTERED_COMPANY)).toBeNull()
  })

  it('el RFC completo sigue comparándose completo', () => {
    expect(compareRfc(REGISTERED_INDIVIDUAL, REGISTERED_INDIVIDUAL)).toBe('match')
    expect(compareRfc('PEGJ850301XY9', REGISTERED_INDIVIDUAL)).toBe('mismatch')
  })
})
