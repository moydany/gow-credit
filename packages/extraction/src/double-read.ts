/**
 * Doble lectura del encabezado en documentos sin texto local (docs/04 §3.6, ADR 0011).
 *
 * En la ruta `vision_only` no hay capa de texto contra la cual comprobar los valores citados del
 * resumen (titular, RFC, cuenta, CLABE, periodo, saldos y totales): todos quedan `unverified` y
 * la antigüedad del estado de cuenta ni siquiera se puede calcular. La segunda lectura repite la
 * pasada 1 (mismo prompt, mismo esquema) con el modelo de la otra familia (`plan.doubleRead`, a
 * `effort` medio) y compara campo por campo:
 *
 * - coinciden → `verified` (la fuente sigue siendo la cita de la primera lectura);
 * - difieren → `conflict` y el issue `header_read_conflict`;
 * - el segundo no lo leyó → queda como estaba.
 *
 * Si la segunda lectura falla (proveedor caído, sin llave, sin respuesta en caché) el documento se
 * entrega como antes, con un issue informativo. Un valor que ya está verificado contra el texto
 * (HSBC con la capa EBCDIC reparada) no se vuelve a juzgar: la comparación contra el texto es más
 * fuerte que una segunda lectura. Los validadores de formato y el cuadre aritmético corren después
 * en `extract.ts` y mandan sobre este resultado.
 */
import type { TokenUsage } from '@gow/contracts'
import { LlmCallError, type Effort, type Limiter, type PdfInput, type StructuredLlm } from '@gow/llm'
import { assembleSummary, type AssembledSummary, type FieldOf } from './assemble.ts'
import type { IssueSink } from './issues.ts'
import { ExtractionChunk, EXTRACTION_SCHEMA_NAME, type SummaryOut } from './llm-schema.ts'
import { normalizeText } from './normalize.ts'
import type { PageText } from './page-text.ts'
import { supportsServerFallback } from './router.ts'

/** Los valores del encabezado que se comparan; el resto del resumen (producto, comisiones...) no. */
export const COMPARED_FIELDS = [
  'bank_name',
  'holder_name',
  'holder_rfc',
  'account_number',
  'clabe',
  'period_start',
  'period_end',
  'statement_date',
  'opening_balance',
  'closing_balance',
  'total_credits',
  'total_debits',
  'credits_count',
  'debits_count',
] as const
export type ComparedField = (typeof COMPARED_FIELDS)[number]

export type Agreement = 'agree' | 'disagree' | 'only_first'

export interface FieldReading {
  field: ComparedField
  /** Posición de la cuenta y del periodo en `summary.accounts`; null donde el campo no es de ese nivel. */
  account: number | null
  period: number | null
  status: Agreement
  /** Valores ya normalizados como los deja `assembleSummary` (fechas ISO, montos como número). */
  first: string | number
  second: string | number | null
}

export type HeaderDoubleRead =
  | { status: 'done'; model: string; readings: FieldReading[] }
  /** No hacía falta o no había con qué: sin llamada y sin aviso. */
  | { status: 'skipped' }
  /** No se pudo: el documento sigue como hoy y se avisa con un issue informativo. */
  | { status: 'failed'; reason: string }

export const DOUBLE_READ_EFFORT: Effort = 'medium'
const DOUBLE_READ_MAX_OUTPUT_TOKENS = 16_000
/** Un campo que coincide en las dos lecturas sin texto local: menos que una cita comprobada en la página (0.95). */
const AGREED_CONFIDENCE = 0.9
const CONFLICT_CONFIDENCE = 0.3

type RecordedCall = { model: string; usage: TokenUsage; costUsd: number; latencyMs: number; responseCacheHit: boolean }

export interface HeaderDoubleReadOptions {
  /** Texto local del PDF; solo sirve para normalizar las dos lecturas igual que la primera. */
  text: PageText
  /** Modelo de la segunda lectura (`plan.doubleRead`). */
  model: string
  /** Modelo que hizo la pasada 1: si es el mismo, la segunda lectura no sería una segunda opinión. */
  firstModel: string
  system: string
  /** El mismo texto que se le dio a la pasada 1, nota de visión incluida. */
  instruction: string
  promptVersion: string
  limit: Limiter
  /** `record` de `extract.ts`: deja la llamada en `extraction.calls` con su costo y su acierto de caché. */
  record: (purpose: string, prompt: string | null, effort: Effort | null, pages: number[], r: RecordedCall) => void
}

// ---------------------------------------------------------------- campos del resumen

type Kind = 'bank' | 'holder' | 'id' | 'date' | 'amount' | 'count'

interface Slot {
  field: ComparedField
  kind: Kind
  account: number | null
  period: number | null
  /** El objeto que contiene el campo y su llave, para leerlo y reemplazarlo. */
  parent: Record<string, unknown>
  key: string
}

const PERIOD_DATES = ['period_start', 'period_end', 'statement_date'] as const
const PERIOD_NUMBERS = [
  ['opening_balance', 'amount'],
  ['closing_balance', 'amount'],
  ['total_credits', 'amount'],
  ['total_debits', 'amount'],
  ['credits_count', 'count'],
  ['debits_count', 'count'],
] as const

/** Todos los campos comparables de un resumen, con su lugar. El orden y los índices son los de `assembleSummary`. */
function slotsOf(s: AssembledSummary): Slot[] {
  const out: Slot[] = []
  const add = (field: ComparedField, kind: Kind, account: number | null, period: number | null, parent: object, key: string) => {
    out.push({ field, kind, account, period, parent: parent as Record<string, unknown>, key })
  }
  add('bank_name', 'bank', null, null, s, 'bankName')
  add('holder_name', 'holder', null, null, s.holder, 'name')
  add('holder_rfc', 'id', null, null, s.holder, 'rfc')
  s.accounts.forEach((a, ai) => {
    add('account_number', 'id', ai, null, a, 'account_number')
    add('clabe', 'id', ai, null, a, 'clabe')
    a.periods.forEach((p, pi) => {
      for (const key of PERIOD_DATES) add(key, 'date', ai, pi, p, key)
      for (const [key, kind] of PERIOD_NUMBERS) add(key, kind, ai, pi, p.summary, key)
    })
  })
  return out
}

const fieldOf = (slot: Slot) => slot.parent[slot.key] as FieldOf<string | number>
const slotKey = (field: string, account: number | null, period: number | null) => `${field}|${String(account)}|${String(period)}`

/** JSON Pointer del campo dentro de la extracción (`Issue.path`). */
function pointerOf(r: Pick<FieldReading, 'field' | 'account' | 'period'>): string {
  if (r.account === null) return r.field === 'bank_name' ? '/bank_name' : `/holder/${r.field === 'holder_name' ? 'name' : 'rfc'}`
  const base = `/accounts/${String(r.account)}`
  if (r.period === null) return `${base}/${r.field}`
  const inSummary = !(PERIOD_DATES as readonly string[]).includes(r.field)
  return `${base}/periods/${String(r.period)}${inSummary ? '/summary' : ''}/${r.field}`
}

// ---------------------------------------------------------------- comparación

const LABEL: Record<ComparedField, string> = {
  bank_name: 'el nombre del banco',
  holder_name: 'el nombre del titular',
  holder_rfc: 'el RFC del titular',
  account_number: 'el número de cuenta',
  clabe: 'la CLABE',
  period_start: 'el inicio del periodo',
  period_end: 'el fin del periodo',
  statement_date: 'la fecha de corte',
  opening_balance: 'el saldo inicial',
  closing_balance: 'el saldo final',
  total_credits: 'el total de abonos',
  total_debits: 'el total de cargos',
  credits_count: 'el número de abonos',
  debits_count: 'el número de cargos',
}

const alnum = (s: string) => normalizeText(s).replace(/[^a-z0-9]/g, '')

/** ¿Es el mismo valor impreso? Tolera acentos, puntuación y espacios; no tolera un dígito distinto. */
function sameValue(kind: Kind, a: string | number, b: string | number): boolean {
  switch (kind) {
    case 'amount':
      return Math.abs(Number(a) - Number(b)) < 0.005
    case 'count':
    case 'date':
      return a === b
    case 'id':
      return String(a).toUpperCase().replace(/[\s._-]/g, '') === String(b).toUpperCase().replace(/[\s._-]/g, '')
    case 'holder':
      return alnum(String(a)) === alnum(String(b))
    case 'bank': {
      // El banco se imprime con o sin su razón social completa: uno contenido en el otro es el mismo.
      const x = alnum(String(a))
      const y = alnum(String(b))
      const [short, long] = x.length <= y.length ? [x, y] : [y, x]
      return short === long || (short.length >= 4 && long.includes(short))
    }
  }
}

/** Empareja por `ref` (A1, A1-P1); si el segundo les puso otros nombres pero hay las mismas, por posición. */
function matchByRef(first: readonly string[], second: readonly string[]): Map<number, number> {
  const norm = (r: string) => r.trim().toLowerCase()
  const matches = new Map<number, number>()
  first.forEach((ref, i) => {
    const byRef = second.findIndex((r) => norm(r) === norm(ref))
    if (byRef >= 0) matches.set(i, byRef)
    else if (first.length === second.length) matches.set(i, i)
  })
  return matches
}

/**
 * Compara dos lecturas del mismo resumen. Solo juzga los campos que la primera leyó y que no están
 * ya verificados; lo que solo leyó la segunda no es un dato que verificar.
 */
export function compareHeaders(firstOut: SummaryOut, secondOut: SummaryOut, text: PageText): FieldReading[] {
  const first = assembleSummary(firstOut, text)
  const second = assembleSummary(secondOut, text)
  const secondSlots = new Map(slotsOf(second).map((s) => [slotKey(s.field, s.account, s.period), s]))
  const accounts = matchByRef(firstOut.accounts.map((a) => a.ref), secondOut.accounts.map((a) => a.ref))
  const periods = new Map<number, Map<number, number>>()
  for (const [ai, aj] of accounts) {
    periods.set(ai, matchByRef(firstOut.accounts[ai]?.periods.map((p) => p.ref) ?? [], secondOut.accounts[aj]?.periods.map((p) => p.ref) ?? []))
  }
  const readings: FieldReading[] = []
  for (const slot of slotsOf(first)) {
    const f = fieldOf(slot)
    if (f.value === null || f.verification === 'verified') continue
    const aj = slot.account === null ? null : (accounts.get(slot.account) ?? undefined)
    const pj = slot.period === null || slot.account === null ? null : (periods.get(slot.account)?.get(slot.period) ?? undefined)
    const other = aj === undefined || pj === undefined ? undefined : secondSlots.get(slotKey(slot.field, aj, pj))
    const value = other ? fieldOf(other).value : null
    const status: Agreement = value === null ? 'only_first' : sameValue(slot.kind, f.value, value) ? 'agree' : 'disagree'
    readings.push({ field: slot.field, account: slot.account, period: slot.period, status, first: f.value, second: value })
  }
  return readings
}

// ---------------------------------------------------------------- segunda lectura

function errorText(err: unknown): string {
  if (err instanceof LlmCallError) return `${err.code}: ${err.message}`
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err)
}

/**
 * Repite la pasada 1 con otro modelo y compara. No lanza: ante cualquier falla devuelve
 * `failed` y la extracción sigue como si no se hubiera intentado.
 */
export async function headerDoubleRead(deps: { llm: StructuredLlm }, summaryOut: SummaryOut, pdfInput: PdfInput, opts: HeaderDoubleReadOptions): Promise<HeaderDoubleRead> {
  const pending = slotsOf(assembleSummary(summaryOut, opts.text)).some((s) => {
    const f = fieldOf(s)
    return f.value !== null && f.verification !== 'verified'
  })
  if (!pending) return { status: 'skipped' }
  // Con el mismo modelo, mismo prompt y mismo effort la caché devolvería la primera respuesta y el
  // "acuerdo" no probaría nada; con otro effort seguiría siendo la misma opinión.
  if (opts.model === opts.firstModel) return { status: 'failed', reason: `el modelo de la segunda lectura es el mismo que leyó primero (${opts.model})` }
  try {
    const res = await opts.limit(() =>
      deps.llm.call({
        purpose: 'double_read',
        model: opts.model,
        system: opts.system,
        document: pdfInput,
        instruction: opts.instruction,
        schema: ExtractionChunk,
        schemaName: EXTRACTION_SCHEMA_NAME,
        promptVersion: opts.promptVersion,
        effort: DOUBLE_READ_EFFORT,
        maxOutputTokens: DOUBLE_READ_MAX_OUTPUT_TOKENS,
        serverFallback: supportsServerFallback(opts.model),
      }),
    )
    opts.record('double_read', opts.promptVersion, DOUBLE_READ_EFFORT, [], res)
    if (res.object.summary === null) return { status: 'failed', reason: 'la segunda lectura no devolvió resumen' }
    return { status: 'done', model: res.model, readings: compareHeaders(summaryOut, res.object.summary, opts.text) }
  } catch (err) {
    return { status: 'failed', reason: errorText(err) }
  }
}

/**
 * Aplica el resultado al resumen ensamblado de la primera lectura y deja los issues. Devuelve true
 * si la segunda lectura se hizo (bandera `header_double_read`).
 */
export function applyHeaderDoubleRead(read: HeaderDoubleRead, summary: AssembledSummary, issues: IssueSink): boolean {
  if (read.status === 'skipped') return false
  if (read.status === 'failed') {
    issues.add({ code: 'block_failed', severity: 'info', message: `No se hizo la doble lectura del encabezado (${read.reason}); los valores siguen sin verificar contra una segunda lectura.` })
    return false
  }
  const slots = new Map(slotsOf(summary).map((s) => [slotKey(s.field, s.account, s.period), s]))
  for (const r of read.readings) {
    const slot = slots.get(slotKey(r.field, r.account, r.period))
    if (!slot || r.status === 'only_first') continue
    const f = fieldOf(slot)
    if (r.status === 'agree') {
      // Un valor extraído verificado debe citar su fuente (contrato): sin cita no hay con qué respaldarlo.
      if (f.source !== null) slot.parent[slot.key] = { ...f, verification: 'verified', confidence: Math.max(f.confidence, AGREED_CONFIDENCE) }
      continue
    }
    slot.parent[slot.key] = { ...f, verification: 'conflict', confidence: Math.min(f.confidence, CONFLICT_CONFIDENCE) }
    const account = r.account === null ? null : (summary.accounts[r.account] ?? null)
    issues.add({
      code: 'header_read_conflict',
      severity: 'warning',
      message: `Las dos lecturas del documento no coinciden en ${LABEL[r.field]}; el valor queda en conflicto.`,
      page: f.source?.page ?? null,
      path: pointerOf(r),
      account_id: account?.id ?? null,
      period_id: r.period === null ? null : (account?.periods[r.period]?.id ?? null),
      details: { first: r.first, second: r.second },
    })
  }
  return true
}
