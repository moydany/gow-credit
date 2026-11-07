/**
 * El workflow completo con dobles: extracción sintética, sin modelos, libSQL en un archivo
 * temporal. Pausar en una instancia de Mastra y reanudar en otra sobre el mismo archivo es lo que
 * hace `pnpm run evaluate --answers` entre dos invocaciones.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFailure, DOCUMENT_AGE_WARNING, PDF_PASSWORD_FAILURE, type ApplicationRequest, type StatementExtraction, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { ZERO_USAGE, type StructuredLlm, type TransactionClassifier } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { MemoryChannel } from './channels.ts'
import { renderReport, toApplicationResult } from './report.ts'
import { createRuntime, resumeApplication, startApplication, WORKFLOW_ID } from './runtime.ts'
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
// Al aclarar el abono grande, otro abono incierto pasa a mover el resultado: segunda ronda (ADR 0051).
DOCS['dos-rondas.pdf'] = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 80000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }, { kind: 'cash_deposit', amount: 50000 }] },
  holder,
  'wf3',
)
// Tres meses sanos con pagos de Cadena Norte; la solicitud no dice el comprador (ADR 0050).
DOCS['sin-comprador.pdf'] = syntheticStatement(
  { start: '2026-07-01', months: 3, opening_balance: 400000, monthly: [{ kind: 'customer_payment', amount: 300000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 120000 }] },
  holder,
  'wf3',
)
DOCS['factura.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), classification: { document_type: 'invoice', confidence: 0.95, bank: null } }
// El clasificador se equivocó pero la extracción terminó a medias, o falló por sí misma (ADR 0042, cambios).
DOCS['factura-parcial.pdf'] = { ...DOCS['factura.pdf'], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'partial' } }
DOCS['factura-fallida.pdf'] = { ...DOCS['factura.pdf'], accounts: [], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'failed', failure_reason: 'no se obtuvo el resumen del documento (pasada 1)' } }
// Clasificado como estado de cuenta, pero el extractor puso la bandera después de extraer.
DOCS['marcado-por-el-extractor.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), flags: ['not_a_bank_statement'] }
// Lo que devuelve la extracción del modo full cuando corta antes de extraer (ADR 0042).
DOCS['tdc.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), classification: { document_type: 'credit_card_statement', confidence: 1, bank: null }, flags: ['not_a_bank_statement'], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'failed', failure_reason: 'no es un estado de cuenta bancario (credit_card_statement); no se extrajo' } }

// ADR 0049: un PDF con contraseña y uno escaneado que la visión no pudo leer.
const CLARO = DOCS['claro.pdf'] as StatementExtraction
DOCS['contrasena.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, accounts: [], extraction: { ...CLARO.extraction, status: 'failed', failure_reason: PDF_PASSWORD_FAILURE } }
DOCS['escaneado.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, accounts: [], flags: ['vision_only'], extraction: { ...CLARO.extraction, status: 'failed', failure_reason: 'no se obtuvo el resumen del documento (pasada 1)' } }
DOCS['escaneado-leido.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, flags: ['vision_only'] }

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
    // Lo enviado sobrevive a la reanudación en otro proceso.
    expect(second.state?.asked).toEqual(first.state?.questions)
    expect(second.state?.calls).toEqual(first.state?.calls)
  })

  it('sin comprador pregunta por el cliente principal y usa la respuesta como comprador (ADR 0050)', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('sin-comprador.pdf', { request: { ...request, buyer: null } }))
    expect(first.status).toBe('suspended')
    expect(first.state?.questions.map((q) => q.kind)).toEqual(['buyer'])
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'buyer', name: 'Cadena Norte SA de CV' }], base_dir: null })
    expect(second.error).toBeNull()
    expect(second.state?.declarations).toEqual({ buyer: 'Cadena Norte SA de CV', account_use: null, answered: ['main_buyer'] })
    const d = second.state?.decision
    expect(d?.status).toBe('qualified')
    expect(d?.profile.features.buyer_payments_count).toMatchObject({ value: 6, provenance: 'owner_answer' })
    expect(d?.explanation?.text).toMatch(/cliente principal que dijo el proveedor/)
  })

  it('la redacción y su costo sobreviven a la reanudación', async () => {
    const file = db()
    const llm: StructuredLlm = {
      call: (req) => {
        const ids = [...req.instruction.matchAll(/"id": "([a-z0-9]+)"/g)].map((m) => m[1] ?? '')
        return Promise.resolve({ object: req.schema.parse({ texts: ids.map((id) => ({ id, text: '¿Qué fue ese abono?' })) }), usage: ZERO_USAGE, costUsd: 0.0002, latencyMs: 1, model: 'claude-haiku-5-5', finishReason: 'stop', responseCacheHit: false })
      },
    }
    const first = await startApplication(createRuntime({ ...deps(), writer: new Writer(llm) }, file), input('dudoso.pdf'))
    expect(first.state?.asked[0]?.text_source).toBe('writer')
    const second = await resumeApplication(createRuntime({ ...deps(), writer: new Writer(llm) }, file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }], base_dir: null })
    const purposes = second.state?.calls.map((c) => c.purpose)
    expect(purposes).toEqual(['clarification_questions', 'next_steps', 'explanation'])
    expect(second.state?.decision?.explanation?.text_source).toBe('writer')
    expect(second.state?.asked[0]?.text).toBe('¿Qué fue ese abono?')
  })

  it('si el dueño no sabe, no se le pregunta lo mismo en otra ronda: va a revisión humana (ADR 0051)', async () => {
    const file = db()
    const channel = new MemoryChannel()
    const first = await startApplication(createRuntime(deps(channel), file), input('dudoso.pdf'))
    const second = await resumeApplication(createRuntime(deps(channel), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'decline', note: null }], base_dir: null })
    expect(second.status).toBe('success')
    expect(second.state?.decision?.status).toBe('human_review')
    expect(second.state?.decision?.reasons.map((r) => r.code)).toContain('clarification_already_asked')
    expect(channel.sent).toHaveLength(1)
  })

  it('una segunda ronda real: pausa otra vez con lo nuevo, se reanuda en otra instancia y decide (ADR 0051)', async () => {
    const file = db()
    const channel = new MemoryChannel()
    const amountOf = (q: { facts: { name: string; value: unknown }[] } | undefined) => q?.facts.find((f) => f.name === 'monto')?.value
    const first = await startApplication(createRuntime(deps(channel), file), input('dos-rondas.pdf'))
    expect(first.status).toBe('suspended')
    expect(first.state?.questions.map(amountOf)).toEqual([150000])
    const second = await resumeApplication(createRuntime(deps(channel), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'deposit', category: 'own_transfer', counterparty: null }], base_dir: null })
    expect(second.status).toBe('suspended')
    expect(second.suspendedStep).toEqual(['clarification-loop', 'ask-owner'])
    expect(second.state?.rounds).toBe(1)
    // Lo nuevo, sin repetir el abono que ya contestó; el canal recibe la ronda 2.
    expect(second.state?.questions.map(amountOf)).toEqual([50000])
    expect(channel.sent.map((m) => m.round)).toEqual([1, 2])
    const third = await resumeApplication(createRuntime(deps(), file), second.runId, second.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }], base_dir: null })
    expect(third.error).toBeNull()
    expect(third.status).toBe('success')
    expect(third.state?.rounds).toBe(2)
    expect(['qualified', 'qualified_with_limit', 'not_qualified']).toContain(third.state?.decision?.status)
  })

  it('si en la segunda ronda tampoco se aclara, se agotan las rondas y va a revisión humana', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('dos-rondas.pdf'))
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'deposit', category: 'own_transfer', counterparty: null }], base_dir: null })
    const third = await resumeApplication(createRuntime(deps(), file), second.runId, second.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'decline', note: null }], base_dir: null })
    expect(third.status).toBe('success')
    expect(third.state?.decision?.status).toBe('human_review')
    expect(third.state?.decision?.reasons.map((r) => r.code)).toContain('clarification_rounds_exhausted')
  })

  it('con una sola ronda en la política, al agotarla va a revisión humana', async () => {
    const file = db()
    const policy = { ...basePolicyTemplate(), clarification: { ...basePolicyTemplate().clarification, maxRounds: 1 } }
    const first = await startApplication(createRuntime(deps(), file), input('dudoso.pdf', { policy }))
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

  it('sin monto solicitado calcula la línea máxima y decide con ella (ADR 0045)', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('claro.pdf', { request: { ...request, amount: null } }))
    const line = r.state?.max_line?.amount ?? 0
    expect(line).toBeGreaterThan(0)
    const d = r.state?.decision
    expect(d?.reasons[0]?.code).toBe('evaluated_at_max_line')
    expect(d?.profile.features.requested_amount.value).toBe(line)
    expect(['qualified', 'qualified_with_limit']).toContain(d?.status)
    expect(d?.reasons.map((x) => x.code)).not.toContain('dimension_capacity_without_data')
    expect(d?.explanation?.text).toMatch(/Como no se pidió un monto, se evaluó con la línea máxima/)
  })

  it('una extracción terminada de un documento que el clasificador llamó factura se analiza y deja una nota (ADR 0042)', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('factura.pdf'))
    expect(r.status).toBe('success')
    expect(r.state?.failure_reason).toBeNull()
    expect(r.state?.decision).not.toBeNull()
    expect(r.state?.notes).toEqual(['El clasificador marcó el documento como invoice con confianza 0.95; se analizó igual'])
    // La clasificación queda tal cual en la extracción que ve el analista.
    expect(r.state?.statements[0]?.classification).toEqual({ document_type: 'invoice', confidence: 0.95, bank: null })
    const result = toApplicationResult('factura', r.state, { workflow: WORKFLOW_ID, run_id: r.runId, status: r.status, suspended_step: r.suspendedStep }, '2026-10-05T12:00:00.000Z', r.error)
    expect(result.status).not.toBe('failed')
    expect(renderReport(result, r.state)).toMatch(/## Avisos del proceso\n\n- El clasificador marcó el documento como invoice con confianza 0.95; se analizó igual/)
  })

  it('una extracción parcial se analiza aunque el clasificador no la llame estado de cuenta', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('factura-parcial.pdf'))
    expect(r.state?.failure_reason).toBeNull()
    expect(r.state?.decision).not.toBeNull()
    expect(r.state?.notes).toHaveLength(1)
  })

  it('si la extracción misma falló, la solicitud falla por la extracción aunque el clasificador diga otra cosa', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('factura-fallida.pdf'))
    expect(r.state?.decision).toBeNull()
    expect(r.state?.notes).toEqual([])
    expect(describeFailure(r.state?.failure_reason ?? null).kind).toBe('extraction_failed')
  })

  it('la bandera del extractor con la extracción terminada no falla la solicitud: la analiza y avisa', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('marcado-por-el-extractor.pdf'))
    expect(r.state?.failure_reason).toBeNull()
    expect(r.state?.decision?.status).toBe('qualified_with_limit')
    expect(r.state?.notes).toEqual(['El extractor marcó el documento como posible no estado de cuenta (bandera not_a_bank_statement); se analizó igual'])
  })

  it('un documento que el modo full no extrajo falla por no ser estado de cuenta, no por la extracción', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('tdc.pdf'))
    expect(r.state?.decision).toBeNull()
    expect(r.state?.failure_reason).toBe('el documento no es un estado de cuenta bancario (credit_card_statement)')
    expect(describeFailure(r.state?.failure_reason ?? null)).toMatchObject({ kind: 'not_bank_statement', documentType: 'credit_card_statement' })
    expect(r.state?.notes).toEqual([])
  })

  it('PDF con contraseña y escaneado ilegible fallan con su motivo; un escaneado leído se analiza (ADR 0049)', async () => {
    const password = await startApplication(createRuntime(deps(), db()), input('contrasena.pdf'))
    expect(describeFailure(password.state?.failure_reason ?? null).kind).toBe('password_protected')
    const scanned = await startApplication(createRuntime(deps(), db()), input('escaneado.pdf'))
    expect(scanned.state?.decision).toBeNull()
    expect(describeFailure(scanned.state?.failure_reason ?? null).kind).toBe('scanned_unreadable')
    const read = await startApplication(createRuntime(deps(), db()), input('escaneado-leido.pdf'))
    expect(read.state?.failure_reason).toBeNull()
    expect(read.state?.decision?.status).toBe('qualified_with_limit')
  })

  it('con el ajuste del tenant, un estado viejo se analiza con advertencia; sin él, se pide uno reciente (ADR 0049)', async () => {
    const old = { as_of: '2027-02-15' }
    const standalone = await startApplication(createRuntime(deps(), db()), input('claro.pdf', old))
    expect(standalone.status).toBe('suspended')
    expect(standalone.state?.decision?.clarification?.topics).toEqual(['recent_statement'])

    const channel = new MemoryChannel()
    const full = await startApplication(createRuntime(deps(channel), db()), input('claro.pdf', { ...old, statement_age: { max_months: 3 } }))
    expect(full.status).toBe('success')
    expect(channel.sent).toHaveLength(0)
    const d = full.state?.decision
    expect(d?.status).toBe('qualified_with_limit')
    expect(d?.reasons.map((r) => r.code)).toContain(DOCUMENT_AGE_WARNING)
    expect(d?.explanation?.text).toMatch(/Aviso: el estado de cuenta tiene \d+ días desde su corte/)

    // Sin monto, la línea máxima tampoco queda condicionada a un estado reciente.
    const noAmount = await startApplication(createRuntime(deps(), db()), input('claro.pdf', { ...old, request: { ...request, amount: null }, statement_age: { max_months: 3 } }))
    expect(noAmount.state?.max_line?.conditional_on).toEqual([])
    expect(noAmount.state?.decision?.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['evaluated_at_max_line', DOCUMENT_AGE_WARNING]))

    const none = await startApplication(createRuntime(deps(), db()), input('claro.pdf', { ...old, statement_age: { max_months: null } }))
    expect(none.state?.decision?.status).toBe('qualified_with_limit')
    expect(none.state?.decision?.reasons.map((r) => r.code)).not.toContain(DOCUMENT_AGE_WARNING)
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
