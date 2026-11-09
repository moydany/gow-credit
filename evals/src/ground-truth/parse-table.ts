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

function extractHeaderColumns(l: Line, headerCols: NonNullable<TableSpec['headerColumns']>): Columns {
  const cols: Columns = {}
  for (const [name, re] of Object.entries(headerCols.titles)) {
    const seg = l.segments.find((s) => re.test(s.str))
    if (seg) cols[name] = seg.x2 + headerCols.offset
  }
  return cols
}

function collectPageLines(lines: Line[], page: number, spec: TableSpec, columnsByPage: Map<number, Columns>): Line[] {
  if (!spec.pages(page)) return []
  const hasStart = spec.start !== null && lines.some((l) => spec.start?.test(l.segments.map((s) => s.str).join(' ')))
  let inside = spec.start === null || (spec.startOptional === true && !hasStart)
  const pageOut: Line[] = []
  for (const l of lines) {
    const text = l.segments.map((s) => s.str).join(' ')
    if (!inside) {
      if (spec.start?.test(text)) {
        inside = true
        if (spec.headerColumns) {
          columnsByPage.set(page, extractHeaderColumns(l, spec.headerColumns))
        }
      }
      continue
    }
    if (spec.stop?.test(text)) break
    pageOut.push(l)
  }
  return pageOut
}

function tableLines(pages: Line[][], spec: TableSpec, columnsByPage: Map<number, Columns>): Line[] {
  return pages.flatMap((lines, i) => collectPageLines(lines, i + 1, spec, columnsByPage))
}

function partitionBySection(lines: Line[], spec: TableSpec): Map<string, Line[]> {
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
  return bySection
}

function parseSectionRows(bySection: Map<string, Line[]>, spec: TableSpec, columnsByPage: Map<number, Columns>): ParsedRow[] {
  const rows: ParsedRow[] = []
  for (const [sec, secLines] of bySection) {
    const groups = groupRows(secLines, {
      isAnchor: spec.isAnchor,
      attach: spec.attach,
      ...(spec.isNoise ? { isNoise: spec.isNoise } : {}),
      ...(spec.band !== undefined ? { band: spec.band } : {}),
      ...(spec.orphan ? { orphan: spec.orphan } : {}),
    })
    for (const g of groups) {
      const row = toRow(g, spec, sec, columnsByPage)
      if (spec.skip?.(row)) continue
      row.internal_transfer = spec.internalTransfer?.(row) ?? false
      rows.push(row)
    }
  }
  return rows
}

export function parseTable(pages: Line[][], spec: TableSpec): ParsedRow[] {
  const columnsByPage = new Map<number, Columns>()
  const lines = tableLines(pages, spec, columnsByPage)
  const bySection = partitionBySection(lines, spec)
  return parseSectionRows(bySection, spec, columnsByPage)
}

function resolveRowMovement(moving: { value: number; column: string }[], problems: string[]): { amount: number; type: 'credit' | 'debit' } {
  if (moving.length !== 1) problems.push(`montos de movimiento: ${String(moving.length)}`)
  const m = moving[0]
  if (!m) return { amount: 0, type: 'debit' }
  const type: 'credit' | 'debit' = m.column === 'credit' ? 'credit' : m.column === 'debit' ? 'debit' : m.value < 0 ? 'debit' : 'credit'
  return { amount: Math.abs(m.value), type }
}

function resolveRowText(g: RowGroup, a: AnchorInfo, spec: TableSpec, problems: string[]) {
  const [from, to] = spec.description
  let description = textInRange(g.lines, from, to)
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
    description: description || '(sin concepto)',
    head: head || '(sin concepto)',
    reference: reference && reference.length > 0 ? reference : null,
  }
}

function toRow(g: RowGroup, spec: TableSpec, section: string, columnsByPage: Map<number, Columns>): ParsedRow {
  const a = spec.parseAnchor(g.anchor)
  const problems: string[] = []
  const amounts = g.lines.flatMap((l) => columnAmounts(l, columnsByPage.get(l.page) ?? (spec.columns as Columns), spec.columnTolerance ?? 30))
  const of = (c: string) => amounts.filter((x) => x.column === c)
  const bal = of('balance')
  const bal2 = of('balance2')
  if (bal.length > 1) problems.push('más de un saldo')
  const moving = amounts.filter((x) => (x.column === 'debit' || x.column === 'credit' || x.column === 'amount') && x.value !== 0)
  const { amount, type } = resolveRowMovement(moving, problems)
  const { description, head, reference } = resolveRowText(g, a, spec, problems)
  return {
    section,
    page: g.anchor.page,
    date: a.date,
    description,
    description_head: head,
    reference,
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
export function checkChain(rows: readonly ParsedRow[], opening: number | null, opts: { reverse?: boolean; excludeInternal?: boolean } = {}): ChainCheck {
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
