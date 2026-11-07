/**
 * The whole workflow with doubles: synthetic extraction, no models, libSQL in a temp file.
 * Pausing in one Mastra instance and resuming in another over the same file is what
 * `pnpm run evaluate --answers` does between two invocations.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFailure, DOCUMENT_AGE_WARNING, multipleStatementsReason, PDF_PASSWORD_FAILURE, type ApplicationRequest, type StatementExtraction, type SupplierIdentity, parsePolicy } from '@gow/contracts'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { RecordingStructuredLlm, withLlmScope, ZERO_USAGE, type LlmScope, type StructuredLlm, type TransactionClassifier } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { MemoryChannel } from './channels.ts'
import { renderReport, toApplicationResult } from './report.ts'
import { createRuntime, resumeApplication, startApplication, WORKFLOW_ID } from './runtime.ts'
import type { AppInput } from './state.ts'
import type { WorkflowDeps } from './workflow.ts'
import { checkFigures } from './figures.ts'
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
// Clarifying the big deposit makes another uncertain deposit move the result: second round.
DOCS['dos-rondas.pdf'] = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 80000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }, { kind: 'cash_deposit', amount: 50000 }] },
  holder,
  'wf3',
)
// Three healthy months with payments from Cadena Norte; the request does not name the buyer.
DOCS['sin-comprador.pdf'] = syntheticStatement(
  { start: '2026-07-01', months: 3, opening_balance: 400000, monthly: [{ kind: 'customer_payment', amount: 300000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 120000 }] },
  holder,
  'wf3',
)
DOCS['factura.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), classification: { document_type: 'invoice', confidence: 0.95, bank: null } }
// The classifier got it wrong but the extraction finished halfway, or failed on its own.
DOCS['factura-parcial.pdf'] = { ...DOCS['factura.pdf'], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'partial' } }
DOCS['factura-fallida.pdf'] = { ...DOCS['factura.pdf'], accounts: [], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'failed', failure_reason: 'no se obtuvo el resumen del documento (pasada 1)' } }
// Classified as a bank statement, but the extractor set the flag after extracting.
DOCS['marcado-por-el-extractor.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), flags: ['not_a_bank_statement'] }
// What full-mode extraction returns when it cuts before extracting.
DOCS['tdc.pdf'] = { ...(DOCS['claro.pdf'] as StatementExtraction), classification: { document_type: 'credit_card_statement', confidence: 1, bank: null }, flags: ['not_a_bank_statement'], extraction: { ...(DOCS['claro.pdf'] as StatementExtraction).extraction, status: 'failed', failure_reason: 'no es un estado de cuenta bancario (credit_card_statement); no se extrajo' } }

// A password-protected PDF and a scanned one that vision could not read.
const CLARO = DOCS['claro.pdf'] as StatementExtraction
DOCS['contrasena.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, accounts: [], extraction: { ...CLARO.extraction, status: 'failed', failure_reason: PDF_PASSWORD_FAILURE } }
DOCS['escaneado.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, accounts: [], flags: ['vision_only'], extraction: { ...CLARO.extraction, status: 'failed', failure_reason: 'no se obtuvo el resumen del documento (pasada 1)' } }
DOCS['escaneado-leido.pdf'] = { ...CLARO, document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, flags: ['vision_only'] }

// Several statements in one PDF. In standalone the extraction happens and the flag stays; in full
// mode extraction cuts and carries the reason.
const multipleIssue = (details: Record<string, unknown>) =>
  ({ id: 'i90', code: 'multiple_statements', severity: 'error', message: 'El PDF trae más de un estado de cuenta', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details }) as StatementExtraction['issues'][number]
DOCS['varios-estados.pdf'] = { ...CLARO, flags: ['multiple_statements'], issues: [multipleIssue({ documents: 3, restarts_at: [4, 8] })] }
DOCS['varios-estados-sin-issue.pdf'] = { ...CLARO, flags: ['multiple_statements'] }
DOCS['varios-estados-cortado.pdf'] = { ...CLARO, flags: ['multiple_statements'], issues: [multipleIssue({ documents: 2, restarts_at: [3] })], accounts: [], extraction: { ...CLARO.extraction, status: 'failed', failure_reason: multipleStatementsReason(2) } }
// An invoice (cut by the classifier) that also has a pagination restart: the restart wins.
DOCS['varios-estados-y-factura.pdf'] = { ...DOCS['varios-estados-cortado.pdf'], classification: { document_type: 'invoice', confidence: 0.99, bank: null }, flags: ['not_a_bank_statement', 'multiple_statements'] }
// Scanned, partly read by vision and cut by its two CFDI: not "illegible scan".
DOCS['varios-estados-escaneado.pdf'] = { ...DOCS['varios-estados-cortado.pdf'], document: { ...CLARO.document, text_layer: 'absent', route: 'vision_only' }, flags: ['vision_only', 'multiple_statements'] }

// Missing page: the gate asks `missing_pages`; the complete PDF in the answer replaces the
// incomplete one. Different sha256 so it does not count as the same document.
DOCS['sin-pagina.pdf'] = {
  ...CLARO,
  document: { ...CLARO.document, sha256: 'b'.repeat(64) },
  flags: ['pages_missing'],
  issues: [{ id: 'i91', code: 'page_missing', severity: 'warning', message: 'Faltan páginas', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: { missing: [2], total: 3 } }],
}

// ADR 0072: single months for a three-month policy; the copy is the same file sent twice.
const monthOf = (start: string) =>
  syntheticStatement({ start, opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, count: 2, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] }, holder, `mes-${start}`)
DOCS['mes-ago.pdf'] = monthOf('2026-08-01')
DOCS['mes-sep.pdf'] = monthOf('2026-09-01')
DOCS['mes-oct.pdf'] = monthOf('2026-10-01')
DOCS['mes-oct-copia.pdf'] = DOCS['mes-oct.pdf']
const threeMonths = (() => {
  const r = parsePolicy(JSON.parse(readFileSync(new URL('../../../policies/examples/gow-base-tres-meses.v1.json', import.meta.url), 'utf8')))
  if (!r.ok) throw new Error(r.message)
  return r.policy
})()

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

    // Another "process": a new instance over the same file.
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
    // What was sent survives resuming in another process.
    expect(second.state?.asked).toEqual(first.state?.questions)
    expect(second.state?.calls).toEqual(first.state?.calls)
  })

  it('con una página faltante pide el PDF completo y, al llegar, reemplaza al incompleto', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('sin-pagina.pdf'))
    expect(first.status).toBe('suspended')
    expect(first.state?.decision?.status).toBe('needs_clarification')
    const q = first.state?.questions[0]
    expect(q).toMatchObject({ kind: 'documents', topic: 'missing_pages' })
    expect(q?.text).toMatch(/la 2 de 3/)
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: q?.id ?? 'q1', kind: 'documents', paths: ['/docs/claro.pdf'] }], base_dir: null })
    expect(second.error).toBeNull()
    expect(second.status).toBe('success')
    // Only the complete document remains: the profile no longer sees missing pages and the period
    // is not duplicated.
    expect(second.state?.statements.map((s) => s.document.sha256)).toEqual([CLARO.document.sha256])
    expect(second.state?.documents.map((d) => d.origin)).toEqual(['submitted', 'owner_answer'])
    expect(second.state?.notes.some((n) => n.includes('se reemplazaron por el PDF completo'))).toBe(true)
    const d = second.state?.decision
    expect(d?.profile.features.document_pages_missing.value).toBe(false)
    expect(d?.status).not.toBe('needs_clarification')
  })

  it('sin comprador pregunta por el cliente principal y usa la respuesta como comprador', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('sin-comprador.pdf', { request: { ...request, buyer: null } }))
    expect(first.status).toBe('suspended')
    expect(first.state?.questions.map((q) => q.kind)).toEqual(['buyer'])
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'buyer', name: 'Cadena Norte SA de CV' }], base_dir: null })
    expect(second.error).toBeNull()
    expect(second.state?.declarations).toEqual({ buyer: 'Cadena Norte SA de CV', account_use: null, answered: ['main_buyer'] })
    const d = second.state?.decision
    expect(d?.status).toBe('qualified')
    expect(d?.profile.features.buyer_payments_count).toMatchObject({ value: 2, provenance: 'owner_answer' })
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

  it('cada llamada al modelo dentro del workflow queda atribuida a su solicitud, también al reanudar', async () => {
    const file = db()
    const scripted: StructuredLlm = {
      call: (req) => {
        const ids = [...req.instruction.matchAll(/"id": "([a-z0-9]+)"/g)].map((m) => m[1] ?? '')
        return Promise.resolve({ object: req.schema.parse({ texts: ids.map((id) => ({ id, text: '¿Qué fue ese abono?' })) }), usage: ZERO_USAGE, costUsd: 0, latencyMs: 1, model: 'claude-haiku-5-5', finishReason: 'stop', responseCacheHit: false })
      },
    }
    const seen: { purpose: string; scope: LlmScope }[] = []
    const llm = new RecordingStructuredLlm(scripted, { record: (e, scope) => { seen.push({ purpose: e.purpose, scope }); return Promise.resolve() } })
    const scope = { tenantId: 't1', applicationId: 'dudoso' }
    const first = await withLlmScope(scope, () => startApplication(createRuntime({ ...deps(), writer: new Writer(llm) }, file), input('dudoso.pdf')))
    await withLlmScope(scope, () => resumeApplication(createRuntime({ ...deps(), writer: new Writer(llm) }, file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null }], base_dir: null }))
    expect(seen.map((x) => x.purpose)).toEqual(['clarification_questions', 'next_steps', 'explanation'])
    expect(seen.every((x) => x.scope.applicationId === 'dudoso' && x.scope.tenantId === 't1')).toBe(true)
  })

  it('si el dueño no sabe, no se le pregunta lo mismo en otra ronda: va a revisión humana', async () => {
    const file = db()
    const channel = new MemoryChannel()
    const first = await startApplication(createRuntime(deps(channel), file), input('dudoso.pdf'))
    const second = await resumeApplication(createRuntime(deps(channel), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: 'q1', kind: 'decline', note: null }], base_dir: null })
    expect(second.status).toBe('success')
    expect(second.state?.decision?.status).toBe('human_review')
    expect(second.state?.decision?.reasons.map((r) => r.code)).toContain('clarification_already_asked')
    expect(channel.sent).toHaveLength(1)
  })

  it('una segunda ronda real: pausa otra vez con lo nuevo, se reanuda en otra instancia y decide', async () => {
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
    // Only the new, without repeating the deposit already answered; the channel gets round 2.
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

  it('sin monto solicitado calcula la línea máxima y decide con ella', async () => {
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

  it('una extracción terminada de un documento que el clasificador llamó factura se analiza y deja una nota', async () => {
    const r = await startApplication(createRuntime(deps(), db()), input('factura.pdf'))
    expect(r.status).toBe('success')
    expect(r.state?.failure_reason).toBeNull()
    expect(r.state?.decision).not.toBeNull()
    expect(r.state?.notes).toEqual(['El clasificador marcó el documento como invoice con confianza 0.95; se analizó igual'])
    // The classification stays as is in the extraction the analyst sees.
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

  it('PDF con contraseña y escaneado ilegible fallan con su motivo; un escaneado leído se analiza', async () => {
    const password = await startApplication(createRuntime(deps(), db()), input('contrasena.pdf'))
    expect(describeFailure(password.state?.failure_reason ?? null).kind).toBe('password_protected')
    const scanned = await startApplication(createRuntime(deps(), db()), input('escaneado.pdf'))
    expect(scanned.state?.decision).toBeNull()
    expect(describeFailure(scanned.state?.failure_reason ?? null).kind).toBe('scanned_unreadable')
    const read = await startApplication(createRuntime(deps(), db()), input('escaneado-leido.pdf'))
    expect(read.state?.failure_reason).toBeNull()
    expect(read.state?.decision?.status).toBe('qualified_with_limit')
  })

  it('varios estados de cuenta en un PDF no fallan la solicitud: se evalúa el mes más reciente (ADR 0072)', async () => {
    for (const file of ['varios-estados.pdf', 'varios-estados-sin-issue.pdf']) {
      const run = await startApplication(createRuntime(deps(), db()), input(file))
      expect(run.state?.failure_reason, file).toBeNull()
      expect(run.state?.decision, file).not.toBeNull()
    }
    // An extraction that was cut for that reason (rejectMultipleStatements) keeps its own reason.
    for (const file of ['varios-estados-cortado.pdf', 'varios-estados-escaneado.pdf']) {
      const cut = await startApplication(createRuntime(deps(), db()), input(file))
      expect(cut.state?.failure_reason, file).toBe('el PDF trae 2 estados de cuenta')
      expect(cut.state?.decision, file).toBeNull()
      expect(describeFailure(cut.state?.failure_reason ?? null).kind, file).toBe('multiple_statements')
    }
    // Cut early and not a statement: the classification is the reason.
    const invoice = await startApplication(createRuntime(deps(), db()), input('varios-estados-y-factura.pdf'))
    expect(describeFailure(invoice.state?.failure_reason ?? null).kind).toBe('not_bank_statement')
  })

  it('ADR 0072: dos meses y uno repetido piden solo el que falta, por nombre; con él califica', async () => {
    const file = db()
    const send = input('mes-sep.pdf', { extra_pdf_paths: ['/docs/mes-oct.pdf', '/docs/mes-oct-copia.pdf'], policy: threeMonths, policy_id: 'gow-base-tres-meses.v1', as_of: '2026-11-05' })
    const first = await startApplication(createRuntime(deps(), file), send)
    expect(first.state?.decision?.profile.features.months_of_history.value).toBe(2)
    const q = first.state?.questions[0]
    expect(q?.topic).toBe('additional_months')
    expect(q?.text).toBe('Recibimos 2 meses seguidos de estados de cuenta; para evaluarte necesitamos 3 meses seguidos. Nos falta 1, el estado de cuenta con corte en agosto de 2026. ¿Nos lo mandas?')
    expect(checkFigures(q?.text ?? '', q?.facts ?? []).ok).toBe(true)
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: q?.id ?? 'q1', kind: 'documents', paths: ['/docs/mes-ago.pdf'] }], base_dir: null })
    expect(second.state?.decision?.profile.features.months_of_history.value).toBe(3)
    expect(['qualified', 'qualified_with_limit']).toContain(second.state?.decision?.status)
  })

  it('ADR 0072: con un solo mes pide los dos que faltan juntos; si la respuesta no trae meses nuevos no se repite', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('mes-oct.pdf', { policy: threeMonths, policy_id: 'gow-base-tres-meses.v1', as_of: '2026-11-05' }))
    const q = first.state?.questions[0]
    expect(q?.text).toBe('Recibimos 1 mes seguido de estados de cuenta; para evaluarte necesitamos 3 meses seguidos. Nos faltan 2, los estados de cuenta con corte en agosto de 2026 y septiembre de 2026. ¿Nos los mandas juntos, en un solo envío?')
    // The answer brings the same month again: nothing new, so it is not asked a second time.
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: q?.id ?? 'q1', kind: 'documents', paths: ['/docs/mes-oct-copia.pdf'] }], base_dir: null })
    expect(second.state?.decision?.status).toBe('human_review')
    expect(second.state?.decision?.reasons.map((r) => r.code)).toContain('clarification_already_asked')
  })

  it('ADR 0072: si la respuesta trae un mes pero falta otro, pide solo ese', async () => {
    const file = db()
    const first = await startApplication(createRuntime(deps(), file), input('mes-oct.pdf', { policy: threeMonths, policy_id: 'gow-base-tres-meses.v1', as_of: '2026-11-05' }))
    const q = first.state?.questions[0]
    const second = await resumeApplication(createRuntime(deps(), file), first.runId, first.suspendedStep ?? [], { answers: [{ question_id: q?.id ?? 'q1', kind: 'documents', paths: ['/docs/mes-sep.pdf'] }], base_dir: null })
    expect(second.status).toBe('suspended')
    expect(second.state?.questions[0]?.text).toMatch(/^Recibimos 2 meses seguidos[\s\S]*Nos falta 1, el estado de cuenta con corte en agosto de 2026\./)
  })

  it('con el ajuste del tenant, un estado viejo se analiza con advertencia; sin él, se pide uno reciente', async () => {
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

    // With no amount, the maximum line is not conditioned on a recent statement either.
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
    // With the deposit confirmed by Jev there is no question anymore.
    expect(ok.status).toBe('success')

    const broken: TransactionClassifier = { ...jev, classifyBatch: () => Promise.reject(new Error('sin red')) }
    const ko = await startApplication(createRuntime(deps(new MemoryChannel(), broken), db()), input('dudoso.pdf'))
    expect(ko.state?.classification?.implementation).toBe('rules')
    expect(ko.state?.notes.join(' ')).toContain('sin red')
    expect(ko.status).toBe('suspended')
  })
})
