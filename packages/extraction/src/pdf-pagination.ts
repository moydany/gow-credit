/**
 * Pagination the bank prints on each page: which pages are missing, whether the PDF holds several
 * statements glued together and how many there are by CFDI. Works on already-read text only.
 */
import type { FiscalDocument, TextLayer } from '@gow/contracts'

/** Numbering the bank prints on a page: "Pág. 3 de 17" is `{ printed: 3, total: 17 }`. */
export interface PageNumbering {
  /** PDF page (1 = first). */
  page: number
  /** Printed page number, or null if none found. */
  printed: number | null
  /** Printed total pages ("de 17"), or null. */
  total: number | null
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// "Pág. 3 de 17", "Página 3/17", "Pag 3/3", "Hoja 3 de 17", "Page 3 of 17" (accents and case already stripped).
const KEYWORD_PAGE = /\b(?:pagina|pag|pg|hoja|page)\b\.?\s*(?:no\.?|num\.?|numero|#|:)?\s*(\d{1,4})(?:\s*(?:de|of|\/)\s*(\d{1,4}))?(?!\d)/g
// "3 de 17" or "3/17" alone on their line (footer or header).
const BARE_PAGE = /^-?\s*(\d{1,4})\s*(?:de|of|\/)\s*(\d{1,4})\s*-?$/
const EDGE_LINES = 3

interface PageCandidate {
  printed: number
  total: number | null
  kind: 'keyword' | 'bare'
  edge: 'tail' | 'head' | 'body'
  line: number
}

const validNumbering = (printed: number, total: number | null) => printed >= 1 && printed <= 9999 && (total === null || (total >= printed && total <= 9999))

function pageCandidates(text: string): PageCandidate[] {
  const lines = text
    .split('\n')
    .map((l) => fold(l).replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
  const out: PageCandidate[] = []
  lines.forEach((line, i) => {
    const edge = i >= lines.length - EDGE_LINES ? 'tail' : i < EDGE_LINES ? 'head' : 'body'
    for (const m of line.matchAll(KEYWORD_PAGE)) {
      const printed = Number(m[1])
      const total = m[2] === undefined ? null : Number(m[2])
      if (!validNumbering(printed, total)) continue
      // "Página 3" with no total only counts at the end of a header or footer line: in the body it
      // is a reference.
      if (total === null && (edge === 'body' || line.slice(m.index + m[0].length).trim().length > 0)) continue
      out.push({ printed, total, kind: 'keyword', edge, line: i })
    }
    const bare = edge === 'body' ? null : BARE_PAGE.exec(line)
    if (bare) {
      const printed = Number(bare[1])
      const total = Number(bare[2])
      if (validNumbering(printed, total)) out.push({ printed, total, kind: 'bare', edge, line: i })
    }
  })
  return out
}

const EDGE_RANK = { tail: 0, head: 1, body: 2 } as const

/** A page's numbering: keyword form before bare, footer before header. */
function bestCandidate(candidates: readonly PageCandidate[]): PageCandidate | null {
  const rank = (c: PageCandidate) => (c.kind === 'keyword' ? 0 : 10) + EDGE_RANK[c.edge]
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.line - b.line)[0] ?? null
}

/**
 * What Mexican banks print: `Pág. 3 de 17`, `Página 3/17`, `Pag 3/3`, `Hoja 3 de 17`, `3 de 17` or
 * `3/17` alone in the footer or header, with and without accent. Only with an `ok` or `partial`
 * text layer: in `vision_only` there is no text to read it from and everything is `null`.
 *
 * A bare `3/17` is easily confused with a date (`03/05`), so it is only accepted if all of them in
 * the document share the total and the numbers change from page to page.
 */
export function printedPagination(pageTexts: readonly string[], textLayer: TextLayer = 'ok'): PageNumbering[] {
  if (textLayer !== 'ok' && textLayer !== 'partial') return pageTexts.map((_, i) => ({ page: i + 1, printed: null, total: null }))
  const picked = pageTexts.map((t) => bestCandidate(pageCandidates(t)))
  const bare = picked.filter((c): c is PageCandidate => c?.kind === 'bare')
  const bareTrusted = bare.length === 0 || (new Set(bare.map((c) => c.total)).size === 1 && (new Set(bare.map((c) => c.printed)).size >= 2 || (bare.length === 1 && bare[0]?.printed === 1)))
  return picked.map((c, i) => (c !== null && (c.kind === 'keyword' || bareTrusted) ? { page: i + 1, printed: c.printed, total: c.total } : { page: i + 1, printed: null, total: null }))
}

interface PaginationScope {
  /** Repeated pages: not pages of the document, they do not count. */
  exclude?: ReadonlySet<number>
  /** Text per page, to avoid mistaking the fiscal invoice for another statement. */
  pageTexts?: readonly string[]
}

function realPages(pagination: readonly PageNumbering[], scope: PaginationScope): PageNumbering[] {
  return pagination.filter((p) => !scope.exclude?.has(p.page))
}

/**
 * Numbering is usable if half the pages carry it: a lone `3 de 5` on a page of a ten-page PDF
 * proves nothing.
 */
export function paginationReliable(pagination: readonly PageNumbering[], scope: PaginationScope = {}): boolean {
  const real = realPages(pagination, scope)
  const numbered = real.filter((p) => p.printed !== null).length
  return numbered > 0 && numbered * 2 >= real.length
}

/** A printed fiscal invoice (folio fiscal, seals, original string) may carry its own numbering. */
const FISCAL_MARKERS = ['sello digital', 'cadena original', 'folio fiscal', 'comprobante fiscal', 'certificado del sat', 'regimen fiscal']
function looksFiscal(text: string | undefined): boolean {
  const t = fold(text ?? '')
  return FISCAL_MARKERS.filter((m) => t.includes(m)).length >= 2
}

/** Splits pages into documents: a `1` after a page with a higher number is a restart. */
function splitRuns(real: readonly PageNumbering[], pageTexts: readonly string[] | undefined): PageNumbering[][] {
  const runs: PageNumbering[][] = []
  let current: PageNumbering[] = []
  let last: number | null = null
  for (const p of real) {
    const isRestart = p.printed === 1 && last !== null && last > 1
    if (isRestart && looksFiscal(pageTexts?.[p.page - 1])) {
      // It takes its place in the document, but its own numbering does not count.
      current.push({ page: p.page, printed: null, total: null })
      continue
    }
    if (isRestart) {
      runs.push(current)
      current = []
    }
    current.push(p)
    if (p.printed !== null) last = p.printed
  }
  if (current.length > 0) runs.push(current)
  return runs
}

export interface MultipleStatements {
  /** How many statements the PDF holds (1 if none restarts). */
  documents: number
  /** PDF pages where each document after the first starts. */
  restartsAt: number[]
}

/**
 * Does the PDF hold more than one statement? A `printed === 1` **after** a page with
 * `printed > 1` is a numbering restart: another document. Without reliable numbering (vision
 * only, or almost no page prints it) it cannot tell and returns one.
 */
export function multipleStatements(pagination: readonly PageNumbering[], scope: PaginationScope = {}): MultipleStatements {
  if (!paginationReliable(pagination, scope)) return { documents: 1, restartsAt: [] }
  const runs = splitRuns(realPages(pagination, scope), scope.pageTexts)
  return { documents: Math.max(1, runs.length), restartsAt: runs.slice(1).flatMap((r) => (r[0] ? [r[0].page] : [])) }
}

/** The total a document prints: the most repeated, the larger on a tie. */
function runTotal(run: readonly PageNumbering[]): number | null {
  const counts = new Map<number, number>()
  for (const p of run) if (p.total !== null) counts.set(p.total, (counts.get(p.total) ?? 0) + 1)
  let best: number | null = null
  for (const [total, n] of counts) {
    const bestN = best === null ? 0 : (counts.get(best) ?? 0)
    if (best === null || n > bestN || (n === bestN && total > best)) best = total
  }
  return best
}

/**
 * Printed numbers missing from a document: before the first numbered page, between two
 * consecutive ones and, with a known total, at the end. An unnumbered page between two numbered
 * ones takes a slot: something the PDF does carry is not reported missing.
 */
function missingInRun(run: readonly PageNumbering[], total: number | null, pagesAfterLast: number): number[] {
  const detected = run.flatMap((p, idx) => (p.printed === null ? [] : [{ idx, printed: p.printed }]))
  const first = detected[0]
  const last = detected.at(-1)
  if (first === undefined || last === undefined) return []
  const missing: number[] = []
  const push = (from: number, to: number) => {
    for (let n = from; n <= to; n++) missing.push(n)
  }
  const lead = first.printed - 1 - first.idx
  if (lead > 0) push(1, lead)
  detected.forEach((b, i) => {
    const a = detected[i - 1]
    if (a === undefined || b.printed <= a.printed) return
    const expected = b.printed - a.printed - 1
    const actual = b.idx - a.idx - 1
    if (expected > actual) push(a.printed + actual + 1, b.printed - 1)
  })
  // At the end, physical sheets after the last numbered one count, repeated included: Banamex
  // closes with seven unnumbered sheets (ads, five identical) and misses none.
  if (total !== null && last.printed <= total) {
    const expected = total - last.printed
    if (expected > pagesAfterLast) push(last.printed + pagesAfterLast + 1, total)
  }
  return missing
}

export interface MissingPages {
  /** Printed page numbers absent from the PDF. */
  missing: number[]
  total: number | null
}

/**
 * Pages missing according to the printed numbering. With a known `total`, the numbers between 1
 * and `total` that are absent (and gaps between consecutive ones), including trailing ones if the
 * PDF has fewer pages than the total. Empty if the numbering is not reliable.
 */
export function missingPrintedPages(pagination: readonly PageNumbering[], scope: PaginationScope = {}): MissingPages {
  if (!paginationReliable(pagination, scope)) return { missing: [], total: null }
  const runs = splitRuns(realPages(pagination, scope), scope.pageTexts)
  const missing = new Set<number>()
  let total: number | null = null
  runs.forEach((run, ri) => {
    const printedTotal = runTotal(run)
    total ??= printedTotal
    // Unnumbered physical sheets after the last numbered one (repeated included) take a slot.
    // A repeated page that does carry a number copies a page already there; it is not the missing one.
    const lastNumbered = [...run].reverse().find((p) => p.printed !== null)
    const nextStart = runs[ri + 1]?.[0]?.page ?? pagination.length + 1
    const pagesAfterLast = lastNumbered === undefined ? 0 : pagination.filter((p) => p.page > lastNumbered.page && p.page < nextStart && p.printed === null).length
    for (const n of missingInRun(run, printedTotal, pagesAfterLast)) missing.add(n)
  })
  return { missing: [...missing].sort((a, b) => a - b), total }
}

// ---------------------------------------------------------------- several statements by their CFDI

const UUID_FORMAT = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

/**
 * Banks print one income CFDI per statement: two or more with different UUIDs stamped on
 * different days are several statements (one per stamp day). Santander with two products prints
 * only one, and a three-month period (Mercado Pago) has none: `multi_account` and `multi_period`
 * do not count. Returns 1 if there is no proof of more than one.
 */
export function fiscalStatementCount(fiscal: readonly Pick<FiscalDocument, 'kind' | 'uuid' | 'certified_at'>[]): number {
  const dayOf = new Map<string, string>()
  for (const f of fiscal) {
    const uuid = f.uuid.value?.trim().toUpperCase()
    const certifiedAt = f.certified_at.value
    if (f.kind !== 'income' || !uuid || !UUID_FORMAT.test(uuid) || !certifiedAt) continue
    if (!dayOf.has(uuid)) dayOf.set(uuid, certifiedAt.slice(0, 10))
  }
  const days = new Set(dayOf.values())
  return days.size >= 2 ? days.size : 1
}

/**
 * Failure reason for a PDF with several statements; same text as `multipleStatementsReason` in
 * `@gow/contracts`.
 */
export function multipleStatementsReason(count: number): string {
  return `el PDF trae ${String(count)} estados de cuenta`
}
