/**
 * Páginas repetidas (ADR 0057): una huella por página a partir de su lista de operadores y de las
 * imágenes que pinta, y la regla que decide cuándo un duplicado importa para el análisis.
 */
import { createHash, type Hash } from 'node:crypto'
import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { normalizeText } from './normalize.ts'
import type { PageNumbering } from './pdf-pagination.ts'

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
