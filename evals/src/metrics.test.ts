import { describe, expect, it } from 'vitest'
import type { GtTransaction } from './ground-truth/schema.ts'
import { containment, descriptionMatches, matchTransactions, scoreField, type FlatTx } from './metrics.ts'

const gt = (o: Partial<GtTransaction>): GtTransaction => ({
  page: 2,
  date: '2025-09-01',
  description: 'T17 SPEI ENVIADO STP 3108250Pago Ref. 0047732135',
  description_head: 'T17 SPEI ENVIADO STP',
  reference: null,
  amount: 1622.8,
  type: 'debit',
  balance: null,
  internal_transfer: false,
  provenance: ['text_layer'],
  ...o,
})
const ex = (o: Partial<FlatTx>): FlatTx => ({ page: 2, date: '2025-09-01', description: 'SPEI ENVIADO STP', reference: '0047732135', amount: 1622.8, type: 'debit', balance: null, internal_transfer: false, ...o })

describe('descripción difusa', () => {
  it('no importa si la referencia va en description o en reference', () => {
    expect(descriptionMatches(gt({}), { description: 'SPEI ENVIADO STP 3108250Pago Ref. 0047732135', reference: null })).toBe(true)
    expect(descriptionMatches(gt({}), { description: 'SPEI ENVIADO STP', reference: '3108250Pago Ref. 0047732135' })).toBe(true)
  })
  it('tolera palabras pegadas en la capa de texto', () => {
    expect(containment('SPEI RECIBIDOCITI', 'SPEI RECIBIDO CITI')).toBe(1)
  })
  it('rechaza la descripción de otra fila', () => {
    expect(descriptionMatches(gt({}), { description: 'PAGO CUENTA DE TERCERO BNET Gastos', reference: null })).toBe(false)
  })
  it('rechaza texto inventado añadido a la descripción', () => {
    expect(descriptionMatches(gt({ description: 'DEPOSITO SPEI', description_head: 'DEPOSITO SPEI' }), { description: 'DEPOSITO SPEI pago de nómina de la empresa Ejemplo factura 99', reference: null })).toBe(false)
  })
})

describe('emparejamiento de movimientos', () => {
  it('separa invención y omisión', () => {
    const g = [gt({}), gt({ amount: 500, date: '2025-09-02' })]
    const e = [ex({}), ex({ amount: 77.77, date: '2025-09-05', description: 'OTRA COSA' })]
    const m = matchTransactions(g, e)
    expect(m.pairs).toHaveLength(1)
    expect(m.invented).toHaveLength(1)
    expect(m.omitted).toHaveLength(1)
  })
  it('una fila duplicada cuenta como invención', () => {
    const m = matchTransactions([gt({})], [ex({}), ex({})])
    expect(m.invented).toHaveLength(1)
    expect(m.omitted).toHaveLength(0)
  })
  it('un monto mal leído se empareja como lectura errónea, no como invención más omisión', () => {
    const m = matchTransactions([gt({})], [ex({ amount: 1622.08 })])
    expect(m.pairs[0]?.kind).toBe('loose')
    expect(m.invented).toHaveLength(0)
  })
  it('un sentido invertido también es lectura errónea', () => {
    const m = matchTransactions([gt({})], [ex({ type: 'credit' })])
    expect(m.pairs[0]?.kind).toBe('loose')
  })
})

describe('campos', () => {
  it('un valor donde el banco no imprime nada (redactado) es invención', () => {
    expect(scoreField('holder.name', null, 'JUAN PEREZ', 'must_be_null')).toEqual({ field: 'holder.name', ok: false, invented: true })
    expect(scoreField('holder.name', null, null, 'must_be_null')?.ok).toBe(true)
    expect(scoreField('cfdi.subtotal', null, 10, 'skip')).toBeNull()
  })
  it('compara por dígitos, identificador y fecha-hora', () => {
    expect(scoreField('n', '65--4', '65-****-4', 'must_be_null', 'digits')?.ok).toBe(true)
    expect(scoreField('rfc', 'HMI950125KG8', 'HMI-950125-KG8', 'skip', 'id')?.ok).toBe(true)
    expect(scoreField('t', '2025-08-06T03:06:55', '2025-08-06T03:06:55-06:00', 'skip', 'datetime')?.ok).toBe(true)
    expect(scoreField('m', 258.1, 258.01, 'skip', 'money')?.ok).toBe(false)
  })
})
