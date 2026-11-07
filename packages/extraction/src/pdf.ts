/**
 * Lectura local del PDF: hash, número de páginas y texto por página con pdfjs (JS puro, sin
 * binarios del sistema). El texto local sirve para dos cosas: decidir la ruta (texto y
 * visión, o solo visión) y verificar que lo extraído por el modelo esté en la página citada.
 *
 * También mira el documento como objeto (ADR 0057): la paginación que imprime el banco (páginas
 * que faltan, varios estados de cuenta pegados), las páginas repetidas (por la lista de operadores
 * de cada página) y las páginas giradas. Al modelo se le manda el PDF original, salvo que haya
 * páginas giradas: entonces va una copia enderezada con `pdf-lib`. El hash y el tamaño siguen
 * siendo los del archivo original.
 */
import { createHash, type Hash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DocumentFlag, FiscalDocument, TextLayer } from '@gow/contracts'
import { degrees, PDFDocument } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { IssueSink } from './issues.ts'
import { normalizeText } from './normalize.ts'

export interface LoadedPdf {
  fileName: string
  /** Los bytes del archivo original. */
  bytes: Uint8Array
  /**
   * Lo que se le manda al modelo: el original, o una copia con las páginas giradas enderezadas
   * (`straightened`). `sha256` y `sizeBytes` son siempre los del original.
   */
  base64: string
  sha256: string
  sizeBytes: number
  pageCount: number
  /** Texto por página (índice 0 = página 1), ya reparado si se pudo. */
  pageTexts: string[]
  textLayer: TextLayer
  /** true si la capa venía en EBCDIC y se decodificó (caso HSBC). */
  textRepaired: boolean
  /** Numeración impresa por página (`printed` y `total` nulos sin capa de texto utilizable). */
  pagination: PageNumbering[]
  /** Páginas del PDF (1 = primera) que repiten una página anterior; sus filas no cuentan. */
  duplicatePages: number[]
  /** Cada página repetida con la que repite. */
  duplicates: PageDuplicate[]
  /** Páginas cuyo texto está girado respecto a cómo se muestran. */
  rotatedPages: PageRotation[]
  /** true si `base64` es la copia enderezada y no el original. */
  straightened: boolean
}

interface TextItem {
  str: string
  transform: number[]
}

/** Dirección del texto en el espacio del PDF, en grados contra las manecillas del reloj. */
export type TextAngle = 0 | 90 | 180 | 270

const ANGLES = [0, 90, 180, 270] as const
const ANGLE_TOLERANCE_DEG = 10

/** Hacia dónde corre la línea de texto de un item (`|a| < 0.1 && |b| > 0.9` es 90 o 270), o null si va en diagonal. */
function itemAngle(transform: readonly number[]): TextAngle | null {
  const a = transform[0] ?? 0
  const b = transform[1] ?? 0
  if (a === 0 && b === 0) return null
  const deg = (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360
  const nearest = Math.round(deg / 90) % 4
  const off = Math.abs(deg - nearest * 90)
  if (Math.min(off, 360 - off) > ANGLE_TOLERANCE_DEG) return null
  return ANGLES[nearest] ?? null
}

/** Con menos texto que esto una página no tiene una orientación confiable (una nota vertical en el margen no la gira). */
const MIN_ORIENTATION_CHARS = 20

/**
 * Orientación mayoritaria del texto de una página (ponderada por caracteres), o null si no hay
 * texto suficiente o no hay una orientación clara. 0 es el texto normal, de izquierda a derecha.
 */
export function dominantTextAngle(items: readonly { str: string; transform: readonly number[] }[]): TextAngle | null {
  const weight = new Map<TextAngle, number>()
  let total = 0
  for (const it of items) {
    const angle = itemAngle(it.transform)
    const chars = it.str.trim().length
    if (angle === null || chars === 0) continue
    weight.set(angle, (weight.get(angle) ?? 0) + chars)
    total += chars
  }
  if (total < MIN_ORIENTATION_CHARS) return null
  let best: TextAngle = 0
  for (const angle of ANGLES) if ((weight.get(angle) ?? 0) > (weight.get(best) ?? 0)) best = angle
  return (weight.get(best) ?? 0) / total >= 0.6 ? best : null
}

/**
 * Reconstruye líneas agrupando por la coordenada que no cambia a lo largo de la línea y ordenando
 * en el sentido en que se lee. Con el texto normal (0) son filas de arriba abajo y de izquierda a
 * derecha; con el texto girado las líneas son columnas del espacio del PDF (se agrupa por `x` y se
 * ordena por `y`), en el orden en que se leería la página puesta derecha.
 */
function itemsToText(items: TextItem[], angle: TextAngle = 0): string {
  const vertical = angle === 90 || angle === 270
  // Sentido en que crece la coordenada de línea (y, o x si es vertical) de la primera línea a la última,
  // y el sentido en que crece la coordenada a lo largo de la línea.
  const lineDirection = angle === 0 || angle === 270 ? -1 : 1
  const alongDirection = angle === 0 || angle === 90 ? 1 : -1
  const rows = new Map<number, { at: number; s: string }[]>()
  for (const it of items) {
    if (!it.str) continue
    const across = it.transform[vertical ? 4 : 5] ?? 0
    const along = it.transform[vertical ? 5 : 4] ?? 0
    const line = Math.round(across / 2) * 2
    const row = rows.get(line) ?? []
    row.push({ at: along, s: it.str })
    rows.set(line, row)
  }
  return [...rows.entries()]
    .sort((a, b) => (a[0] - b[0]) * lineDirection)
    .map(([, row]) =>
      row
        .sort((a, b) => (a.at - b.at) * alongDirection)
        .map((r) => r.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join('\n')
}

const SPANISH_MARKERS = /\b(saldo|cuenta|periodo|fecha|total|dep[oó]sito|retiro|cargo|abono|movimientos|estado)\b/gi
const AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b/g

/** Puntaje de legibilidad: marcadores en español y montos con formato mexicano. */
function readability(text: string): { markers: number; amounts: number; letters: number; weird: number } {
  const markers = text.match(SPANISH_MARKERS)?.length ?? 0
  const amounts = text.match(AMOUNT)?.length ?? 0
  const letters = text.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/g)?.length ?? 0
  const weird = text.match(/[^\s\x20-\x7EÁÉÍÓÚÑÜáéíóúñü¿¡°ºª$€]/g)?.length ?? 0
  return { markers, amounts, letters, weird }
}

/**
 * Algunos PDFs (HSBC en desarrollo) traen fuentes Type 3 cuyo texto sale en EBCDIC leído
 * como Latin-1: "ÃäÅÕãÁ@ÔÁÅâãÙÁ" es "CUENTA MAESTRA". Se decodifica con cp037.
 */
const CP037_TO_ASCII: Record<number, string> = (() => {
  const map: Record<number, string> = { 0x40: ' ', 0x4b: '.', 0x4c: '<', 0x4d: '(', 0x4e: '+', 0x50: '&', 0x5b: '$', 0x5c: '*', 0x5d: ')', 0x5e: ';', 0x60: '-', 0x61: '/', 0x6b: ',', 0x6c: '%', 0x6d: '_', 0x6e: '>', 0x6f: '?', 0x7a: ':', 0x7b: '#', 0x7c: '@', 0x7d: "'", 0x7e: '=', 0x7f: '"' }
  const ranges: [number, string][] = [
    [0x81, 'abcdefghi'],
    [0x91, 'jklmnopqr'],
    [0xa2, 'stuvwxyz'],
    [0xc1, 'ABCDEFGHI'],
    [0xd1, 'JKLMNOPQR'],
    [0xe2, 'STUVWXYZ'],
    [0xf0, '0123456789'],
  ]
  for (const [start, chars] of ranges) for (let i = 0; i < chars.length; i++) map[start + i] = chars.charAt(i)
  // Acentos frecuentes en español en cp037.
  Object.assign(map, { 0x45: 'á', 0x51: 'é', 0x55: 'í', 0xce: 'ó', 0xde: 'ú', 0x49: 'ñ', 0x69: 'Ñ', 0x65: 'Á', 0x71: 'É', 0x75: 'Í', 0xee: 'Ó', 0xfe: 'Ú' })
  return map
})()

export function decodeEbcdic(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += ch === '\n' ? '\n' : code <= 0xff ? (CP037_TO_ASCII[code] ?? '') : ''
  }
  return out
}

export function assessTextLayer(pageTexts: string[]): { layer: TextLayer; repaired: boolean; texts: string[] } {
  const all = pageTexts.join('\n')
  const r = readability(all)
  if (r.letters < 50) return { layer: 'absent', repaired: false, texts: pageTexts }
  const good = (x: ReturnType<typeof readability>) => x.markers >= 5 && x.amounts >= 3 && x.weird / Math.max(1, x.letters) < 0.05
  if (good(r)) {
    const weakPages = pageTexts.filter((t) => readability(t).letters > 20 && readability(t).weird / Math.max(1, readability(t).letters) > 0.2).length
    return { layer: weakPages > 0 ? 'partial' : 'ok', repaired: false, texts: pageTexts }
  }
  const decoded = pageTexts.map(decodeEbcdic)
  const d = readability(decoded.join('\n'))
  if (good(d)) return { layer: 'corrupt', repaired: true, texts: decoded }
  return { layer: 'corrupt', repaired: false, texts: pageTexts }
}

/** pdfjs rechaza con `PasswordException` un PDF que pide contraseña para abrirse. */
export function isPdfPasswordError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'PasswordException'
}

const ENCRYPT_KEY = Buffer.from('/Encrypt', 'latin1')
/** Delimitadores y espacios de PDF: tras `/Encrypt` va uno de estos, no otra letra (`/EncryptMetadata`). */
const NAME_END = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x25])

/**
 * ¿Trae el PDF un diccionario de cifrado? La llave `/Encrypt` vive en el trailer o en el
 * diccionario del xref stream, que nunca van comprimidos: basta buscarla en los bytes. Barato y sin
 * abrir el documento; no distingue si pide contraseña para abrirse o solo restringe permisos.
 */
export function hasEncryptDictionary(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = buf.indexOf(ENCRYPT_KEY); at >= 0; at = buf.indexOf(ENCRYPT_KEY, at + 1)) {
    const next = buf[at + ENCRYPT_KEY.length]
    if (next === undefined || NAME_END.has(next)) return true
  }
  return false
}

/**
 * - `none`: sin cifrado.
 * - `permissions_only`: cifrado sin contraseña de apertura (solo restringe imprimir, copiar…); se
 *   abre y se lee normal. También si pdfjs falla por otra cosa: que la extracción lo decida.
 * - `password`: pide contraseña para abrirse; no se puede leer (ADR 0049).
 *
 * pdfjs solo corre si los bytes traen `/Encrypt`: casi todos los PDFs se resuelven con la búsqueda.
 */
export type PdfProtection = 'none' | 'permissions_only' | 'password'

export async function pdfProtection(bytes: Uint8Array): Promise<PdfProtection> {
  if (!hasEncryptDictionary(bytes)) return 'none'
  let task: ReturnType<typeof getDocument> | null = null
  try {
    // Copia como Uint8Array: pdfjs no acepta un Buffer y se queda con los bytes que recibe.
    task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false })
    await task.promise
    return 'permissions_only'
  } catch (err) {
    return isPdfPasswordError(err) ? 'password' : 'permissions_only'
  } finally {
    await task?.destroy()
  }
}

// ---------------------------------------------------------------- paginación impresa (ADR 0057)

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

// ---------------------------------------------------------------- páginas repetidas (ADR 0057)

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

export interface PageDuplicate {
  /** La página repetida. */
  page: number
  /** La primera página con el mismo contenido. */
  sameAs: number
}

/** Páginas que se huellan (un escaneo grande cuesta decodificar cada imagen); las de más no se comparan por huella. */
const MAX_FINGERPRINT_PAGES = 150

const TEXT_OPS: ReadonlySet<number> = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText])
/** Las imágenes que pdfjs refiere por nombre; su contenido se pide aparte. */
const NAMED_IMAGE_OPS: ReadonlySet<number> = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat])
/** Las que traen los píxeles dentro de sus argumentos. */
const INLINE_IMAGE_OPS: ReadonlySet<number> = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup])

/** Serializa argumentos de operadores de forma estable: objetos con llaves ordenadas, bytes por su contenido. */
function feed(hash: Hash, value: unknown, depth = 0): void {
  if (value === null || value === undefined) {
    hash.update('n;')
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    hash.update(`${String(value)};`)
  } else if (typeof value === 'string') {
    hash.update(`s${String(value.length)}:${value};`)
  } else if (typeof value !== 'object') {
    hash.update(`${typeof value};`)
  } else if (ArrayBuffer.isView(value)) {
    hash.update(`b${String(value.byteLength)}:`)
    hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  } else if (depth > 8) {
    hash.update('~;')
  } else if (Array.isArray(value)) {
    hash.update(`[${String(value.length)}:`)
    for (const v of value) feed(hash, v, depth + 1)
    hash.update(']')
  } else {
    hash.update('{')
    for (const key of Object.keys(value).sort()) {
      hash.update(`${key}=`)
      feed(hash, (value as Record<string, unknown>)[key], depth + 1)
    }
    hash.update('}')
  }
}

/** Cuánto se espera a que pdfjs entregue una imagen decodificada (llega en un mensaje aparte, unos milisegundos después de la lista). */
const IMAGE_WAIT_MS = 5000

/** La imagen decodificada que pdfjs guarda con ese nombre; las compartidas entre páginas (`g_…`) viven en `commonObjs`. */
function decodedImage(page: PdfPage, name: string): Promise<unknown> {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null)
    }, IMAGE_WAIT_MS)
    store.get(name, (image: unknown) => {
      clearTimeout(timer)
      resolve(image)
    })
  })
}

/** Huella del contenido de una imagen ya decodificada por pdfjs, o null si no se pudo leer. */
async function imageDigest(page: PdfPage, name: unknown): Promise<string | null> {
  if (typeof name !== 'string') return null
  const image = await decodedImage(page, name)
  if (typeof image !== 'object' || image === null) return null
  const { data, width, height, kind } = image as { data?: unknown; width?: unknown; height?: unknown; kind?: unknown }
  if (!ArrayBuffer.isView(data)) return null
  const hash = createHash('sha256')
  feed(hash, [width, height, kind, data])
  return hash.digest('hex')
}

/**
 * Huella de una página: SHA-256 de su lista de operadores (qué se dibuja y con qué argumentos). Los
 * nombres de las imágenes dependen de la página (`img_p0_1`, `g_d0_img_p1_1`), así que se sustituyen
 * por la huella de sus píxeles; los `dependency` solo repiten esos nombres y se omiten. Null si la
 * página no dibuja texto ni imágenes, o si no se pudo leer una imagen: sin huella no se compara.
 */
async function fingerprintPage(page: PdfPage): Promise<string | null> {
  const list = await page.getOperatorList()
  const hash = createHash('sha256')
  let drawsContent = false
  for (const [i, fn] of list.fnArray.entries()) {
    if (fn === OPS.dependency) continue
    const args: unknown = list.argsArray[i]
    hash.update(`#${String(fn)}|`)
    if (NAMED_IMAGE_OPS.has(fn)) {
      const argList = Array.isArray(args) ? (args as unknown[]) : []
      const digest = await imageDigest(page, argList[0])
      if (digest === null) return null
      hash.update(digest)
      feed(hash, argList.slice(1))
      drawsContent = true
      continue
    }
    feed(hash, args)
    if (TEXT_OPS.has(fn) || INLINE_IMAGE_OPS.has(fn)) drawsContent = true
  }
  return drawsContent ? hash.digest('hex') : null
}

/** Huella de cada página (índice 0 = página 1); sirve en las dos rutas, con y sin capa de texto. */
export async function pageFingerprints(doc: PdfDocument, maxPages = MAX_FINGERPRINT_PAGES): Promise<(string | null)[]> {
  const out: (string | null)[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    if (p > maxPages) {
      out.push(null)
      continue
    }
    try {
      const page = await doc.getPage(p)
      try {
        out.push(await fingerprintPage(page))
      } finally {
        page.cleanup()
      }
    } catch {
      out.push(null)
    }
  }
  return out
}

/** Con menos letras y dígitos que esto, dos páginas de texto igual no prueban nada (una hoja casi en blanco). */
const MIN_DUPLICATE_TEXT_CHARS = 100
/** Montos impresos que debe tener una página para que repetirla pueda duplicar movimientos. */
const MIN_DUPLICATE_AMOUNTS = 3
const PRINTED_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b/g

/**
 * ¿La página tiene con qué duplicar movimientos? Con texto, hacen falta letras y montos: las hojas finales
 * de publicidad o avisos legales se repiten en los PDFs reales (Banamex trae cinco iguales) y no alteran
 * nada. Sin texto (escaneado) no se puede saber y la huella decide sola.
 */
function duplicateMatters(text: string): boolean {
  const compact = text.replace(/[^a-z0-9]/g, '')
  if (compact.length === 0) return true
  return compact.length >= MIN_DUPLICATE_TEXT_CHARS && (text.match(PRINTED_AMOUNT)?.length ?? 0) >= MIN_DUPLICATE_AMOUNTS
}

/**
 * Páginas que repiten una anterior: la misma huella de operadores o, con capa de texto, el mismo texto
 * normalizado (no vacío) y el mismo número de página impreso. La original es la primera.
 */
export function findDuplicatePages(fingerprints: readonly (string | null)[], pageTexts: readonly string[], pagination: readonly PageNumbering[]): PageDuplicate[] {
  const byPrint = new Map<string, number>()
  const byText = new Map<string, number>()
  const out: PageDuplicate[] = []
  const pages = Math.max(fingerprints.length, pageTexts.length)
  for (let i = 0; i < pages; i++) {
    const page = i + 1
    const text = normalizeText(pageTexts[i] ?? '')
    if (!duplicateMatters(text)) continue
    const print = fingerprints[i] ?? null
    const textKey = text.replace(/[^a-z0-9]/g, '').length >= MIN_DUPLICATE_TEXT_CHARS ? `${String(pagination[i]?.printed ?? null)}|${text}` : null
    const original = (print === null ? undefined : byPrint.get(print)) ?? (textKey === null ? undefined : byText.get(textKey))
    if (original !== undefined) {
      out.push({ page, sameAs: original })
      continue
    }
    if (print !== null) byPrint.set(print, page)
    if (textKey !== null) byText.set(textKey, page)
  }
  return out
}

// ---------------------------------------------------------------- páginas giradas (ADR 0057)

export interface PageRotation {
  /** Página del PDF (1 = primera). */
  page: number
  /** Cuánto se ve girada la página, en grados en el sentido de las manecillas del reloj. */
  degrees: 90 | 180 | 270
  /** El `/Rotate` que la deja derecha. */
  target: TextAngle
}

/**
 * ¿Se ve girada esta página? El texto corre en la dirección `angle` del espacio del PDF; la página se
 * muestra girada `rotate` grados a la derecha (su `/Rotate`). Queda derecha cuando las dos coinciden:
 * si no, el `/Rotate` que la endereza es el ángulo del texto. Sin texto suficiente (`angle` null) no se dice.
 */
export function pageRotation(page: number, rotate: number, angle: TextAngle | null): PageRotation | null {
  if (angle === null) return null
  const shown = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360
  if (shown === angle) return null
  return { page, degrees: ((shown - angle + 360) % 360) as 90 | 180 | 270, target: angle }
}

/**
 * Copia del PDF con el `/Rotate` de cada página girada corregido. Null si `pdf-lib` no la puede abrir o
 * guardar (por ejemplo, un PDF cifrado con restricciones): se manda el original.
 */
export async function straightenPdf(bytes: Uint8Array, rotations: readonly PageRotation[]): Promise<Uint8Array | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const pages = doc.getPages()
    for (const r of rotations) pages[r.page - 1]?.setRotation(degrees(r.target))
    return await doc.save()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- avisos de la extracción (ADR 0057)

export interface PageChecks {
  statements: MultipleStatements
  /** true si la numeración impresa alcanza para decidir (si no, vale la regla de los CFDI). */
  paginated: boolean
}

type PageCheckInput = Pick<LoadedPdf, 'pagination' | 'pageTexts' | 'duplicates' | 'duplicatePages' | 'rotatedPages' | 'straightened'>

/**
 * Banderas e issues que salen de mirar el PDF por fuera del texto: varios estados de cuenta, páginas
 * que faltan, repetidas y giradas. No llama a ningún modelo.
 */
export function reportPageChecks(pdf: PageCheckInput, issues: IssueSink, flags: Set<DocumentFlag>): PageChecks {
  const scope = { exclude: new Set(pdf.duplicatePages), pageTexts: pdf.pageTexts }
  for (const d of pdf.duplicates) {
    flags.add('pages_duplicated')
    issues.add({ code: 'duplicate_page_removed', severity: 'warning', message: `La página ${String(d.page)} repite la página ${String(d.sameAs)}; se descartaron sus movimientos para no contarlos dos veces.`, page: d.page, details: { same_as: d.sameAs } })
  }
  for (const r of pdf.rotatedPages) {
    flags.add('rotated_pages')
    issues.add({
      code: 'page_rotated',
      severity: 'info',
      message: pdf.straightened ? `La página ${String(r.page)} venía girada ${String(r.degrees)}°; el modelo recibió una copia enderezada.` : `La página ${String(r.page)} viene girada ${String(r.degrees)}° y no se pudo enderezar; el modelo recibió el original.`,
      page: r.page,
      details: { degrees: r.degrees },
    })
  }
  const statements = multipleStatements(pdf.pagination, scope)
  if (statements.documents > 1) {
    flags.add('multiple_statements')
    issues.add({
      code: 'multiple_statements',
      severity: 'error',
      message: `La numeración de las páginas vuelve a empezar: el PDF trae ${String(statements.documents)} estados de cuenta.`,
      page: statements.restartsAt[0] ?? null,
      details: { documents: statements.documents, restarts_at: statements.restartsAt, basis: 'pagination' },
    })
  }
  const { missing, total } = missingPrintedPages(pdf.pagination, scope)
  if (missing.length > 0) {
    flags.add('pages_missing')
    issues.add({
      code: 'page_missing',
      severity: 'warning',
      message: `A la numeración impresa le faltan páginas (${missing.slice(0, 10).join(', ')}${total === null ? '' : ` de ${String(total)}`}): el documento está incompleto.`,
      details: { missing: missing.slice(0, 100), total },
    })
  }
  return { statements, paginated: paginationReliable(pdf.pagination, scope) }
}

/** Segunda regla de varios estados, para lo que no trae numeración confiable: los CFDI de ingreso (después de la pasada 1). */
export function reportFiscalStatements(fiscal: readonly Pick<FiscalDocument, 'kind' | 'uuid' | 'certified_at'>[], issues: IssueSink, flags: Set<DocumentFlag>): MultipleStatements | null {
  const documents = fiscalStatementCount(fiscal)
  if (documents < 2) return null
  flags.add('multiple_statements')
  issues.add({
    code: 'multiple_statements',
    severity: 'error',
    message: `El PDF trae ${String(documents)} comprobantes fiscales de ingreso timbrados en días distintos: son ${String(documents)} estados de cuenta.`,
    details: { documents, restarts_at: [], basis: 'cfdi' },
  })
  return { documents, restartsAt: [] }
}

// ---------------------------------------------------------------- carga

interface PageGeometry {
  rotate: number
  angle: TextAngle | null
}

export async function loadPdf(path: string): Promise<LoadedPdf> {
  const buf = await readFile(path)
  const bytes = new Uint8Array(buf)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const task = getDocument({ data: bytes.slice(), verbosity: 0, useSystemFonts: false })
  const doc = await task.promise
  const raw: string[] = []
  const geometry: PageGeometry[] = []
  let prints: (string | null)[]
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p)
        const content = await page.getTextContent()
        const items = content.items.flatMap((it) => ('str' in it ? [{ str: it.str, transform: it.transform }] : []))
        const angle = dominantTextAngle(items)
        raw.push(itemsToText(items, angle ?? 0))
        geometry.push({ rotate: page.rotate, angle })
      } catch {
        raw.push('')
        geometry.push({ rotate: 0, angle: null })
      }
    }
    prints = await pageFingerprints(doc)
  } finally {
    await task.destroy()
  }
  const assessed = assessTextLayer(raw)
  const usable = assessed.layer === 'ok' || assessed.layer === 'partial' || assessed.repaired
  const pagination = printedPagination(assessed.texts, assessed.layer)
  const duplicates = findDuplicatePages(prints, usable ? assessed.texts : [], pagination)
  // Solo con una capa de texto utilizable se sabe hacia dónde corre el texto; en visión pura no se detecta.
  const rotatedPages = usable ? geometry.flatMap((g, i) => pageRotation(i + 1, g.rotate, g.angle) ?? []) : []
  const fixed = rotatedPages.length > 0 ? await straightenPdf(bytes, rotatedPages) : null
  return {
    fileName: path.split('/').pop() ?? path,
    bytes,
    base64: fixed ? Buffer.from(fixed).toString('base64') : buf.toString('base64'),
    sha256,
    sizeBytes: buf.byteLength,
    pageCount: raw.length,
    pageTexts: assessed.texts,
    textLayer: assessed.layer,
    textRepaired: assessed.repaired,
    pagination,
    duplicatePages: duplicates.map((d) => d.page),
    duplicates,
    rotatedPages,
    straightened: fixed !== null,
  }
}
