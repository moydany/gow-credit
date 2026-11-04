import { fiscalDocument, missing } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { crossCheckFiscal, parseLocalDateTime } from './fiscal.ts'
import { IssueSink } from './issues.ts'

const holder = (rfc: string | null, type: 'legal_entity' | 'individual' | null = 'legal_entity') => ({
  rfc: rfc === null ? missing() : { value: rfc, source: { page: 1, snippet: rfc }, verification: 'verified' as const, confidence: 0.95, provenance: 'extracted' as const },
  holder_type: type === null ? missing() : { value: type, source: null, verification: 'unverified' as const, confidence: 0.7, provenance: 'extracted' as const },
})

describe('parseLocalDateTime', () => {
  it.each([
    ['2025-02-01T10:12:33', '2025-02-01T10:12:33'],
    ['2025-02-01 10:12:33', '2025-02-01T10:12:33'],
    ['06/08/2025 03:06:55 AM', '2025-08-06T03:06:55'],
    ['06/08/2025 03:06:55 PM', '2025-08-06T15:06:55'],
    ['ayer', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseLocalDateTime(raw)).toBe(expected)
  })
})

describe('crossCheckFiscal (docs/09 §4)', () => {
  it('verifica UUID, certificado y totales cuando cruzan', () => {
    const f = fiscalDocument()
    const issues = new IssueSink()
    crossCheckFiscal([f], holder('XAXX010101000'), [], issues)
    expect(issues.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(f.uuid.verification).toBe('verified')
    expect(f.total.verification).toBe('verified')
    expect(f.receiver.rfc.verification).toBe('verified')
  })

  it('UUID distinto al de la cadena original es error y queda en conflicto', () => {
    const f = fiscalDocument()
    f.original_chain.uuid = { ...f.original_chain.uuid, value: 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5C' }
    const issues = new IssueSink()
    crossCheckFiscal([f], holder(null), [], issues)
    expect(issues.issues.map((i) => [i.code, i.severity])).toContainEqual(['fiscal_chain_mismatch', 'error'])
    expect(f.uuid.verification).toBe('conflict')
  })

  it('total distinto de subtotal + IVA es error', () => {
    const f = fiscalDocument()
    f.total = { ...f.total, value: 280 }
    const issues = new IssueSink()
    crossCheckFiscal([f], holder(null), [], issues)
    expect(issues.issues.find((i) => i.code === 'fiscal_totals_mismatch' && i.severity === 'error')?.message).toContain('= 278.4, pero el total impreso es 280')
  })

  it('el RFC enmascarado del encabezado es compatible con el completo del CFDI', () => {
    const f = fiscalDocument()
    f.receiver.rfc = { ...f.receiver.rfc, value: 'COM850101AB1' }
    const issues = new IssueSink()
    crossCheckFiscal([f], holder('COM******AB1'), [], issues)
    expect(issues.count('fiscal_receiver_mismatch')).toBe(0)
  })

  it('régimen 616 contra un titular persona moral deja el tipo de persona sin verificar', () => {
    const f = fiscalDocument()
    f.receiver.tax_regime = { ...f.receiver.tax_regime, value: '616' }
    const h = holder('XAXX010101000', 'legal_entity')
    const issues = new IssueSink()
    crossCheckFiscal([f], h, [], issues)
    expect(issues.issues.find((i) => i.code === 'fiscal_receiver_mismatch')?.severity).toBe('warning')
    expect(h.holder_type.verification).toBe('unverified')
  })

  it('avisa si el timbrado queda lejos del fin del periodo (docs/09 §9.6)', () => {
    const f = fiscalDocument()
    const period = { period_end: { value: '2026-01-31' }, statement_date: { value: null }, summary: { fees_charged: { value: null } } } as unknown as Parameters<typeof crossCheckFiscal>[2][number]
    const issues = new IssueSink()
    crossCheckFiscal([f], holder(null), [period], issues)
    expect(issues.issues.find((i) => i.code === 'date_out_of_period')?.message).toContain('a 60 días del fin del periodo')
  })

  it('un receptor vacío (como Hey) no se cruza ni se rellena', () => {
    const f = fiscalDocument()
    f.receiver.rfc = missing()
    const issues = new IssueSink()
    crossCheckFiscal([f], holder('XAXX010101000'), [], issues)
    expect(f.receiver.rfc.value).toBeNull()
    expect(issues.count('fiscal_receiver_mismatch')).toBe(0)
  })
})
