import { StatementExtraction } from '@gow/contracts'
import { sampleStatement } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { repairAgainstContract } from './extract.ts'
import { IssueSink } from './issues.ts'

describe('repairAgainstContract', () => {
  it('un campo inválido queda desconocido y una fila inválida se quita; el resto se conserva', () => {
    const doc = sampleStatement()
    const period = doc.accounts[0]?.periods[0]
    if (!period) throw new Error('fixture')
    period.summary.total_debits = { ...period.summary.total_debits, value: -1250.5 }
    const bad = period.transactions[1]
    if (bad) bad.amount = -1
    const res = StatementExtraction.safeParse(doc)
    expect(res.success).toBe(false)
    const issues = new IssueSink()
    const repaired = repairAgainstContract(doc, res.error?.issues ?? [], issues)
    expect(repaired).not.toBeNull()
    expect(repaired?.accounts[0]?.periods[0]?.summary.total_debits.value).toBeNull()
    expect(repaired?.accounts[0]?.periods[0]?.transactions.map((t) => t.id)).toEqual(['a1.p1.t1'])
    expect(repaired?.accounts).toHaveLength(2)
    expect(issues.issues.map((i) => i.code)).toEqual(['missing_required_field', 'missing_required_field'])
  })
})
