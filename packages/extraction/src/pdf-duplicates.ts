/**
 * Repeated pages: a fingerprint per page built from its operator list and the images it paints,
 * and the rule for when a duplicate matters for the analysis.
 */
import { createHash, type Hash } from 'node:crypto'
import type { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { normalizeText } from './normalize.ts'
import type { PageNumbering } from './pdf-pagination.ts'

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

export interface PageDuplicate {
  /** The repeated page. */
  page: number
  /** The first page with the same content. */
  sameAs: number
}

/** Max pages fingerprinted (every image of a big scan must be decoded); the rest are skipped. */
const MAX_FINGERPRINT_PAGES = 150

const TEXT_OPS: ReadonlySet<number> = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText])
/** Images pdfjs refers to by name; their content is requested separately. */
const NAMED_IMAGE_OPS: ReadonlySet<number> = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat])
/** Those that carry their pixels inside the arguments. */
const INLINE_IMAGE_OPS: ReadonlySet<number> = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup])

/** Serializes operator arguments stably: objects with sorted keys, bytes by content. */
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

/** Wait for pdfjs to deliver a decoded image (separate message, a few ms after the list). */
const IMAGE_WAIT_MS = 5000

/** Decoded image pdfjs holds under that name; images shared across pages (`g_…`) are in `commonObjs`. */
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

/** Fingerprint of an image pdfjs already decoded, or null if it could not be read. */
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
 * Page fingerprint: SHA-256 of its operator list (what is drawn and with which arguments). Image
 * names depend on the page (`img_p0_1`, `g_d0_img_p1_1`), so they are replaced by their pixel
 * fingerprint; `dependency` entries just repeat those names and are omitted. Null if the page
 * draws no text or images, or an image could not be read: with no fingerprint it is not compared.
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

/** Fingerprint of each page (index 0 = page 1); used on both routes, with and without text. */
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

/** Below this many letters and digits, equal text proves nothing (a nearly blank sheet). */
const MIN_DUPLICATE_TEXT_CHARS = 100
/** Printed amounts a page needs for repeating it to be able to duplicate transactions. */
const MIN_DUPLICATE_AMOUNTS = 3
const PRINTED_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b/g

/**
 * Can the page duplicate transactions? With text, it needs letters and amounts: trailing ad or
 * legal pages repeat in real PDFs (Banamex has five identical ones) and change nothing. Without
 * text (scanned) there is no way to tell and the fingerprint decides alone.
 */
function duplicateMatters(text: string): boolean {
  const compact = text.replace(/[^a-z0-9]/g, '')
  if (compact.length === 0) return true
  return compact.length >= MIN_DUPLICATE_TEXT_CHARS && (text.match(PRINTED_AMOUNT)?.length ?? 0) >= MIN_DUPLICATE_AMOUNTS
}

/**
 * Pages that repeat an earlier one: same operator fingerprint or, with a text layer, same
 * normalized (non-empty) text and same printed page number. The original is the first.
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
