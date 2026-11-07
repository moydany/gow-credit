/**
 * Paginación que imprime el banco en cada página (ADR 0057): qué páginas faltan, si el PDF trae varios
 * estados de cuenta pegados y cuántos hay según los CFDI. Trabaja sobre el texto ya leído, sin tocar el PDF.
 */
import type { FiscalDocument, TextLayer } from '@gow/contracts'

/** Numeración que imprime el banco en una página: "Pág. 3 de 17" es `{ printed: 3, total: 17 }`. */
export interface PageNumbering {
  /** Página del PDF (1 = primera). */
  page: number
  /** Número de página impreso, o null si no se encontró. */
  printed: number | null
  /** Total de páginas impreso ("de 17"), o null. */
  total: number | null
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// "Pág. 3 de 17", "Página 3/17", "Pag 3/3", "Hoja 3 de 17", "Page 3 of 17" (ya sin acentos ni mayúsculas).
const KEYWORD_PAGE = /\b(?:pagina|pag|pg|hoja|page)\b\.?\s*(?:no\.?|num\.?|numero|#|:)?\s*(\d{1,4})(?:\s*(?:de|of|\/)\s*(\d{1,4}))?(?!\d)/g
// "3 de 17" o "3/17" solos en su línea (al pie o al encabezado).
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
      // "Página 3" sin total solo cuenta como remate de una línea de encabezado o pie: en el cuerpo es una referencia.
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

/** La numeración de la página: con palabra clave antes que sola, al pie antes que al encabezado. */
function bestCandidate(candidates: readonly PageCandidate[]): PageCandidate | null {
  const rank = (c: PageCandidate) => (c.kind === 'keyword' ? 0 : 10) + EDGE_RANK[c.edge]
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.line - b.line)[0] ?? null
}

/**
 * Lo que imprimen los bancos mexicanos: `Pág. 3 de 17`, `Página 3/17`, `Pag 3/3`, `Hoja 3 de 17`,
 * `3 de 17` o `3/17` solos al pie o al encabezado, con y sin acento. Solo con capa de texto `ok` o
 * `partial`: en `vision_only` no hay texto contra qué leerla y todo queda en `null`.
 *
 * El `3/17` suelto se confunde con una fecha (`03/05`), así que solo se acepta si todos los que hay
 * en el documento comparten el total y los números cambian de página a página.
 */
export function printedPagination(pageTexts: readonly string[], textLayer: TextLayer = 'ok'): PageNumbering[] {
  if (textLayer !== 'ok' && textLayer !== 'partial') return pageTexts.map((_, i) => ({ page: i + 1, printed: null, total: null }))
  const picked = pageTexts.map((t) => bestCandidate(pageCandidates(t)))
  const bare = picked.filter((c): c is PageCandidate => c?.kind === 'bare')
  const bareTrusted = bare.length === 0 || (new Set(bare.map((c) => c.total)).size === 1 && (new Set(bare.map((c) => c.printed)).size >= 2 || (bare.length === 1 && bare[0]?.printed === 1)))
  return picked.map((c, i) => (c !== null && (c.kind === 'keyword' || bareTrusted) ? { page: i + 1, printed: c.printed, total: c.total } : { page: i + 1, printed: null, total: null }))
}

interface PaginationScope {
  /** Páginas repetidas: no son páginas del documento y no cuentan. */
  exclude?: ReadonlySet<number>
  /** Texto por página, para no confundir el comprobante fiscal con otro estado de cuenta. */
  pageTexts?: readonly string[]
}

function realPages(pagination: readonly PageNumbering[], scope: PaginationScope): PageNumbering[] {
  return pagination.filter((p) => !scope.exclude?.has(p.page))
}

/**
 * La numeración sirve si la mitad de las páginas la trae: un `3 de 5` suelto en una página de un
 * PDF de diez no prueba nada.
 */
export function paginationReliable(pagination: readonly PageNumbering[], scope: PaginationScope = {}): boolean {
  const real = realPages(pagination, scope)
  const numbered = real.filter((p) => p.printed !== null).length
  return numbered > 0 && numbered * 2 >= real.length
}

/** Un comprobante fiscal impreso (folio fiscal, sellos, cadena original) puede traer su propia numeración. */
const FISCAL_MARKERS = ['sello digital', 'cadena original', 'folio fiscal', 'comprobante fiscal', 'certificado del sat', 'regimen fiscal']
function looksFiscal(text: string | undefined): boolean {
  const t = fold(text ?? '')
  return FISCAL_MARKERS.filter((m) => t.includes(m)).length >= 2
}

/** Corta las páginas en documentos: un `1` después de una página con número mayor es un reinicio. */
function splitRuns(real: readonly PageNumbering[], pageTexts: readonly string[] | undefined): PageNumbering[][] {
  const runs: PageNumbering[][] = []
  let current: PageNumbering[] = []
  let last: number | null = null
  for (const p of real) {
    const isRestart = p.printed === 1 && last !== null && last > 1
    if (isRestart && looksFiscal(pageTexts?.[p.page - 1])) {
      // Ocupa su lugar en el documento, pero su numeración propia no cuenta.
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
  /** Cuántos estados de cuenta trae el PDF (1 si ninguno reinicia). */
  documents: number
  /** Páginas del PDF donde empieza cada documento después del primero. */
  restartsAt: number[]
}

/**
 * ¿Trae el PDF más de un estado de cuenta? Un `printed === 1` que aparece **después** de una página con
 * `printed > 1` es un reinicio de la numeración: hay otro documento. Sin numeración confiable (visión sola,
 * o casi ninguna página la imprime) no se puede decir y devuelve uno.
 */
export function multipleStatements(pagination: readonly PageNumbering[], scope: PaginationScope = {}): MultipleStatements {
  if (!paginationReliable(pagination, scope)) return { documents: 1, restartsAt: [] }
  const runs = splitRuns(realPages(pagination, scope), scope.pageTexts)
  return { documents: Math.max(1, runs.length), restartsAt: runs.slice(1).flatMap((r) => (r[0] ? [r[0].page] : [])) }
}

/** El total que imprime un documento: el más repetido, y en empate el mayor. */
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
 * Números impresos que faltan en un documento: antes de la primera página numerada, entre dos
 * consecutivas y, con total conocido, al final. Una página sin número impreso entre dos numeradas
 * ocupa un lugar: no se reporta como faltante algo que el PDF sí trae.
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
  // Al final cuentan las hojas físicas que siguen a la última numerada, repetidas incluidas: Banamex cierra
  // con siete hojas sin número (publicidad, cinco iguales) y no le falta ninguna.
  if (total !== null && last.printed <= total) {
    const expected = total - last.printed
    if (expected > pagesAfterLast) push(last.printed + pagesAfterLast + 1, total)
  }
  return missing
}

export interface MissingPages {
  /** Números de página impresos que no están en el PDF. */
  missing: number[]
  total: number | null
}

/**
 * Páginas que faltan según la numeración impresa. Con `total` conocido, los números entre 1 y `total`
 * que no están (y los huecos entre consecutivos); también las últimas, si el PDF trae menos páginas
 * que el total. Vacío si la numeración no es confiable.
 */
export function missingPrintedPages(pagination: readonly PageNumbering[], scope: PaginationScope = {}): MissingPages {
  if (!paginationReliable(pagination, scope)) return { missing: [], total: null }
  const runs = splitRuns(realPages(pagination, scope), scope.pageTexts)
  const missing = new Set<number>()
  let total: number | null = null
  runs.forEach((run, ri) => {
    const printedTotal = runTotal(run)
    total ??= printedTotal
    // Hojas físicas sin número impreso después de la última numerada (repetidas incluidas): ocupan un lugar.
    // Una repetida que sí trae número es otra copia de una página que ya está, no la que falta.
    const lastNumbered = [...run].reverse().find((p) => p.printed !== null)
    const nextStart = runs[ri + 1]?.[0]?.page ?? pagination.length + 1
    const pagesAfterLast = lastNumbered === undefined ? 0 : pagination.filter((p) => p.page > lastNumbered.page && p.page < nextStart && p.printed === null).length
    for (const n of missingInRun(run, printedTotal, pagesAfterLast)) missing.add(n)
  })
  return { missing: [...missing].sort((a, b) => a - b), total }
}

// ---------------------------------------------------------------- varios estados por sus CFDI (ADR 0057)

const UUID_FORMAT = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

/**
 * Los bancos imprimen un CFDI de ingreso por estado de cuenta: dos o más con UUID distinto y timbrados
 * en días distintos son varios estados de cuenta (uno por día de timbrado). Santander con dos productos
 * imprime uno solo, y un periodo de tres meses (Mercado Pago) no trae ninguno: `multi_account` y
 * `multi_period` no cuentan. Devuelve 1 si no hay prueba de más de uno.
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
 * Motivo de falla de un PDF con varios estados de cuenta. Es el mismo texto que `multipleStatementsReason`
 * de `@gow/contracts` (agente `channels`); se deja aquí mientras esa función no exista, para que quien
 * integra solo cambie el import.
 */
export function multipleStatementsReason(count: number): string {
  return `el PDF trae ${String(count)} estados de cuenta`
}
