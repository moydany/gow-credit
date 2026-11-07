/**
 * Movement-table parser driven by a per-bank spec. Deterministic and model-free: reads the text
 * layer with coordinates (provenance `text_layer`).
 */
import type { Line } from './layout.ts'
import { columnAmounts, groupRows, round2, textInRange, type RowGroup } from './table.ts'

export interface AnchorInfo {
  date: string
  reference: string | null
  /** Description text glued to the anchor (Santander: date, folio and description in one segment). */
  head: string | null
}

export interface TableSpec {
  /** Which pages have the table (1-based). */
  pages: (page: number) => boolean
  /** Where the table starts on each page; with no match, the page has no table. */
  start: RegExp | null
  /** If true, a page without the start line is read whole (continuation pages with no header). */
  startOptional?: boolean
  /** Where the table ends on a page (footer, notices). */
  stop: RegExp | null
  isAnchor: (line: Line) => boolean
  parseAnchor: (line: Line) => AnchorInfo
  /** Right edges of the amount columns. `amount` = single signed column. */
  columns: Partial<Record<'debit' | 'credit' | 'amount' | 'balance' | 'balance2', number>>
  /**
   * Columns relative to each page's header (Hey moves columns between pages): right edge of the
   * column title + `offset`.
   */
  headerColumns?: { titles: Partial<Record<'debit' | 'credit' | 'amount' | 'balance' | 'balance2', RegExp>>; offset: number }
  columnTolerance?: number
  /** x range of the description (and of the reference if it has its own column). */
  description: [number, number]
  reference?: [number, number]
  attach: 'following' | 'nearest'
  band?: number
  orphan?: 'previous' | 'next'
  /** Rows that aren't movements (opening balance printed as a row). */
  skip?: (row: ParsedRow) => boolean
  isNoise?: (line: Line) => boolean
  /** Account or period change within the document (Santander: checking and investment). */
  section?: (line: Line) => string | null
  internalTransfer?: (row: ParsedRow) => boolean
}

export interface ParsedRow {
  section: string
  page: number
  date: string
  description: string
  description_head: string
  reference: string | null
  amount: number
  type: 'credit' | 'debit'
  balance: number | null
  balance2: number | null
  internal_transfer: boolean
  /** Parser problems with this row (extra or missing amounts); empty if clean. */
  problems: string[]
}

type Columns = Record<string, number>

function tableLines(pages: Line[][], spec: TableSpec, columnsByPage: Map<number, Columns>): Line[] {
  const out: Line[] = []
  pages.forEach((lines, i) => {
    const page = i + 1
    if (!spec.pages(page)) return
    const hasStart = spec.start !== null && lines.some((l) => spec.start?.test(l.segments.map((s) => s.str).join(' ')))
    let inside = spec.start === null || (spec.startOptional === true && !hasStart)
    for (const l of lines) {
      const text = l.segments.map((s) => s.str).join(' ')
      if (!inside) {
        if (spec.start?.test(text)) {
          inside = true
          if (spec.headerColumns) {
            const cols: Columns = {}
            for (const [name, re] of Object.entries(spec.headerColumns.titles)) {
              const seg = l.segments.find((s) => re.test(s.str))
              if (seg) cols[name] = seg.x2 + spec.headerColumns.offset
            }
            columnsByPage.set(page, cols)
          }
        }
        continue
      }
      if (spec.stop?.test(text)) break
      out.push(l)
    }
  })
  return out
}

export function parseTable(pages: Line[][], spec: TableSpec): ParsedRow[] {
  const columnsByPage = new Map<number, Columns>()
  const lines = tableLines(pages, spec, columnsByPage)
  // Sections are marked before grouping: a section line closes the previous row.
  const sectionOf = new Map<Line, string>()
  let section = 'main'
  const content: Line[] = []
  for (const l of lines) {
    const s = spec.section?.(l) ?? null
    if (s !== null) {
      section = s
      continue
    }
    sectionOf.set(l, section)
    content.push(l)
  }
  const bySection = new Map<string, Line[]>()
  for (const l of content) {
    const s = sectionOf.get(l) ?? 'main'
    bySection.set(s, [...(bySection.get(s) ?? []), l])
  }
  const rows: ParsedRow[] = []
  for (const [sec, secLines] of bySection) {
    const groups = groupRows(secLines, { isAnchor: spec.isAnchor, attach: spec.attach, ...(spec.isNoise ? { isNoise: spec.isNoise } : {}), ...(spec.band !== undefined ? { band: spec.band } : {}), ...(spec.orphan ? { orphan: spec.orphan } : {}) })
    for (const g of groups) {
      const row = toRow(g, spec, sec, columnsByPage)
      if (spec.skip?.(row)) continue
      row.internal_transfer = spec.internalTransfer?.(row) ?? false
      rows.push(row)
    }
  }
  return rows
}

function toRow(g: RowGroup, spec: TableSpec, section: string, columnsByPage: Map<number, Columns>): ParsedRow {
  const a = spec.parseAnchor(g.anchor)
  const problems: string[] = []
  const amounts = g.lines.flatMap((l) => columnAmounts(l, columnsByPage.get(l.page) ?? (spec.columns as Columns), spec.columnTolerance ?? 30))
  const of = (c: string) => amounts.filter((x) => x.column === c)
  const debit = of('debit')
  const credit = of('credit')
  const signed = of('amount')
  let amount = 0
  let type: 'credit' | 'debit' = 'debit'
  const moving = [...debit, ...credit, ...signed].filter((x) => x.value !== 0)
  if (moving.length !== 1) problems.push(`montos de movimiento: ${String(moving.length)}`)
  const m = moving[0]
  if (m) {
    amount = Math.abs(m.value)
    type = m.column === 'credit' ? 'credit' : m.column === 'debit' ? 'debit' : m.value < 0 ? 'debit' : 'credit'
  }
  const bal = of('balance')
  const bal2 = of('balance2')
  if (bal.length > 1) problems.push('más de un saldo')
  const [from, to] = spec.description
  const descLines = g.lines
  let description = textInRange(descLines, from, to)
  let head = textInRange([g.anchor], from, to)
  if (a.head) {
    description = `${a.head} ${description}`.trim()
    head = `${a.head} ${head}`.trim()
  }
  if (!head) head = textInRange(g.lines.slice(0, 1), from, to) || description.split(' ').slice(0, 6).join(' ')
  let reference = a.reference
  if (spec.reference) {
    const r = textInRange(g.lines, spec.reference[0], spec.reference[1])
    reference = r || reference
  }
  if (!description) problems.push('sin concepto')
  return {
    section,
    page: g.anchor.page,
    date: a.date,
    description: description || '(sin concepto)',
    description_head: head || '(sin concepto)',
    reference: reference && reference.length > 0 ? reference : null,
    amount: round2(amount),
    type,
    balance: bal[0]?.value ?? null,
    balance2: bal2[0]?.value ?? null,
    internal_transfer: false,
    problems,
  }
}

export interface ChainCheck {
  rows: number
  withBalance: number
  breaks: { index: number; page: number; expected: number; printed: number }[]
  credits: number
  debits: number
  creditsCount: number
  debitsCount: number
  closingFromChain: number | null
}

/** Running balance: balance(n) = balance(n-1) +/- amount(n), carrying the expected one over rows with no balance. */
export function checkChain(rows: ParsedRow[], opening: number | null, opts: { reverse?: boolean; excludeInternal?: boolean } = {}): ChainCheck {
  const ordered = opts.reverse ? [...rows].reverse() : rows
  let expected = opening
  const breaks: ChainCheck['breaks'] = []
  let credits = 0
  let debits = 0
  let cc = 0
  let dc = 0
  let withBalance = 0
  ordered.forEach((r, i) => {
    const signedAmount = r.type === 'credit' ? r.amount : -r.amount
    if (!(opts.excludeInternal && r.internal_transfer)) {
      if (r.type === 'credit') {
        credits += r.amount
        cc++
      } else {
        debits += r.amount
        dc++
      }
    }
    if (expected !== null) expected = round2(expected + signedAmount)
    if (r.balance !== null) {
      withBalance++
      if (expected !== null && Math.abs(expected - r.balance) > 0.005) breaks.push({ index: i, page: r.page, expected, printed: r.balance })
      expected = r.balance
    }
  })
  return { rows: rows.length, withBalance, breaks, credits: round2(credits), debits: round2(debits), creditsCount: cc, debitsCount: dc, closingFromChain: expected }
}
