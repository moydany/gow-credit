/**
 * Per-request outputs of standalone mode: the `ApplicationResult` as JSON and a Markdown report
 * readable by the evaluator without reading JSON. Both carry document data: they go to the
 * output folder, never to the console or logs.
 */
import { APPLICATION_RESULT_VERSION, ApplicationResult, DocumentType, FEATURE_NAMES, IsoDate, StatementExtraction, type ApplicationStatus, type CostLine, type Decision, type OwnerAnswer, type Period, type Question } from '@gow/contracts'
import { buildLedger, type LedgerRow } from '@gow/decision'
import { z } from 'zod'
import { pesos } from './figures.ts'
import type { AppState } from './state.ts'
import { SUPPLIER_STATUS_TEXT, valueText } from './writer.ts'

export interface RunInfo {
  workflow: string
  run_id: string
  status: 'success' | 'suspended' | 'failed'
  suspended_step: string[] | null
}

const STATUS_TEXT: Record<ApplicationStatus, string> = {
  received: 'recibida',
  extracting: 'extrayendo',
  extracted: 'extraída',
  deciding: 'decidiendo',
  needs_clarification: 'pausada: necesita aclaración del proveedor',
  human_review: 'revisión humana',
  qualified: 'califica',
  qualified_with_limit: 'califica con límite',
  not_qualified: 'no califica',
  failed: 'falló',
}

/** Default policy of `evaluate`: the base template without the statement-age gate. */
export const STANDALONE_POLICY_PATH = 'policies/examples/standalone-evaluation.v1.json'
/** The same policy evaluating three months in a row (ADR 0072). */
export const THREE_MONTHS_POLICY_PATH = 'policies/examples/standalone-tres-meses.v1.json'

/** The identity gate blocked for lack of anything to compare with (not because of a mismatch). */
export function identityUnverifiable(result: ApplicationResult): boolean {
  return result.decision?.reasons.some((r) => r.code === 'gate_identity_unknown') ?? false
}

export function costLines(state: AppState | null): CostLine[] {
  const lines = new Map<string, CostLine>()
  for (const c of state?.calls ?? []) {
    const key = `${c.purpose}\u0000${c.model}`
    const l = lines.get(key) ?? { purpose: c.purpose, model: c.model, calls: 0, cache_hits: 0, cost_usd: 0 }
    l.calls++
    if (c.cache_hit) l.cache_hits++
    l.cost_usd = Math.round((l.cost_usd + c.cost_usd) * 1e6) / 1e6
    lines.set(key, l)
  }
  return [...lines.values()]
}

export function applicationStatus(state: AppState | null, run: RunInfo): ApplicationStatus {
  if (run.status === 'failed' || state === null || state.failure_reason !== null || state.decision === null) return 'failed'
  return state.decision.status
}

function resolveClarificationPayload(state: AppState | null, asked: boolean): ApplicationResult['clarification'] {
  if (!state || (!asked && state.rounds === 0)) return null
  return {
    status: asked ? 'open' : 'answered',
    rounds_used: state.rounds,
    questions: asked ? state.questions : state.asked,
    answers: state.answers,
    rejected_answers: [...state.rejected_answers, ...state.contradictions],
  }
}

function resolveFailureReason(status: ApplicationStatus, state: AppState | null, runError: string | null): string | null {
  if (status !== 'failed') return null
  return state?.failure_reason ?? runError ?? 'el workflow terminó sin veredicto'
}

function computeTotalCosts(lines: readonly CostLine[]) {
  return {
    total_usd: Math.round(lines.reduce((s, l) => s + l.cost_usd, 0) * 1e6) / 1e6,
    lines,
  }
}

function resolveApplicationMetadata(state: AppState | null, generatedAt: string) {
  if (!state) {
    return {
      as_of: generatedAt.slice(0, 10),
      documents: [],
      request: null,
      supplier: null,
      policy: { id: null, version: 1 },
      decision: null,
      max_line: null,
      classification: null,
    }
  }
  return {
    as_of: state.input.as_of,
    documents: state.documents,
    request: state.input.request,
    supplier: state.supplier,
    policy: { id: state.input.policy_id, version: state.input.policy.version },
    decision: state.decision,
    max_line: state.max_line,
    classification: state.classification,
  }
}

export function toApplicationResult(applicationId: string, state: AppState | null, run: RunInfo, generatedAt: string, runError: string | null): ApplicationResult {
  const lines = costLines(state)
  const status = applicationStatus(state, run)
  const asked = run.status === 'suspended'
  const meta = resolveApplicationMetadata(state, generatedAt)
  return ApplicationResult.parse({
    schema_version: APPLICATION_RESULT_VERSION,
    application_id: applicationId,
    status,
    failure_reason: resolveFailureReason(status, state, runError),
    as_of: meta.as_of,
    documents: meta.documents,
    request: meta.request,
    supplier: meta.supplier,
    policy: meta.policy,
    decision: meta.decision,
    max_line: meta.max_line,
    clarification: resolveClarificationPayload(state, asked),
    classification: meta.classification,
    run,
    costs: computeTotalCosts(lines),
    generated_at: generatedAt,
  })
}

function cell(v: unknown): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '—' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function table(head: string[], rows: unknown[][]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)]
}

function decisionSection(d: Decision): string[] {
  const out: string[] = []
  out.push('## Por qué', '')
  if (d.explanation) out.push(d.explanation.text, '', d.reasons.length > 0 ? '**Detalle del motor:**' : '', '')
  for (const r of d.reasons) out.push(`- ${r.message} \`${r.code}\``)
  if (d.next_steps.length > 0) {
    out.push('', '## Qué cambiaría el resultado', '')
    for (const s of d.next_steps) out.push(`- ${s.message ?? s.code}`)
  }
  out.push('', '## Compuertas', '')
  out.push(...table(['Compuerta', 'Feature', 'Valor', 'Regla', 'Resultado', 'Efecto'], d.evaluation.gates.map((g) => [g.id, g.feature, g.value, `${g.op} ${cell(g.threshold)}`, g.outcome, g.effect])))
  out.push('', '## Puntaje', '')
  out.push(
    ...table(
      ['Dimensión', 'Feature', 'Valor', 'Normalizado', 'Peso', 'Puntos', 'Usada'],
      d.evaluation.dimensions.map((x) => [x.id, x.relative_to ? `${x.feature} / ${x.relative_to}` : x.feature, x.value === null ? null : Math.round(x.value * 1e4) / 1e4, x.normalized === null ? null : Math.round(x.normalized * 100) / 100, x.weight, Math.round(x.points * 100) / 100, x.used ? 'sí' : `no (${x.excluded_reason ?? ''})`]),
    ),
  )
  if (d.evaluation.limit) out.push('', `Fórmula de línea: \`${d.evaluation.limit.formula}\` → ${d.evaluation.limit.terms.map((t) => `${t.term} = ${t.value === null ? 'sin dato' : pesos(t.value)}`).join('; ')}`)
  out.push('', '## Perfil', '')
  out.push(
    ...table(
      ['Feature', 'Valor', 'Verificación', 'Confianza', 'Procedencia', 'Nota'],
      FEATURE_NAMES.map((f) => {
        const e = d.profile.features[f]
        return [f, e.value === null ? null : valueText(f, e.value), e.verification, Math.round(e.confidence * 100) / 100, e.provenance, e.note]
      }),
    ),
  )
  return out
}

function questionsSection(questions: readonly Question[], open: boolean): string[] {
  const out = ['', open ? '## Preguntas al proveedor (pendientes)' : '## Preguntas al proveedor', '']
  for (const q of questions) {
    out.push(`- **${q.id}** (${q.topic}, ${q.text_source === 'writer' ? 'redactada por el modelo y filtrada' : 'plantilla'}): ${q.text}`)
    if (q.options.length > 0) out.push(`  - Opciones: ${q.options.map((o) => `\`${o.value}\` ${o.label}`).join(' · ')}`)
  }
  return out
}

function extractionSection(statements: readonly StatementExtraction[]): string[] {
  const out = ['', '## Extracción', '']
  out.push(
    ...table(
      ['Documento', 'Banco', 'Ruta', 'Estado', 'Cuentas', 'Periodos', 'Movimientos', 'Periodos cuadrados', 'CFDI'],
      statements.map((s) => {
        const periods = s.accounts.flatMap((a) => a.periods)
        return [
          s.document.file_name,
          s.bank_name.value ?? s.classification.bank,
          s.document.route,
          s.extraction.status,
          s.accounts.length,
          periods.length,
          periods.reduce((n, p) => n + p.transactions.length, 0),
          `${String(periods.filter((p) => p.reconciliation?.status === 'reconciled').length)}/${String(periods.length)}`,
          s.fiscal_documents.length,
        ]
      }),
    ),
  )
  const issues = statements.flatMap((s) => s.issues.filter((i) => i.severity !== 'info'))
  if (issues.length > 0) {
    out.push('', 'Avisos de la verificación:', '')
    for (const i of issues.slice(0, 15)) out.push(`- ${i.severity === 'error' ? 'Error' : 'Aviso'} \`${i.code}\`${i.page ? ` (p. ${String(i.page)})` : ''}: ${i.message}`)
    if (issues.length > 15) out.push(`- … y ${String(issues.length - 15)} más en el JSON de la extracción.`)
  }
  return out
}

function formatClassifierHeader(c: NonNullable<AppState['classification']>): string {
  const who = c.implementation === 'jev' ? `Jev (\`${c.model ?? ''}\`)` : c.implementation === 'claude' ? `Haiku (\`${c.model ?? ''}\`)${c.fallback ? ', respaldo porque no hay llave de Jev' : ''}` : 'solo reglas'
  return `Reglas \`${c.rules_version}\` y ${who}. ${String(c.transactions)} movimientos; ${String(c.sent_to_model)} sin regla confiable fueron al modelo y ${String(c.classified_by_model)} recibieron etiqueta.${c.error ? ` ${c.error}.` : ''}`
}

function aggregateLedgerCategories(ledgerRows: LedgerRow[], minConfidence: number) {
  const by = new Map<string, { n: number; credits: number; debits: number; low: number }>()
  for (const r of ledgerRows) {
    const key = r.internal ? 'traspaso interno' : r.classification.category
    const e = by.get(key) ?? { n: 0, credits: 0, debits: 0, low: 0 }
    e.n++
    if (r.type === 'credit') e.credits += r.amount
    else e.debits += r.amount
    if (r.classification.confidence < minConfidence) e.low++
    by.set(key, e)
  }
  return by
}

function classificationSection(state: AppState): string[] {
  const c = state.classification
  if (!c) return []
  const out = ['', '## Clasificación de movimientos', '', formatClassifierHeader(c), '']
  const minConfidence = state.decision?.profile.parameters.min_classification_confidence ?? 0.7
  const ledger = buildLedger(state.statements, { request: state.input.request, minConfidence, months: state.decision?.profile.parameters.evaluation_months ?? 1 })
  const by = aggregateLedgerCategories(ledger.rows, minConfidence)
  out.push(...table(['Categoría', 'Movimientos', 'Abonos', 'Cargos', 'Bajo el umbral'], [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => [k, e.n, pesos(Math.round(e.credits * 100) / 100), pesos(Math.round(e.debits * 100) / 100), e.low])))
  return out
}

function formatMaxLineInfo(result: ApplicationResult, d: Decision | null): string | null {
  if (result.max_line) {
    const cond = result.max_line.conditional_on.length > 0 ? `, si se resuelven: ${result.max_line.conditional_on.join(', ')}` : ''
    return `**Línea máxima** (no hay monto solicitado): ${pesos(result.max_line.amount)} (${SUPPLIER_STATUS_TEXT[result.max_line.status]}${cond}). Es el mayor monto que, pedido, la política aprobaría.`
  }
  if (result.request?.amount == null && d) {
    return '**Línea máxima:** no hay; con estos datos la política no aprueba ningún monto.'
  }
  return null
}

function formatEvaluationContextLine(result: ApplicationResult): string {
  const reqText = result.request
    ? `solicitud: monto ${result.request.amount === null ? 'sin monto' : pesos(result.request.amount)}, comprador ${result.request.buyer?.name ?? 'sin comprador'}`
    : 'sin datos de solicitud'
  const supText = result.supplier ? 'declarado' : 'sin identidad registrada'
  return `Fecha de cálculo ${result.as_of} · política \`${result.policy.id ?? 'sin id'}\` v${String(result.policy.version)} · ${reqText} · proveedor ${supText}`
}

function formatDecisionSummary(d: Decision): string {
  const band = d.band ? `banda "${SUPPLIER_STATUS_TEXT[d.band.status]}" desde ${String(d.band.min)}` : 'sin banda'
  const limitText = d.limit === null ? '—' : pesos(d.limit)
  const scoreText = d.score === null ? '—' : String(Math.round(d.score * 100) / 100)
  return `**Línea:** ${limitText} · **Puntaje:** ${scoreText} de 100 (${band})`
}

function renderReportHeader(result: ApplicationResult, d: Decision | null): string[] {
  const out: string[] = [`# Solicitud ${result.application_id}`, '']
  out.push(`**Estado:** \`${result.status}\` (${STATUS_TEXT[result.status]})`)
  if (result.failure_reason) out.push('', `**Razón:** ${result.failure_reason}`)
  if (d) out.push('', formatDecisionSummary(d))
  const maxLine = formatMaxLineInfo(result, d)
  if (maxLine) out.push('', maxLine)
  out.push('', formatEvaluationContextLine(result))
  return out
}

function renderClarificationSection(clarification: ApplicationResult['clarification']): string[] {
  if (!clarification) return []
  const out = [...questionsSection(clarification.questions, clarification.status === 'open')]
  if (clarification.status === 'open') {
    out.push('', `Para responder: llena \`answers.template.json\` (en esta carpeta) y corre de nuevo el comando con \`--answers <archivo>\`. Ronda ${String(clarification.rounds_used + 1)}.`)
  }
  if (clarification.answers.length > 0) {
    out.push('', 'Respuestas recibidas:', '')
    for (const a of clarification.answers) out.push(`- ${a.question_id}: ${answerText(a)}`)
  }
  for (const r of clarification.rejected_answers) out.push(`- Respuesta no aplicada (${r.question_id}): ${r.reason}`)
  return out
}

function renderAssumptionsSection(result: ApplicationResult): string[] {
  const out = [
    '',
    '## Supuestos',
    '',
    '- Modo standalone: no se consultan crédito vigente, buró, SAT ni listas; esas features quedan sin dato y la política las trata según `onUnknown`.',
  ]
  if (identityUnverifiable(result)) {
    out.push(`- La identidad no se pudo comparar (titular, RFC o CLABE redactados, o sin proveedor registrado) y la compuerta \`identity\` de esta política lo pregunta. Para ver la decisión sin ese bloqueo: corre sin \`--policy base\` (por defecto se usa \`${STANDALONE_POLICY_PATH}\`), o registra al proveedor con \`--request supplier_name=...,supplier_rfc=...\`.`)
  }
  out.push('- Los movimientos los clasifican reglas y, donde no alcanzan, Jev o Haiku; un abono bajo el umbral de confianza no suma ingresos.')
  out.push('- Ningún valor no verificado contra el documento decide: si cambia la banda, se pregunta o va a revisión (docs/04 §5).')
  out.push('', `Generado ${result.generated_at} · run \`${result.run.run_id}\` (${result.run.status}).`)
  return out
}

export function renderReport(result: ApplicationResult, state: AppState | null): string {
  const d = result.decision
  const out: string[] = [
    ...renderReportHeader(result, d),
    ...renderClarificationSection(result.clarification),
  ]
  if (d) out.push('', ...decisionSection(d))
  if (state) {
    out.push(...extractionSection(state.statements))
    out.push(...classificationSection(state))
    if (state.notes.length > 0) out.push('', '## Avisos del proceso', '', ...state.notes.map((n) => `- ${n}`))
  }
  out.push('', '## Costo', '')
  out.push(...table(['Propósito', 'Modelo', 'Llamadas', 'De caché', 'USD'], result.costs.lines.map((l) => [l.purpose, l.model, l.calls, l.cache_hits, l.cost_usd.toFixed(6)])))
  out.push('', `Total acumulado: USD ${result.costs.total_usd.toFixed(6)} (una respuesta de caché cuesta 0).`)
  out.push(...renderAssumptionsSection(result))
  return `${out.join('\n')}\n`
}

/** An answer on one line, without document data or names (the main customer is not written). */
function answerText(a: OwnerAnswer): string {
  switch (a.kind) {
    case 'deposit':
      return `abono → \`${a.category}\``
    case 'charge':
      return `cargo → \`${a.category}\``
    case 'buyer':
      return 'cliente principal declarado'
    case 'account_use':
      return `uso de la cuenta → \`${a.use}\``
    case 'identity':
      return 'identidad declarada'
    case 'documents':
      return `${String(a.paths.length)} documento(s)`
    case 'decline':
      return 'no sabe o no tiene el dato'
  }
}

// ---------- Flat extraction summary (extraction-summary.json and .csv)

/**
 * A flat summary row: the header fields any reference truth carries, with English names and the
 * paths of the `StatementExtraction` contract. One row per document and, if it has several
 * accounts, one per account. What the contract lacks (or the bank did not print) is `null`: it is
 * never computed or filled in from something else. Carries document data: output folder only.
 */
export const ExtractionSummaryRow = z.strictObject({
  file: z.string().describe('document.file_name'),
  document_type: DocumentType.nullable().describe('classification.document_type'),
  bank: z.string().nullable().describe('bank_name.value; si no se leyó, classification.bank'),
  holder_name: z.string().nullable().describe('holder.name.value'),
  holder_rfc: z.string().nullable().describe('holder.rfc.value'),
  account_number: z.string().nullable().describe('accounts[].account_number.value'),
  clabe: z.string().nullable().describe('accounts[].clabe.value'),
  currency: z.string().nullable().describe('accounts[].currency.value'),
  period_start: IsoDate.nullable().describe('el menor accounts[].periods[].period_start.value'),
  period_end: IsoDate.nullable().describe('el mayor accounts[].periods[].period_end.value'),
  opening_balance: z.number().nullable().describe('summary.opening_balance.value del primer periodo'),
  closing_balance: z.number().nullable().describe('summary.closing_balance.value del último periodo'),
  total_credits: z.number().nullable().describe('suma del summary.total_credits.value impreso de los periodos'),
  total_debits: z.number().nullable().describe('suma del summary.total_debits.value impreso de los periodos'),
  credits_count: z.int().nullable().describe('suma del summary.credits_count.value impreso de los periodos'),
  debits_count: z.int().nullable().describe('suma del summary.debits_count.value impreso de los periodos'),
  transactions_extracted: z.int().nullable().describe('movimientos en accounts[].periods[].transactions'),
  reconciled: z.boolean().nullable().describe('true si todos los periodos cuadran (reconciliation.status), false si alguno no; null si no se pudo comprobar'),
  cfdi_uuid: z.string().nullable().describe('fiscal_documents[].uuid.value; varios van separados por ;'),
  extraction_status: StatementExtraction.shape.extraction.shape.status.nullable().describe('extraction.status'),
})
export type ExtractionSummaryRow = z.infer<typeof ExtractionSummaryRow>

/** The CSV columns, in row order. */
export const EXTRACTION_SUMMARY_COLUMNS = Object.keys(ExtractionSummaryRow.shape) as (keyof ExtractionSummaryRow)[]

const cents = (n: number) => Math.round(n * 100) / 100

/** The value of each period, or null if any is missing: a partial sum is not what the bank printed. */
function sumOfAll(periods: readonly Period[], pick: (p: Period) => number | null): number | null {
  const values = periods.map(pick)
  return values.length > 0 && values.every((v): v is number => v !== null) ? cents(values.reduce((sum, v) => sum + v, 0)) : null
}

function reconciledOf(periods: readonly Period[]): boolean | null {
  const statuses = periods.map((p) => p.reconciliation?.status ?? null)
  if (statuses.some((x) => x === 'not_reconciled' || x === 'partially_reconciled')) return false
  return statuses.length > 0 && statuses.every((x) => x === 'reconciled') ? true : null
}

const NO_ACCOUNT = {
  account_number: null,
  clabe: null,
  currency: null,
  period_start: null,
  period_end: null,
  opening_balance: null,
  closing_balance: null,
  total_credits: null,
  total_debits: null,
  credits_count: null,
  debits_count: null,
  transactions_extracted: null,
  reconciled: null,
}

/** Flat summary rows of a document: one per account, or one with an empty account if none was read. */
export function extractionSummaryRows(s: StatementExtraction): ExtractionSummaryRow[] {
  const uuids = [...new Set(s.fiscal_documents.map((f) => f.uuid.value).filter((u): u is string => u !== null))]
  const head = {
    file: s.document.file_name,
    document_type: s.classification.document_type,
    bank: s.bank_name.value ?? s.classification.bank,
    holder_name: s.holder.name.value,
    holder_rfc: s.holder.rfc.value,
    cfdi_uuid: uuids.length > 0 ? uuids.join(';') : null,
    extraction_status: s.extraction.status,
  }
  if (s.accounts.length === 0) return [ExtractionSummaryRow.parse({ ...head, ...NO_ACCOUNT })]
  return s.accounts.map((a) => {
    // By period start: the first gives the opening balance and the last, the closing.
    const periods = [...a.periods].sort((x, y) => (x.period_start.value ?? '9999-12-31').localeCompare(y.period_start.value ?? '9999-12-31'))
    const starts = periods.flatMap((p) => (p.period_start.value === null ? [] : [p.period_start.value]))
    const ends = periods.flatMap((p) => (p.period_end.value === null ? [] : [p.period_end.value]))
    return ExtractionSummaryRow.parse({
      ...head,
      account_number: a.account_number.value,
      clabe: a.clabe.value,
      currency: a.currency.value,
      period_start: starts.length > 0 ? starts.reduce((min, d) => (d < min ? d : min)) : null,
      period_end: ends.length > 0 ? ends.reduce((max, d) => (d > max ? d : max)) : null,
      opening_balance: periods.at(0)?.summary.opening_balance.value ?? null,
      closing_balance: periods.at(-1)?.summary.closing_balance.value ?? null,
      total_credits: sumOfAll(periods, (p) => p.summary.total_credits.value),
      total_debits: sumOfAll(periods, (p) => p.summary.total_debits.value),
      credits_count: sumOfAll(periods, (p) => p.summary.credits_count.value),
      debits_count: sumOfAll(periods, (p) => p.summary.debits_count.value),
      transactions_extracted: periods.reduce((n, p) => n + p.transactions.length, 0),
      reconciled: reconciledOf(periods),
    })
  })
}

/** Row for a document with no extraction (the workflow failed earlier): the file and, if failed, its status. */
export function missingExtractionRow(file: string, failed: boolean): ExtractionSummaryRow {
  return ExtractionSummaryRow.parse({ file, document_type: null, bank: null, holder_name: null, holder_rfc: null, cfdi_uuid: null, extraction_status: failed ? 'failed' : null, ...NO_ACCOUNT })
}

const MONEY_COLUMNS: ReadonlySet<keyof ExtractionSummaryRow> = new Set(['opening_balance', 'closing_balance', 'total_credits', 'total_debits'])

function csvField(column: keyof ExtractionSummaryRow, value: ExtractionSummaryRow[keyof ExtractionSummaryRow]): string {
  if (value === null) return ''
  const text = typeof value === 'number' && MONEY_COLUMNS.has(column) ? value.toFixed(2) : String(value)
  // RFC 4180: quote if the value has a comma, quote, newline or edge spaces.
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV with header and comma separator; amounts with two decimals, empty values with nothing between commas. */
export function extractionSummaryCsv(rows: readonly ExtractionSummaryRow[]): string {
  const lines = [EXTRACTION_SUMMARY_COLUMNS.join(','), ...rows.map((row) => EXTRACTION_SUMMARY_COLUMNS.map((c) => csvField(c, row[c])).join(','))]
  return `${lines.join('\n')}\n`
}
