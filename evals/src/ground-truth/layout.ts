/**
 * Reads the text layer with coordinates to build the ground truth without going through the
 * extractor model (provenance `text_layer`). pdfjs returns fragments with positions; here they are
 * grouped into lines (same y) and segments (fragments contiguous in x), which is what a table
 * parser needs: which column each amount falls in.
 */
import { readFile } from 'node:fs/promises'
import { assessTextLayer, decodeEbcdic } from '@gow/extraction'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface Segment {
  x: number
  x2: number
  str: string
}

export interface Line {
  page: number
  /** y from top to bottom (0 at the top), in points. */
  y: number
  segments: Segment[]
  text: string
}

export interface LayoutDoc {
  pages: Line[][]
  repairedEbcdic: boolean
}

interface Item {
  str: string
  x: number
  y: number
  w: number
}

/** Joins fragments close in x (less than `gap` points) into one segment. */
function toSegments(items: Item[], gap: number): Segment[] {
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const out: Segment[] = []
  for (const it of sorted) {
    const prev = out.at(-1)
    if (prev && it.x - prev.x2 < gap) {
      prev.str += (it.x - prev.x2 > 1.2 ? ' ' : '') + it.str
      prev.x2 = Math.max(prev.x2, it.x + it.w)
    } else out.push({ x: it.x, x2: it.x + it.w, str: it.str })
  }
  return out.map((s) => ({ ...s, str: s.str.replace(/\s+/g, ' ').trim() })).filter((s) => s.str.length > 0)
}

export async function readLayout(path: string, opts: { yTolerance?: number; gap?: number } = {}): Promise<LayoutDoc> {
  const yTol = opts.yTolerance ?? 2.5
  const gap = opts.gap ?? 4
  const data = new Uint8Array(await readFile(path))
  const task = getDocument({ data, verbosity: 0, useSystemFonts: false })
  const doc = await task.promise
  const rawPages: Item[][] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const height = page.getViewport({ scale: 1 }).height
      const content = await page.getTextContent()
      const items: Item[] = []
      const seen = new Set<string>()
      for (const it of content.items) {
        if (!('str' in it) || it.str.trim() === '') continue
        const t = it.transform as number[]
        const item = { str: it.str, x: t[4] ?? 0, y: height - (t[5] ?? 0), w: it.width }
        // Some pages print the text twice in the same place (Mercado Pago): the duplicate is dropped.
        const key = `${item.str}@${item.x.toFixed(0)},${item.y.toFixed(0)}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push(item)
      }
      rawPages.push(items)
    }
  } finally {
    await task.destroy()
  }
  // Same decision as the extractor: if the layer is EBCDIC (HSBC), decode it.
  const assessed = assessTextLayer(rawPages.map((items) => items.map((i) => i.str).join('\n')))
  const repaired = assessed.repaired
  const pages = rawPages.map((items, pi) => {
    const decoded = repaired ? items.map((i) => ({ ...i, str: decodeEbcdic(i.str) })) : items
    const sorted = [...decoded].sort((a, b) => a.y - b.y)
    const groups: Item[][] = []
    for (const it of sorted) {
      const g = groups.at(-1)
      const gy = g ? g.reduce((s, x) => s + x.y, 0) / g.length : -1e9
      if (g && Math.abs(it.y - gy) <= yTol) g.push(it)
      else groups.push([it])
    }
    return groups
      .map((g) => {
        const segments = toSegments(g, gap)
        return { page: pi + 1, y: g.reduce((s, x) => s + x.y, 0) / g.length, segments, text: segments.map((s) => s.str).join(' | ') }
      })
      .filter((l) => l.segments.length > 0)
  })
  return { pages, repairedEbcdic: repaired }
}

const AMOUNT_RE = /^[-+]?\$?\s?-?\(?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR|-|\+))?$/

export function isAmount(s: string): boolean {
  return AMOUNT_RE.test(s.trim())
}

/** "1,250.50" → 1250.5; "-$865.12" → -865.12; "(1,234.00)" → -1234. */
export function parseAmountText(s: string): number {
  const t = s.trim()
  const neg = /^-|^\$\s?-|^\(|-$/.test(t)
  const digits = t.replace(/[^\d.]/g, '')
  const n = Math.round(Number(digits) * 100) / 100
  return neg ? -n : n
}
