/**
 * Utilidades para leer tablas de movimientos de la capa de texto: agrupar líneas en filas
 * (una fila empieza en una línea "ancla" con fecha) y asignar cada monto a su columna por la
 * posición de su borde derecho (los montos van alineados a la derecha).
 */
import { isAmount, parseAmountText, type Line, type Segment } from './layout.ts'

export interface RowGroup {
  anchor: Line
  /** Todas las líneas de la fila en orden de lectura, incluida el ancla. */
  lines: Line[]
}

export interface GroupOptions {
  isAnchor: (line: Line) => boolean
  /** Líneas que no son parte de ninguna fila (encabezados de columna, pies de página). */
  isNoise?: (line: Line) => boolean
  /**
   * Cómo se asignan las líneas sin fecha:
   * - following: a la fila anterior (descripción debajo de la fecha).
   * - nearest: a la fila con el ancla más cercana en y si está a menos de `band` puntos
   *   (descripción centrada verticalmente); si no, según `orphan`.
   */
  attach: 'following' | 'nearest'
  band?: number
  /** Para `nearest`: a qué fila va una línea lejos de todo ancla. */
  orphan?: 'previous' | 'next'
}

export function groupRows(lines: Line[], opts: GroupOptions): RowGroup[] {
  const useful = lines.filter((l) => !(opts.isNoise?.(l) ?? false))
  const groups: RowGroup[] = []
  if (opts.attach === 'following') {
    let current: RowGroup | null = null
    for (const l of useful) {
      if (opts.isAnchor(l)) {
        current = { anchor: l, lines: [l] }
        groups.push(current)
      } else if (current) current.lines.push(l)
    }
    return groups
  }
  const band = opts.band ?? 12
  const anchors = useful.filter((l) => opts.isAnchor(l))
  for (const a of anchors) groups.push({ anchor: a, lines: [a] })
  const pending: Line[] = []
  const indexOf = (g: RowGroup) => useful.indexOf(g.anchor)
  for (const l of useful) {
    if (opts.isAnchor(l)) {
      // Las huérfanas que esperaban la siguiente fila (cruce de página) entran aquí.
      const g = groups.find((x) => x.anchor === l)
      if (g && pending.length > 0) g.lines.unshift(...pending.splice(0))
      continue
    }
    const samePage = groups.filter((g) => g.anchor.page === l.page)
    let best: RowGroup | null = null
    let bestD = Infinity
    for (const g of samePage) {
      const d = Math.abs(g.anchor.y - l.y)
      if (d < bestD) {
        bestD = d
        best = g
      }
    }
    if (best && bestD <= band) {
      best.lines.push(l)
      continue
    }
    const idx = useful.indexOf(l)
    if ((opts.orphan ?? 'previous') === 'next') {
      const next = groups.find((g) => indexOf(g) > idx)
      if (next) {
        if (next.anchor.page === l.page) next.lines.push(l)
        else pending.push(l)
      }
    } else {
      const prev = [...groups].reverse().find((g) => indexOf(g) < idx)
      if (prev) prev.lines.push(l)
    }
  }
  for (const g of groups) g.lines.sort((a, b) => (a.page - b.page) || (a.y - b.y))
  return groups
}

export interface ColumnAmount {
  column: string
  value: number
  text: string
  segment: Segment
}

/**
 * Montos de una línea asignados a la columna cuyo borde derecho está más cerca. `columns`
 * mapea nombre → x del borde derecho; si el monto queda a más de `maxDistance`, no se asigna.
 */
export function columnAmounts(line: Line, columns: Record<string, number>, maxDistance = 30): ColumnAmount[] {
  const out: ColumnAmount[] = []
  for (const s of line.segments) {
    if (!isAmount(s.str)) continue
    let best: string | null = null
    let bestD = Infinity
    for (const [name, x2] of Object.entries(columns)) {
      const d = Math.abs(s.x2 - x2)
      if (d < bestD) {
        bestD = d
        best = name
      }
    }
    if (best !== null && bestD <= maxDistance) out.push({ column: best, value: parseAmountText(s.str), text: s.str, segment: s })
  }
  return out
}

/** Texto de los segmentos de las líneas cuyo x inicial cae en [from, to). */
export function textInRange(lines: Line[], from: number, to: number): string {
  return lines
    .flatMap((l) => l.segments.filter((s) => s.x >= from && s.x < to && !isAmount(s.str)).map((s) => s.str))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const MONTHS: Record<string, number> = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SEPT: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
  JAN: 1, APR: 4, AUG: 8, DEC: 12,
}

export function monthNumber(abbr: string): number {
  const m = MONTHS[abbr.toUpperCase().replace(/\.$/, '').slice(0, 4)] ?? MONTHS[abbr.toUpperCase().slice(0, 3)]
  if (!m) throw new Error(`mes desconocido: ${abbr}`)
  return m
}

export function iso(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
