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
