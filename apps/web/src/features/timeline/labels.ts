/** Spanish labels for the journey and the detail panel rows. Shows only what the contract carries. */
import type { ApplicationTimeline, TimelineChapter, TimelineEvent, TimelineLane, TimelinePrecision } from '@gow/contracts'
import { APPLICATION_STATUS_LABEL, DECISION_LABEL } from '../../lib/format'

export const LANES: { id: TimelineLane; label: string; color: string }[] = [
  { id: 'supplier', label: 'Proveedor', color: '#a6f23b' },
  { id: 'relay', label: 'Relay · buzón', color: '#6574ff' },
  { id: 'queue', label: 'Cola · worker', color: '#8b909b' },
  { id: 'workflow', label: 'Workflow', color: '#14171f' },
  { id: 'models', label: 'Modelos', color: '#3a47d1' },
  { id: 'engine', label: 'Motor', color: '#f5b83d' },
  { id: 'analyst', label: 'Analista', color: '#f0594a' },
]
export const LANE_LABEL = Object.fromEntries(LANES.map((l) => [l.id, l.label])) as Record<TimelineLane, string>

export const PRECISION_NOTE: Record<TimelinePrecision, string> = {
  exact: 'Hora exacta: viene de la columna de tiempo de su propia fila.',
  derived: 'Hora derivada: se calcula de dos filas que sí tienen tiempo (por ejemplo, la espera en cola).',
  inferred: 'Hora inferida: este paso no guarda su hora y se colocó entre los que sí la tienen.',
}
export const PRECISION_LABEL: Record<TimelinePrecision, string> = { exact: 'Exacta', derived: 'Derivada', inferred: 'Inferida' }

export const KIND_LABEL: Record<TimelineEvent['kind'], string> = {
  application_created: 'Solicitud creada',
  inbound_message: 'Mensaje del proveedor',
  outbound_message: 'Mensaje al proveedor',
  queue_wait: 'Espera en cola',
  job_finished: 'Trabajo terminado',
  workflow_step: 'Paso del workflow',
  workflow_suspended: 'Workflow en espera',
  model_call: 'Llamada al modelo',
  verification: 'Verificación',
  decision: 'Decisión del motor',
  clarification_opened: 'Aclaración abierta',
  clarification_answered: 'Aclaración contestada',
  verdict_queued: 'Veredicto en cola',
  correction: 'Corrección del analista',
  analyst_action: 'Acción del analista',
}

const STEP_LABEL: Record<string, string> = {
  extract: 'Extraer',
  'classify-transactions': 'Clasificar movimientos',
  decide: 'Decidir',
  'ask-owner': 'Preguntar al proveedor',
  'apply-answers': 'Aplicar respuestas',
  're-decide': 'Reevaluar',
  explain: 'Explicar',
  finalize: 'Cerrar',
}
export const stepLabel = (s: string): string => STEP_LABEL[s] ?? s

const PURPOSE: Record<string, string> = {
  classify: 'Clasificar el documento',
  summary: 'Resumen',
  transactions: 'Movimientos',
  retry_page: 'Reintentar una página',
  double_read: 'Doble lectura',
  citations: 'Citas',
  classify_transactions: 'Clasificar movimientos',
  write_questions: 'Redactar preguntas',
  explain: 'Explicar la decisión',
  interpret_reply: 'Leer la respuesta del proveedor',
}
export function purposeLabel(p: string): string {
  if (PURPOSE[p]) return PURPOSE[p]
  if (p.startsWith('extraction.')) return `Extracción · ${p.slice('extraction.'.length).replace(/_/g, ' ')}`
  return p.replace(/_/g, ' ')
}

const JOB: Record<string, string> = { process: 'Procesar', resume: 'Reanudar', redecide: 'Reevaluar' }
const MESSAGE_KIND: Record<string, string> = { question: 'Pregunta', reask: 'Pregunta repetida', invoice: 'Datos de factura', verdict: 'Veredicto', document: 'Documento', registration: 'Registro', generic: 'Mensaje' }
const DELIVERY: Record<string, string> = { pending: 'Pendiente', sent: 'Enviado', failed: 'Falló' }
const ORIGIN: Record<string, string> = { whatsapp: 'WhatsApp', email: 'Correo', api: 'API', backoffice: 'Backoffice', unknown: 'Desconocido' }
const GATE_OUTCOME: Record<string, string> = { pass: 'Cumple', fail: 'No cumple', unknown: 'Sin dato' }
const GATE_EFFECT: Record<string, string> = { none: 'sin efecto', needs_clarification: 'pide aclaración', human_review: 'revisión humana', not_qualified: 'no califica' }
const EXTRACTION: Record<string, string> = { complete: 'Completa', partial: 'Parcial', failed: 'Falló' }
const MEDIA: Record<string, string> = { image: 'imagen', audio: 'audio', video: 'video', sticker: 'sticker' }

export const usd = (n: number): string => (n === 0 ? '$0' : `$${n.toFixed(n < 0.01 ? 4 : 3)}`)

const clockFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1, hour12: false })
export const clock = (ms: number): string => clockFmt.format(new Date(ms))

export type DetailRow = { label: string; value: string; mono?: boolean }

const yes = (b: boolean) => (b ? 'Sí' : 'No')
const seconds = (ms: number) => (ms === 0 ? '—' : `${(ms / 1000).toFixed(1)} s`)

type Kind = TimelineEvent['kind']
type Of<K extends Kind> = Extract<TimelineEvent, { kind: K }>
type RowsFor = { [K in Kind]: (ev: Of<K>) => DetailRow[] }

const CHANNEL = 'Canal'
const ROUND = 'Ronda'
const optional = (cond: unknown, row: DetailRow): DetailRow[] => (cond ? [row] : [])

const modelCallRows = (ev: Of<'model_call'>): DetailRow[] => [
  { label: 'Modelo', value: ev.model, mono: true },
  { label: 'Propósito', value: purposeLabel(ev.purpose) },
  ...optional(ev.prompt, { label: 'Prompt', value: ev.prompt ?? '', mono: true }),
  ...optional(ev.effort, { label: 'Esfuerzo', value: ev.effort ?? '' }),
  { label: 'Páginas', value: ev.pages.length ? ev.pages.join(', ') : '—' },
  { label: 'De caché', value: yes(ev.cache_hit) },
  { label: 'Resultado', value: ev.outcome === 'ok' ? 'Bien' : `Error${ev.error_code ? ` · ${ev.error_code}` : ''}` },
  { label: 'Tokens', value: ev.cache_hit ? '—' : `${ev.input_tokens.toLocaleString('es-MX')} → ${ev.output_tokens.toLocaleString('es-MX')}` },
  { label: 'Costo', value: usd(ev.cost_usd) },
  { label: 'Latencia', value: seconds(ev.latency_ms) },
]

const decisionRows = (ev: Of<'decision'>): DetailRow[] => [
  { label: 'Tipo', value: ev.decision_kind === 'shadow' ? 'En sombra (no cuenta)' : 'Activa' },
  { label: 'Veredicto', value: DECISION_LABEL[ev.status] },
  { label: 'Línea', value: yes(ev.has_limit) },
  ...optional(ev.score !== null, { label: 'Puntaje', value: (ev.score ?? 0).toFixed(1) }),
  ...optional(ev.band_index !== null, { label: 'Banda', value: String((ev.band_index ?? 0) + 1) }),
  ...optional(ev.policy_version !== null, { label: 'Política', value: `v${String(ev.policy_version)}` }),
  ...optional(ev.asks.length, { label: 'Pregunta por', value: ev.asks.join(', '), mono: true }),
]

const verificationRows = (ev: Of<'verification'>): DetailRow[] => [
  { label: 'Extracción', value: EXTRACTION[ev.extraction_status] ?? ev.extraction_status },
  { label: 'Verificados', value: String(ev.verified) },
  { label: 'Sin verificar', value: String(ev.unverified) },
  { label: 'En conflicto', value: String(ev.conflict) },
  { label: 'Páginas con alertas', value: ev.pages_with_issues.length ? ev.pages_with_issues.join(', ') : '—' },
  ...optional(ev.flags.length, { label: 'Banderas', value: ev.flags.join(', '), mono: true }),
]

const ROWS: RowsFor = {
  application_created: (ev) => [{ label: 'Origen', value: ORIGIN[ev.origin] ?? ev.origin }],
  inbound_message: (ev) => [
    { label: CHANNEL, value: ev.channel },
    { label: 'Resolución', value: ev.resolution ?? 'Sin procesar', mono: true },
    { label: 'Trae documento', value: yes(ev.has_document) },
    ...optional(ev.media_kind, { label: 'Adjunto', value: MEDIA[ev.media_kind ?? ''] ?? ev.media_kind ?? '' }),
    { label: 'Leído por el intérprete', value: yes(ev.interpreted) },
  ],
  outbound_message: (ev) => [
    { label: CHANNEL, value: ev.channel },
    { label: 'Tipo', value: MESSAGE_KIND[ev.message_kind] ?? ev.message_kind },
    { label: 'Entrega', value: DELIVERY[ev.delivery] ?? ev.delivery },
    { label: 'Intentos', value: String(ev.attempts) },
  ],
  queue_wait: (ev) => [{ label: 'Trabajo', value: JOB[ev.job] ?? ev.job }],
  job_finished: (ev) => [
    { label: 'Trabajo', value: ev.job ? (JOB[ev.job] ?? ev.job) : '—' },
    { label: 'Estado al terminar', value: APPLICATION_STATUS_LABEL[ev.application_status] },
  ],
  workflow_step: (ev) => [
    { label: 'Paso', value: stepLabel(ev.step) },
    { label: ROUND, value: String(ev.round) },
  ],
  workflow_suspended: (ev) => [{ label: ROUND, value: String(ev.round) }],
  model_call: modelCallRows,
  verification: verificationRows,
  decision: decisionRows,
  clarification_opened: (ev) => [
    { label: ROUND, value: String(ev.round) },
    { label: CHANNEL, value: ev.channel },
    { label: 'Preguntas', value: String(ev.questions) },
  ],
  clarification_answered: (ev) => [
    { label: ROUND, value: String(ev.round) },
    { label: 'Respuestas', value: String(ev.answers) },
  ],
  verdict_queued: (ev) => [{ label: 'Estado', value: APPLICATION_STATUS_LABEL[ev.application_status] }],
  correction: (ev) => [{ label: 'Campo', value: ev.target, mono: true }, ...optional(ev.page, { label: 'Página', value: String(ev.page ?? '') })],
  analyst_action: (ev) => [{ label: 'Acción', value: ev.action, mono: true }],
}

/** Panel rows for an event: only fields the contract carries. */
export function detailRows(ev: TimelineEvent): DetailRow[] {
  return (ROWS[ev.kind] as (e: TimelineEvent) => DetailRow[])(ev)
}

/** Gates and dimensions of a decision, as panel rows. */
export function gateRows(ev: Extract<TimelineEvent, { kind: 'decision' }>): { id: string; text: string; tone: 'pass' | 'warn' | 'fail' | 'none' }[] {
  return ev.gates.map((g) => ({
    id: g.id,
    text: `${GATE_OUTCOME[g.outcome] ?? g.outcome}${g.effect === 'none' ? '' : ` · ${GATE_EFFECT[g.effect] ?? g.effect}`}`,
    tone: g.outcome === 'pass' ? 'pass' : g.effect === 'not_qualified' ? 'fail' : g.effect === 'none' ? 'none' : 'warn',
  }))
}

export function chapterSummary(tl: ApplicationTimeline, c: TimelineChapter): { events: number; calls: number; cost: number } {
  const inChapter = tl.events.filter((ev) => ev.chapter === c.id)
  const calls = inChapter.filter((ev): ev is Extract<TimelineEvent, { kind: 'model_call' }> => ev.kind === 'model_call')
  return { events: inChapter.length, calls: calls.length, cost: calls.reduce((a, x) => a + x.cost_usd, 0) }
}
