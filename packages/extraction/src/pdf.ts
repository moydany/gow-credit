/**
 * Lectura local del PDF: hash, número de páginas y texto por página con pdfjs (JS puro, sin
 * binarios del sistema). El texto local sirve para dos cosas: decidir la ruta (texto y
 * visión, o solo visión) y verificar que lo extraído por el modelo esté en la página citada.
 * Al modelo siempre se le manda el PDF original.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { TextLayer } from '@gow/contracts'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface LoadedPdf {
  fileName: string
  bytes: Uint8Array
  base64: string
  sha256: string
  sizeBytes: number
  pageCount: number
  /** Texto por página (índice 0 = página 1), ya reparado si se pudo. */
  pageTexts: string[]
  textLayer: TextLayer
  /** true si la capa venía en EBCDIC y se decodificó (caso HSBC). */
  textRepaired: boolean
}

interface TextItem {
  str: string
  transform: number[]
}

/** Reconstruye líneas agrupando por coordenada y, de arriba abajo y de izquierda a derecha. */
function itemsToText(items: TextItem[]): string {
  const rows = new Map<number, { x: number; s: string }[]>()
  for (const it of items) {
    if (!it.str) continue
    const y = Math.round((it.transform[5] ?? 0) / 2) * 2
    const x = it.transform[4] ?? 0
    const row = rows.get(y) ?? []
    row.push({ x, s: it.str })
    rows.set(y, row)
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
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

function decodeEbcdic(text: string): string {
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

export async function loadPdf(path: string): Promise<LoadedPdf> {
  const buf = await readFile(path)
  const bytes = new Uint8Array(buf)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const task = getDocument({ data: bytes.slice(), verbosity: 0, useSystemFonts: false })
  const doc = await task.promise
  const raw: string[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p)
        const content = await page.getTextContent()
        raw.push(itemsToText(content.items.flatMap((it) => ('str' in it ? [{ str: it.str, transform: it.transform }] : []))))
      } catch {
        raw.push('')
      }
    }
  } finally {
    await task.destroy()
  }
  const assessed = assessTextLayer(raw)
  return {
    fileName: path.split('/').pop() ?? path,
    bytes,
    base64: buf.toString('base64'),
    sha256,
    sizeBytes: buf.byteLength,
    pageCount: raw.length,
    pageTexts: assessed.texts,
    textLayer: assessed.layer,
    textRepaired: assessed.repaired,
  }
}
