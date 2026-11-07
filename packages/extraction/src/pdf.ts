/**
 * Local PDF read: hash, page count and per-page text via pdfjs (pure JS, no system binaries).
 * The local text serves two purposes: choosing the route (text and vision, or vision only) and
 * verifying that what the model extracted is on the cited page.
 *
 * It also looks at the document as an object: the pagination the bank prints (missing pages,
 * several statements glued together), repeated pages (by each page's operator list) and rotated
 * pages. The model gets the original PDF, unless there are rotated pages: then it gets a copy
 * straightened with `pdf-lib`. Hash and size stay those of the original file.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DocumentFlag, FiscalDocument, TextLayer } from '@gow/contracts'
import { degrees, PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { IssueSink } from './issues.ts'
import { findDuplicatePages, pageFingerprints, type PageDuplicate } from './pdf-duplicates.ts'
import { fiscalStatementCount, missingPrintedPages, multipleStatements, paginationReliable, printedPagination, type MultipleStatements, type PageNumbering } from './pdf-pagination.ts'

export * from './pdf-duplicates.ts'
export * from './pdf-pagination.ts'

export interface LoadedPdf {
  fileName: string
  /** The original file bytes. */
  bytes: Uint8Array
  /**
   * What is sent to the model: the original, or a copy with rotated pages straightened
   * (`straightened`). `sha256` and `sizeBytes` are always the original's.
   */
  base64: string
  sha256: string
  sizeBytes: number
  pageCount: number
  /** Text per page (index 0 = page 1), repaired if possible. */
  pageTexts: string[]
  textLayer: TextLayer
  /** true if the layer was EBCDIC and got decoded (the HSBC case). */
  textRepaired: boolean
  /** Printed numbering per page (`printed` and `total` null without a usable text layer). */
  pagination: PageNumbering[]
  /** PDF pages (1 = first) that repeat an earlier page; their rows do not count. */
  duplicatePages: number[]
  /** Each repeated page with the page it repeats. */
  duplicates: PageDuplicate[]
  /** Pages whose text is rotated relative to how they are displayed. */
  rotatedPages: PageRotation[]
  /** true if `base64` is the straightened copy and not the original. */
  straightened: boolean
}

interface TextItem {
  str: string
  transform: number[]
}

/** Text direction in PDF space, in degrees counterclockwise. */
export type TextAngle = 0 | 90 | 180 | 270

const ANGLES = [0, 90, 180, 270] as const
const ANGLE_TOLERANCE_DEG = 10

/** Where a text item's line runs (`|a| < 0.1 && |b| > 0.9` is 90 or 270), or null if diagonal. */
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

/** Below this much text a page has no reliable orientation (a vertical margin note proves nothing). */
const MIN_ORIENTATION_CHARS = 20

/**
 * Majority text orientation of a page (weighted by characters), or null if there is not enough
 * text or no clear orientation. 0 is normal text, left to right.
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
 * Rebuilds lines by grouping on the coordinate that stays constant along the line and sorting in
 * reading direction. Normal text (0) gives rows top to bottom, left to right; rotated text gives
 * lines that are columns in PDF space (grouped by `x`, sorted by `y`), in the order the page
 * would be read held upright.
 */
function itemsToText(items: TextItem[], angle: TextAngle = 0): string {
  const vertical = angle === 90 || angle === 270
  // Direction in which the line coordinate (y, or x if vertical) grows from first line to last,
  // and the direction in which the coordinate along the line grows.
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

/** Legibility score: Spanish markers and amounts in Mexican format. */
function readability(text: string): { markers: number; amounts: number; letters: number; weird: number } {
  const markers = text.match(SPANISH_MARKERS)?.length ?? 0
  const amounts = text.match(AMOUNT)?.length ?? 0
  const letters = text.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/g)?.length ?? 0
  const weird = text.match(/[^\s\x20-\x7EÁÉÍÓÚÑÜáéíóúñü¿¡°ºª$€]/g)?.length ?? 0
  return { markers, amounts, letters, weird }
}

/**
 * Some PDFs (HSBC in dev) carry Type 3 fonts whose text is EBCDIC read as Latin-1:
 * "ÃäÅÕãÁ@ÔÁÅâãÙÁ" is "CUENTA MAESTRA". Decoded with cp037.
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
  // Common Spanish accents in cp037.
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

/** pdfjs rejects a PDF that asks for an open password with `PasswordException`. */
export function isPdfPasswordError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'PasswordException'
}

const ENCRYPT_KEY = Buffer.from('/Encrypt', 'latin1')
/** PDF delimiters and whitespace: `/Encrypt` is followed by one of these, not a letter (`/EncryptMetadata`). */
const NAME_END = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x25])

/**
 * Does the PDF carry an encryption dictionary? The `/Encrypt` key lives in the trailer or the xref
 * stream dictionary, which are never compressed: searching the bytes is enough. Cheap and does
 * not open the document; cannot tell an open password from mere permission restrictions.
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
 * - `none`: not encrypted.
 * - `permissions_only`: encrypted with no open password (only restricts printing, copying...);
 *   opens and reads normally. Also when pdfjs fails for another reason: let extraction decide.
 * - `password`: needs a password to open; cannot be read.
 *
 * pdfjs only runs if the bytes carry `/Encrypt`: most PDFs are settled by the search.
 */
export type PdfProtection = 'none' | 'permissions_only' | 'password'

export async function pdfProtection(bytes: Uint8Array): Promise<PdfProtection> {
  if (!hasEncryptDictionary(bytes)) return 'none'
  let task: ReturnType<typeof getDocument> | null = null
  try {
    // Copy as Uint8Array: pdfjs does not accept a Buffer and keeps the bytes it receives.
    task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false })
    await task.promise
    return 'permissions_only'
  } catch (err) {
    return isPdfPasswordError(err) ? 'password' : 'permissions_only'
  } finally {
    await task?.destroy()
  }
}

// ---------------------------------------------------------------- rotated pages

export interface PageRotation {
  /** PDF page (1 = first). */
  page: number
  /** How rotated the page looks, in degrees clockwise. */
  degrees: 90 | 180 | 270
  /** The `/Rotate` that leaves it upright. */
  target: TextAngle
}

/**
 * Does this page look rotated? The text runs in direction `angle` of PDF space; the page is
 * shown rotated `rotate` degrees clockwise (its `/Rotate`). It is upright when the two match;
 * otherwise the `/Rotate` that straightens it is the text angle. Without enough text (`angle`
 * null) it says nothing.
 */
export function pageRotation(page: number, rotate: number, angle: TextAngle | null): PageRotation | null {
  if (angle === null) return null
  const shown = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360
  if (shown === angle) return null
  return { page, degrees: ((shown - angle + 360) % 360) as 90 | 180 | 270, target: angle }
}

/**
 * Copy of the PDF with each rotated page's `/Rotate` fixed. Null if `pdf-lib` cannot open or
 * save it (e.g. an encrypted PDF with restrictions): the original is sent.
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

// ---------------------------------------------------------------- extraction notices

export interface PageChecks {
  statements: MultipleStatements
  /** true if the printed numbering is enough to decide (otherwise the CFDI rule applies). */
  paginated: boolean
}

type PageCheckInput = Pick<LoadedPdf, 'pagination' | 'pageTexts' | 'duplicates' | 'duplicatePages' | 'rotatedPages' | 'straightened'>

/**
 * Flags and issues from looking at the PDF outside its text: several statements, missing,
 * repeated and rotated pages. Calls no model.
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

/** Second several-statements rule, for PDFs without reliable numbering: income CFDIs (after pass 1). */
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

// ---------------------------------------------------------------- load

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
  // Text direction is only known with a usable text layer; pure vision does not detect it.
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
