import { describe, expect, it } from 'vitest'
import { accountTypeSource, currencySource } from './inferred.ts'
import { PageText } from './page-text.ts'

const text = (...pages: string[]) => new PageText({ pageTexts: pages, textLayer: 'ok', textRepaired: false })
const named = (value: string, page = 1) => ({ value, source: { page, snippet: value } })

describe('tipo de cuenta y moneda: verificados con una palabra impresa, que es su fuente', () => {
  it('el nombre del producto dice el tipo: la fuente es la del producto', () => {
    expect(accountTypeSource('savings', named('AHORRO FÁCIL', 3), 2, text('Estado de cuenta'))).toEqual({ page: 3, snippet: 'AHORRO FÁCIL' })
    expect(accountTypeSource('investment', named('Inversión Empresarial'), 2, text(''))).toEqual({ page: 1, snippet: 'Inversión Empresarial' })
  })

  it('con una sola cuenta de ese tipo, basta la palabra en el documento: la fuente es esa línea', () => {
    expect(accountTypeSource('checking', named('MiCuenta'), 1, text('Resumen\nNúmero de cuenta de cheques 7013'))).toEqual({ page: 1, snippet: 'Número de cuenta de cheques 7013' })
  })

  it('con dos cuentas del mismo tipo, la palabra suelta no prueba cuál es', () => {
    expect(accountTypeSource('checking', named('MiCuenta'), 2, text('Número de cuenta de cheques 7013'))).toBeNull()
  })

  it('un producto sin fuente no puede ser la prueba (un valor verificado tiene que citar de dónde sale)', () => {
    expect(accountTypeSource('savings', { value: 'AHORRO', source: null }, 2, text('otra cosa'))).toBeNull()
    expect(accountTypeSource('savings', { value: 'AHORRO', source: null }, 1, text('Cuenta de ahorro'))).toEqual({ page: 1, snippet: 'Cuenta de ahorro' })
  })

  it('sin la palabra, o con texto inservible, sigue sin verificar; "other" nunca se verifica', () => {
    expect(accountTypeSource('checking', named('Cuenta Digital'), 1, text('Saldo al corte'))).toBeNull()
    expect(accountTypeSource('savings', named('AHORRO'), 1, new PageText({ pageTexts: ['AHORRO'], textLayer: 'absent', textRepaired: false }))).toBeNull()
    expect(accountTypeSource('other', named('Otra'), 1, text('otra cosa'))).toBeNull()
  })

  it('la moneda: "Moneda Nacional" o "pesos" para MXN, "dólares" para USD, con la línea impresa', () => {
    expect(currencySource('MXN', text('Resumen', 'Detalle\nEn Pesos Moneda Nacional'))).toEqual({ page: 2, snippet: 'En Pesos Moneda Nacional' })
    expect(currencySource('USD', text('Montos en dólares americanos'))).toEqual({ page: 1, snippet: 'Montos en dólares americanos' })
    expect(currencySource('USD', text('En Pesos Moneda Nacional'))).toBeNull()
    expect(currencySource('EUR', text('euros'))).toBeNull()
  })
})
