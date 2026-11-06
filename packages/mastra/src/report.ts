/**
 * Salidas por solicitud del modo standalone (docs/07 A e I): el `ApplicationResult` en JSON y un
 * reporte Markdown legible para quien evalúa, sin tener que leer JSON. Ambos llevan datos del
 * documento: van a la carpeta de salida, nunca a la consola ni a logs.
 */
import { APPLICATION_RESULT_VERSION, ApplicationResult, FEATURE_NAMES, type ApplicationStatus, type CostLine, type Decision, type Question, type StatementExtraction } from '@gow/contracts'
import { buildLedger } from '@gow/decision'
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

/** Política de ejemplo para evaluar documentos redactados sin registro de proveedores (ADR 0015). */
export const STANDALONE_POLICY_PATH = 'policies/examples/standalone-evaluation.v1.json'

/** La compuerta de identidad bloqueó porque no había con qué comparar (no porque no coincidiera). */
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

export function toApplicationResult(applicationId: string, state: AppState | null, run: RunInfo, generatedAt: string, runError: string | null): ApplicationResult {
  const lines = costLines(state)
  const status = applicationStatus(state, run)
  const asked = run.status === 'suspended'
  return ApplicationResult.parse({
    schema_version: APPLICATION_RESULT_VERSION,
    application_id: applicationId,
    status,
    failure_reason: status === 'failed' ? (state?.failure_reason ?? runError ?? 'el workflow terminó sin veredicto') : null,
    as_of: state?.input.as_of ?? generatedAt.slice(0, 10),
    documents: state?.documents ?? [],
    request: state?.input.request ?? null,
    supplier: state?.supplier ?? null,
    policy: { id: state?.input.policy_id ?? null, version: state?.input.policy.version ?? 1 },
    decision: state?.decision ?? null,
    max_line: state?.max_line ?? null,
    clarification:
      state && (asked || state.rounds > 0)
        ? { status: asked ? 'open' : 'answered', rounds_used: state.rounds, questions: asked ? state.questions : state.asked, answers: state.answers, rejected_answers: [...state.rejected_answers, ...state.contradictions] }
        : null,
    classification: state?.classification ?? null,
    run,
    costs: { total_usd: Math.round(lines.reduce((s, l) => s + l.cost_usd, 0) * 1e6) / 1e6, lines },
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

function classificationSection(state: AppState): string[] {
  const c = state.classification
  if (!c) return []
  const who = c.implementation === 'jev' ? `Jev (\`${c.model ?? ''}\`)` : c.implementation === 'claude' ? `Haiku (\`${c.model ?? ''}\`)${c.fallback ? ', respaldo porque no hay llave de Jev' : ''}` : 'solo reglas'
  const out = ['', '## Clasificación de movimientos', '', `Reglas \`${c.rules_version}\` y ${who}. ${String(c.transactions)} movimientos; ${String(c.sent_to_model)} sin regla confiable fueron al modelo y ${String(c.classified_by_model)} recibieron etiqueta.${c.error ? ` ${c.error}.` : ''}`, '']
  const ledger = buildLedger(state.statements, { request: state.input.request, minConfidence: state.decision?.profile.parameters.min_classification_confidence ?? 0.7 })
  const by = new Map<string, { n: number; credits: number; debits: number; low: number }>()
  for (const r of ledger.rows) {
    const key = r.internal ? 'traspaso interno' : r.classification.category
    const e = by.get(key) ?? { n: 0, credits: 0, debits: 0, low: 0 }
    e.n++
    if (r.type === 'credit') e.credits += r.amount
    else e.debits += r.amount
    if (r.classification.confidence < (state.decision?.profile.parameters.min_classification_confidence ?? 0.7)) e.low++
    by.set(key, e)
  }
  out.push(...table(['Categoría', 'Movimientos', 'Abonos', 'Cargos', 'Bajo el umbral'], [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => [k, e.n, pesos(Math.round(e.credits * 100) / 100), pesos(Math.round(e.debits * 100) / 100), e.low])))
  return out
}

export function renderReport(result: ApplicationResult, state: AppState | null): string {
  const out: string[] = [`# Solicitud ${result.application_id}`, '']
  const d = result.decision
  out.push(`**Estado:** \`${result.status}\` (${STATUS_TEXT[result.status]})`)
  if (result.failure_reason) out.push('', `**Razón:** ${result.failure_reason}`)
  if (d) {
    const band = d.band ? `banda "${SUPPLIER_STATUS_TEXT[d.band.status]}" desde ${String(d.band.min)}` : 'sin banda'
    out.push('', `**Línea:** ${d.limit === null ? '—' : pesos(d.limit)} · **Puntaje:** ${d.score === null ? '—' : String(Math.round(d.score * 100) / 100)} de 100 (${band})`)
  }
  if (result.max_line) {
    const cond = result.max_line.conditional_on.length > 0 ? `, si se resuelven: ${result.max_line.conditional_on.join(', ')}` : ''
    out.push('', `**Línea máxima** (no hay monto solicitado): ${pesos(result.max_line.amount)} (${SUPPLIER_STATUS_TEXT[result.max_line.status]}${cond}). Es el mayor monto que, pedido, la política aprobaría.`)
  } else if (result.request?.amount == null && d) {
    out.push('', '**Línea máxima:** no hay; con estos datos la política no aprueba ningún monto.')
  }
  out.push('', `Fecha de cálculo ${result.as_of} · política \`${result.policy.id ?? 'sin id'}\` v${String(result.policy.version)} · ${result.request ? `solicitud: monto ${result.request.amount === null ? 'sin monto' : pesos(result.request.amount)}, comprador ${result.request.buyer?.name ?? 'sin comprador'}` : 'sin datos de solicitud'} · proveedor ${result.supplier ? 'declarado' : 'sin identidad registrada'}`)
  if (result.clarification) {
    out.push(...questionsSection(result.clarification.questions, result.clarification.status === 'open'))
    if (result.clarification.status === 'open') out.push('', `Para responder: llena \`answers.template.json\` (en esta carpeta) y corre de nuevo el comando con \`--answers <archivo>\`. Ronda ${String(result.clarification.rounds_used + 1)}.`)
    if (result.clarification.answers.length > 0) {
      out.push('', 'Respuestas recibidas:', '')
      for (const a of result.clarification.answers) out.push(`- ${a.question_id}: ${a.kind === 'deposit' ? `abono → \`${a.category}\`` : a.kind === 'identity' ? 'identidad declarada' : a.kind === 'documents' ? `${String(a.paths.length)} documento(s)` : 'no sabe o no tiene el dato'}`)
    }
    for (const r of result.clarification.rejected_answers) out.push(`- Respuesta no aplicada (${r.question_id}): ${r.reason}`)
  }
  if (d) out.push('', ...decisionSection(d))
  if (state) {
    out.push(...extractionSection(state.statements))
    out.push(...classificationSection(state))
    if (state.notes.length > 0) out.push('', '## Avisos del proceso', '', ...state.notes.map((n) => `- ${n}`))
  }
  out.push('', '## Costo', '')
  out.push(...table(['Propósito', 'Modelo', 'Llamadas', 'De caché', 'USD'], result.costs.lines.map((l) => [l.purpose, l.model, l.calls, l.cache_hits, l.cost_usd.toFixed(6)])))
  out.push('', `Total acumulado: USD ${result.costs.total_usd.toFixed(6)} (una respuesta de caché cuesta 0).`)
  out.push('', '## Supuestos', '')
  out.push('- Modo standalone: no se consultan crédito vigente, buró, SAT ni listas; esas features quedan sin dato y la política las trata según `onUnknown`.')
  if (identityUnverifiable(result)) {
    out.push(`- La identidad no se pudo comparar (titular, RFC o CLABE redactados, o sin proveedor registrado) y la compuerta \`identity\` de esta política lo pregunta. Para ver la decisión sin ese bloqueo: corre sin \`--policy base\` (por defecto se usa \`${STANDALONE_POLICY_PATH}\`), o registra al proveedor con \`--request supplier_name=...,supplier_rfc=...\`.`)
  }
  out.push('- Los movimientos los clasifican reglas y, donde no alcanzan, Jev o Haiku; un abono bajo el umbral de confianza no suma ingresos.')
  out.push('- Ningún valor no verificado contra el documento decide: si cambia la banda, se pregunta o va a revisión (docs/04 §5).')
  out.push('', `Generado ${result.generated_at} · run \`${result.run.run_id}\` (${result.run.status}).`)
  return `${out.join('\n')}\n`
}
