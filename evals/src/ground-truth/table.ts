/**
 * Utilities to read movement tables from the text layer: group lines into rows (a row starts at
 * an "anchor" line with a date) and assign each amount to its column by the position of its right
 * edge (amounts are right-aligned).
 */
import { isAmount, parseAmountText, type Line, type Segment } from './layout.ts'

export interface RowGroup {
  anchor: Line
  /** All the row's lines in reading order, anchor included. */
  lines: Line[]
}

export interface GroupOptions {
  isAnchor: (line: Line) => boolean
  /** Lines that belong to no row (column headers, footers). */
  isNoise?: (line: Line) => boolean
  /**
   * How undated lines are assigned:
   * - following: to the previous row (description below the date).
   * - nearest: to the row with the closest anchor in y if within `band` points (vertically
   *   centered description); otherwise per `orphan`.
   */
  attach: 'following' | 'nearest'
  band?: number
  /** For `nearest`: which row a line far from every anchor goes to. */
  orphan?: 'previous' | 'next'
}

function groupFollowing(useful: Line[], isAnchor: (l: Line) => boolean): RowGroup[] {
  const groups: RowGroup[] = []
  let current: RowGroup | null = null
  for (const l of useful) {
    if (isAnchor(l)) {
      current = { anchor: l, lines: [l] }
      groups.push(current)
    } else if (current) {
      current.lines.push(l)
    }
  }
  return groups
}

function findNearestGroup(samePage: RowGroup[], y: number): { best: RowGroup | null; bestD: number } {
  let best: RowGroup | null = null
  let bestD = Infinity
  for (const g of samePage) {
    const d = Math.abs(g.anchor.y - y)
    if (d < bestD) {
      bestD = d
      best = g
    }
  }
  return { best, bestD }
}

function attachOrphan(l: Line, useful: Line[], groups: RowGroup[], orphanMode: 'previous' | 'next', pending: Line[]) {
  const idx = useful.indexOf(l)
  if (orphanMode === 'next') {
    const next = groups.find((g) => useful.indexOf(g.anchor) > idx)
    if (next) {
      if (next.anchor.page === l.page) next.lines.push(l)
      else pending.push(l)
    }
  } else {
    const prev = [...groups].reverse().find((g) => useful.indexOf(g.anchor) < idx)
    if (prev) prev.lines.push(l)
  }
}

function processNearestLine(l: Line, useful: Line[], groups: RowGroup[], opts: GroupOptions, pending: Line[]) {
  if (opts.isAnchor(l)) {
    const g = groups.find((x) => x.anchor === l)
    if (g && pending.length > 0) g.lines.unshift(...pending.splice(0))
    return
  }
  const samePage = groups.filter((g) => g.anchor.page === l.page)
  const { best, bestD } = findNearestGroup(samePage, l.y)
  const band = opts.band ?? 12
  if (best && bestD <= band) {
    best.lines.push(l)
    return
  }
  attachOrphan(l, useful, groups, opts.orphan ?? 'previous', pending)
}

function groupNearest(useful: Line[], opts: GroupOptions): RowGroup[] {
  const groups: RowGroup[] = useful.filter((l) => opts.isAnchor(l)).map((a) => ({ anchor: a, lines: [a] }))
  const pending: Line[] = []
  for (const l of useful) {
    processNearestLine(l, useful, groups, opts, pending)
  }
  for (const g of groups) g.lines.sort((a, b) => (a.page - b.page) || (a.y - b.y))
  return groups
}

export function groupRows(lines: Line[], opts: GroupOptions): RowGroup[] {
  const useful = lines.filter((l) => !(opts.isNoise?.(l) ?? false))
  if (opts.attach === 'following') {
    return groupFollowing(useful, opts.isAnchor)
  }
  return groupNearest(useful, opts)
}

export interface ColumnAmount {
  column: string
  value: number
  text: string
  segment: Segment
}

/**
 * Amounts of a line assigned to the column whose right edge is closest. `columns` maps name -> x
 * of the right edge; if the amount is more than `maxDistance` away, it isn't assigned.
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

/** Text of the line segments whose starting x falls in [from, to). */
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
