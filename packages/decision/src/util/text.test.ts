import { describe, expect, it } from 'vitest'
import { compareName } from '../features/statement.ts'
import { editDistance, nameSimilarity, sameNameToken } from './text.ts'

describe('comparación de nombres con acentos y typos', () => {
  it('acentos, mayúsculas, puntuación y sufijos societarios no cuentan', () => {
    expect(compareName('COMERCIALIZADORA ÑANDÚ, S.A. DE C.V.', 'Comercializadora Nandu SA de CV')).toBe('match')
    expect(compareName('José Pérez Gómez', 'JOSE PEREZ GOMEZ')).toBe('match')
  })

  it('un typo por palabra se tolera desde 5 letras', () => {
    expect(compareName('Comercialisadora del Norte', 'Comercializadora del Norte')).toBe('match')
    expect(compareName('Distribuidroa Nandu', 'Distribuidora Nandu')).toBe('match')
    // A single significant word: a typo used to give a mismatch and sink the match even if the RFC agreed.
    expect(compareName('Comercialisadora SA de CV', 'Comercializadora SA de CV')).toBe('match')
  })

  it('palabras cortas y nombres distintos no se confunden', () => {
    expect(sameNameToken('ABC', 'ABD')).toBe(false)
    expect(sameNameToken('NORTE', 'NORTA')).toBe(true)
    expect(sameNameToken('NORTE', 'SUREÑO')).toBe(false)
    expect(compareName('Comercializadora del Sur', 'Comercializadora del Norte')).toBe('partial')
    expect(compareName('Ferretería Hidalgo', 'Abarrotes Morelos')).toBe('mismatch')
  })

  it('cada palabra se empareja una vez y la exacta tiene prioridad', () => {
    expect(nameSimilarity('Grupo Grupa', 'Grupo')).toBe(1)
    expect(nameSimilarity('Lopez Lopes', 'Lopez Garcia')).toBe(0.5)
  })

  it('distancia de edición con transposición y corte', () => {
    expect(editDistance('ABCD', 'ABDC', 2)).toBe(1)
    expect(editDistance('KITTEN', 'SITTING', 5)).toBe(3)
    expect(editDistance('A', 'ABCDEFG', 2)).toBe(3)
  })
})
