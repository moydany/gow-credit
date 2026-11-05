/**
 * El workflow completo con dobles: extracción sintética, sin modelos, libSQL en un archivo
 * temporal. Pausar en una instancia de Mastra y reanudar en otra sobre el mismo archivo es lo que
 * hace `pnpm run evaluate --answers` entre dos invocaciones.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApplicationRequest, StatementExtraction, SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import type { TransactionClassifier } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { MemoryChannel } from './channels.ts'
import { createRuntime, resumeApplication, startApplication } from './runtime.ts'
import type { AppInput } from './state.ts'
import type { WorkflowDeps } from './workflow.ts'
import { Writer } from './writer.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const request: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }

const DOCS: Record<string, StatementExtraction> = {
  'dudoso.pdf': syntheticStatement(
    { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
    holder,
    'wf1',
  ),
  'claro.pdf': syntheticStatement(
    { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] },
    holder,
    'wf2',
  ),
}
DOCS['factura.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), classification: { document_type: 'invoice', confidence: 0.95, bank: null } }

function deps(channel = new MemoryChannel(), classifier: TransactionClassifier | null = null): WorkflowDeps {
  return {
    extract: (path) => {
      const doc = DOCS[path.split('/').at(-1) ?? '']
      if (!doc) throw new Error(`sin documento sintético para ${path}`)
      return Promise.resolve(doc)
    },
    transactionClassifier: classifier,
    writer: new Writer(null),
    channel,
    limit: (task) => task(),
  }
}

function input(file: string, patch: Partial<AppInput> = {}): AppInput {
  return { application_id: file.replace('.pdf', ''), pdf_path: `/docs/${file}`, as_of: '2026-10-05', request, supplier, policy: basePolicyTemplate(), policy_id: 'gow-base.v1', ...patch }
}

const db = () => join(mkdtempSync(join(tmpdir(), 'gow-wf-')), 'mastra.db')

describe('processApplication', () => {
  it('pausa con la pregunta y se reanuda en otra instancia con el archivo de respuestas', async () => {
    const file = db()
    const channel = new MemoryChannel()
    const first = await startApplication(createRuntime(deps(channel), file), input('dudoso.pdf'))
    expect(first.status).toBe('suspended')
    expect(first.suspendedStep).toEqual(['clarification-loop', 'ask-owner'])
    expect(first.state?.decision?.status).toBe('needs_clarification')
    const q = first.state?.questions[0]
    expect(q?.kind).toBe('deposit')
    expect(channel.sent).toHaveLength(1)
    expect(first.state?.decision?.next_steps.every((s) => s.message !== null)).toBe(true)

    // Otro "proceso": instancia nueva sobre el mismo archivo.
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], {
      answers: [{ question_id: q?.id ?? 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }],
      base_dir: null,
    })
    expect(second.error).toBeNull()
    expect(second.status).toBe('success')
    const d = second.state?.decision
    expect(d?.status).toBe('qualified_with_limit')
    expect(second.state?.rounds).toBe(1)
    expect(d?.profile.features.operating_income_monthly.provenance).toBe('owner_answer')
    expect(second.state?.answers).toHaveLength(1)
  })

  it('si el dueño no sabe, la ronda se gasta y va a revisión humana', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('dudoso.pdf'))
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'decline', note: null }], base_dir: null })
    expect(second.state?.decision?.status).toBe('human_review')
    expect(second.state?.decision?.reasons.map((r) => r.code)).toContain('clarification_rounds_exhausted')
  })

  it('sin nada que aclarar no pregunta (guarda del do-until)', async () => {
    const channel = new MemoryChannel()
    const r = await startApplication(createRuntime(deps(channel), db()), input('claro.pdf'))
    expect(r.status).toBe('success')
    expect(r.state?.decision?.status).toBe('qualified_with_limit')
    expect(channel.sent).toHaveLength(0)
    expect(r.state?.max_line).toBeNull()
  })

  it('sin monto solicitado calcula la línea máxima', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('claro.pdf', { request: { ...request, amount: null } }))
    expect(r.state?.max_line?.amount).toBeGreaterThan(0)
  })

  it('un documento que no es estado de cuenta termina sin veredicto y con razón', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('factura.pdf'))
    expect(r.status).toBe('success')
    expect(r.state?.decision).toBeNull()
    expect(r.state?.failure_reason).toContain('no es un estado de cuenta')
  })

  it('el modelo de movimientos entra encima de las reglas; si falla quedan las reglas', async () => {
    const jev: TransactionClassifier = {
      implementation: 'jev',
      model: 'jev-1.13.0',
      calibrated: true,
      fallback: false,
      classifyBatch: (rows) => Promise.resolve({ labels: rows.map((r) => ({ id: r.id, category: r.type === 'credit' ? 'customer_payment' : 'supplier_payment', confidence: 0.93 })), model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0.000001, latencyMs: 1, responseCacheHit: false, promptId: 'jev_classify_transactions.v1' }),
    }
    const ok = await startApplication(createRuntime(deps(new MemoryChannel(), jev), db()), input('dudoso.pdf'))
    expect(ok.state?.classification).toMatchObject({ implementation: 'jev', error: null })
    expect(ok.state?.classification?.classified_by_model).toBeGreaterThan(0)
    // Con el depósito confirmado por Jev ya no hay pregunta.
    expect(ok.status).toBe('success')

    const broken: TransactionClassifier = { ...jev, classifyBatch: () => Promise.reject(new Error('sin red')) }
    const ko = await startApplication(createRuntime(deps(new MemoryChannel(), broken), db()), input('dudoso.pdf'))
    expect(ko.state?.classification?.implementation).toBe('rules')
    expect(ko.state?.notes.join(' ')).toContain('sin red')
    expect(ko.status).toBe('suspended')
  })
})
