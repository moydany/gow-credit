import { describe, expect, it } from 'vitest'
import { prng, sampleRows } from './review.ts'
import type { GroundTruth } from './schema.ts'

const tx = (page: number) => ({ page, date: '2025-01-01', description: 'x', description_head: 'x', reference: null, amount: 1, type: 'credit', balance: null, internal_transfer: false, provenance: ['text_layer'] })
const gt = {
  sha256: 'ab'.repeat(32),
  accounts: [{ key: 'a1', periods: [{ key: 'a1.p1', transactions: [tx(1), tx(1), tx(1), tx(2), tx(3), tx(3), tx(3), tx(3), tx(3), tx(3)] }] }],
} as unknown as GroundTruth

describe('muestra del ground truth para revisión humana', () => {
  it('la misma semilla da la misma muestra', () => {
    expect(sampleRows(gt, 4, 7).map((r) => r.ref)).toEqual(sampleRows(gt, 4, 7).map((r) => r.ref))
    expect(prng(1)()).toBe(prng(1)())
  })

  it('cubre cada página con movimientos antes de llenar al azar, y no repite filas', () => {
    const rows = sampleRows(gt, 4, 7)
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.page))).toEqual(new Set([1, 2, 3]))
    expect(new Set(rows.map((r) => r.ref)).size).toBe(4)
    expect(rows[0]?.ref).toMatch(/^a1\.p1\.\d+$/)
  })

  it('no pide más filas de las que hay', () => {
    expect(sampleRows(gt, 50, 7)).toHaveLength(10)
  })
})
