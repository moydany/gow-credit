import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationResult, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { describe, expect, it } from 'vitest'
import { MemoryChannel, renderMessage } from './channels.ts'
import { renderReport, toApplicationResult } from './report.ts'
import { createRuntime, startApplication, WORKFLOW_ID } from './runtime.ts'
import { Writer } from './writer.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const doc = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
  holder,
  'rp1',
)

async function paused() {
  const wf = createRuntime({ extract: () => Promise.resolve(doc), transactionClassifier: null, writer: new Writer(null), channel: new MemoryChannel(), limit: (t) => t() }, join(mkdtempSync(join(tmpdir(), 'gow-rp-')), 'm.db'))
  return startApplication(wf, { application_id: 'demo', pdf_path: '/x/demo.pdf', as_of: '2026-10-05', request: { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }, supplier, policy: basePolicyTemplate(), policy_id: 'gow-base.v1' })
}

describe('salidas de evaluate', () => {
  it('una solicitud pausada da un ApplicationResult válido y un reporte con las preguntas', async () => {
    const r = await paused()
    const result = toApplicationResult('demo', r.state, { workflow: WORKFLOW_ID, run_id: r.runId, status: r.status, suspended_step: r.suspendedStep }, '2026-10-05T12:00:00.000Z', r.error)
    expect(ApplicationResult.safeParse(result).success).toBe(true)
    expect(result.status).toBe('needs_clarification')
    expect(result.clarification?.status).toBe('open')
    expect(result.costs.total_usd).toBe(0)
    const md = renderReport(result, r.state)
    for (const h of ['# Solicitud demo', '## Preguntas al proveedor (pendientes)', '## Por qué', '## Compuertas', '## Perfil', '## Extracción', '## Costo', '## Supuestos']) expect(md).toContain(h)
    expect(renderMessage(result.clarification?.questions ?? [])).toMatch(/^Hola\. .*\n\n1\. /s)
  })

  it('un workflow que falló sin estado también deja resultado y reporte', () => {
    const result = toApplicationResult('roto', null, { workflow: WORKFLOW_ID, run_id: 'r1', status: 'failed', suspended_step: null }, '2026-10-05T12:00:00.000Z', 'error de prueba')
    expect([result.status, result.failure_reason, result.decision]).toEqual(['failed', 'error de prueba', null])
    expect(renderReport(result, null)).toContain('**Razón:** error de prueba')
  })
})
