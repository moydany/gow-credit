/**
 * Header double read for documents with no local text.
 *
 * On the `vision_only` route there is no text layer to check the cited summary values against
 * (holder, RFC, account, CLABE, period, balances, totals): all stay `unverified` and the
 * statement's age cannot even be computed. The second read repeats pass 1 (same prompt, same
 * schema) with a model from the other family (`plan.doubleRead`, medium `effort`) and compares
 * field by field:
 *
 * - they agree -> `verified` (the source stays the first read's quote);
 * - they differ -> `conflict` and the `header_read_conflict` issue;
 * - the second did not read it -> left as it was.
 *
 * If the second read fails (provider down, no key, no cached response) the document ships as
 * before, with an informational issue. A value already verified against the text (HSBC with its
 * repaired EBCDIC layer) is not judged again: matching the text beats a second read. Format
 * validators and the arithmetic balance check run afterwards in `extract.ts` and override this.
 */
import type { TokenUsage } from '@gow/contracts'
import { LlmCallError, type Effort, type Limiter, type PdfInput, type StructuredLlm } from '@gow/llm'
import { assembleSummary, type AssembledSummary, type FieldOf } from './assemble.ts'
import type { IssueSink } from './issues.ts'
import { ExtractionChunk, EXTRACTION_SCHEMA_NAME, type SummaryOut } from './llm-schema.ts'
import { normalizeText } from './normalize.ts'
import type { PageText } from './page-text.ts'
import { supportsServerFallback } from './router.ts'

/** Header values that get compared; the rest of the summary (product, fees...) is not. */
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
  /** Index of the account/period in `summary.accounts`; null when the field is not at that level. */
  account: number | null
  period: number | null
  status: Agreement
  /** Values normalized as `assembleSummary` leaves them (ISO dates, amounts as numbers). */
  first: string | number
  second: string | number | null
}

export type HeaderDoubleRead =
  | { status: 'done'; model: string; readings: FieldReading[] }
  /** Not needed or nothing to compare with: no call and no notice. */
  | { status: 'skipped' }
  /** Could not run: the document stays as is and an informational issue is raised. */
  | { status: 'failed'; reason: string }

export const DOUBLE_READ_EFFORT: Effort = 'medium'
const DOUBLE_READ_MAX_OUTPUT_TOKENS = 16_000
/** Confidence for a field both no-text reads agree on: below a quote checked on the page (0.95). */
const AGREED_CONFIDENCE = 0.9
const CONFLICT_CONFIDENCE = 0.3

type RecordedCall = { model: string; usage: TokenUsage; costUsd: number; latencyMs: number; responseCacheHit: boolean }

export interface HeaderDoubleReadOptions {
  /** Local PDF text; only used to normalize both reads the same way as the first. */
  text: PageText
  /** Model for the second read (`plan.doubleRead`). */
  model: string
  /** Model that did pass 1: if it is the same, the second read would not be a second opinion. */
  firstModel: string
  system: string
  /** The same text pass 1 got, vision note included. */
  instruction: string
  promptVersion: string
  limit: Limiter
  /** `record` from `extract.ts`: logs the call in `extraction.calls` with its cost and cache hit. */
  record: (purpose: string, prompt: string | null, effort: Effort | null, pages: number[], r: RecordedCall) => void
}

// ---------------------------------------------------------------- summary fields

type Kind = 'bank' | 'holder' | 'id' | 'date' | 'amount' | 'count'

interface Slot {
  field: ComparedField
  kind: Kind
  account: number | null
  period: number | null
  /** The object holding the field and its key, to read and replace it. */
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

/** Every comparable field of a summary, with its location, in `assembleSummary` order and indexes. */
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

/** JSON Pointer of the field within the extraction (`Issue.path`). */
function pointerOf(r: Pick<FieldReading, 'field' | 'account' | 'period'>): string {
  if (r.account === null) return r.field === 'bank_name' ? '/bank_name' : `/holder/${r.field === 'holder_name' ? 'name' : 'rfc'}`
  const base = `/accounts/${String(r.account)}`
  if (r.period === null) return `${base}/${r.field}`
  const inSummary = !(PERIOD_DATES as readonly string[]).includes(r.field)
  return `${base}/periods/${String(r.period)}${inSummary ? '/summary' : ''}/${r.field}`
}

// ---------------------------------------------------------------- comparison

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

/** Same printed value? Tolerates accents, punctuation and spacing; not a different digit. */
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
      // The bank prints with or without its full legal name: one contained in the other is the same.
      const x = alnum(String(a))
      const y = alnum(String(b))
      const [short, long] = x.length <= y.length ? [x, y] : [y, x]
      return short === long || (short.length >= 4 && long.includes(short))
    }
  }
}

/** Pairs by `ref` (A1, A1-P1); if the second renamed them but the counts match, pairs by position. */
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

function resolveSecondSlot(
  slot: Slot,
  accounts: Map<number, number>,
  periods: Map<number, Map<number, number>>,
  secondSlots: Map<string, Slot>,
): Slot | undefined {
  if (slot.account === null) return secondSlots.get(slotKey(slot.field, null, null))
  const aj = accounts.get(slot.account)
  if (aj === undefined) return undefined
  if (slot.period === null) return secondSlots.get(slotKey(slot.field, aj, null))
  const pj = periods.get(slot.account)?.get(slot.period)
  if (pj === undefined) return undefined
  return secondSlots.get(slotKey(slot.field, aj, pj))
}

function compareSingleSlot(
  slot: Slot,
  accounts: Map<number, number>,
  periods: Map<number, Map<number, number>>,
  secondSlots: Map<string, Slot>,
): FieldReading | null {
  const f = fieldOf(slot)
  if (f.value === null || f.verification === 'verified') return null
  const other = resolveSecondSlot(slot, accounts, periods, secondSlots)
  const value = other ? fieldOf(other).value : null
  let status: Agreement = 'only_first'
  if (value !== null) {
    status = sameValue(slot.kind, f.value, value) ? 'agree' : 'disagree'
  }
  return { field: slot.field, account: slot.account, period: slot.period, status, first: f.value, second: value }
}

/**
 * Compares two reads of the same summary. Only judges fields the first read produced and that are
 * not already verified; a field only the second read produced has nothing to verify.
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
    const reading = compareSingleSlot(slot, accounts, periods, secondSlots)
    if (reading !== null) readings.push(reading)
  }
  return readings
}

// ---------------------------------------------------------------- second read

function errorText(err: unknown): string {
  if (err instanceof LlmCallError) return `${err.code}: ${err.message}`
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err)
}

/**
 * Repeats pass 1 with another model and compares. Never throws: on any failure it returns
 * `failed` and the extraction continues as if it had not been attempted.
 */
export async function headerDoubleRead(deps: { llm: StructuredLlm }, summaryOut: SummaryOut, pdfInput: PdfInput, opts: HeaderDoubleReadOptions): Promise<HeaderDoubleRead> {
  const pending = slotsOf(assembleSummary(summaryOut, opts.text)).some((s) => {
    const f = fieldOf(s)
    return f.value !== null && f.verification !== 'verified'
  })
  if (!pending) return { status: 'skipped' }
  // Same model, prompt and effort would hit the cache and return the first answer, so the
  // "agreement" would prove nothing; a different effort would still be the same opinion.
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

function applyReading(
  r: FieldReading,
  slot: Slot,
  summary: AssembledSummary,
  issues: IssueSink,
): void {
  const f = fieldOf(slot)
  if (r.status === 'agree') {
    if (f.source !== null) slot.parent[slot.key] = { ...f, verification: 'verified', confidence: Math.max(f.confidence, AGREED_CONFIDENCE) }
    return
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

/**
 * Applies the result to the first read's assembled summary and records the issues. Returns true
 * if the second read happened (flag `header_double_read`).
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
    applyReading(r, slot, summary, issues)
  }
  return true
}
