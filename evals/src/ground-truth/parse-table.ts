/**
 * Parser de tablas de movimientos guiado por una especificación por banco. Determinístico y
 * sin modelo: lee la capa de texto con coordenadas (ADR 0001, procedencia `text_layer`).
 */
import type { Line } from './layout.ts'
import { columnAmounts, groupRows, round2, textInRange, type RowGroup } from './table.ts'

export interface AnchorInfo {
  date: string
  reference: string | null
  /** Texto de concepto que viene pegado al ancla (Santander: fecha, folio y concepto en un segmento). */
  head: string | null
}

export interface TableSpec {
  /** Qué páginas tienen la tabla (1-based). */
  pages: (page: number) => boolean
  /** Dónde empieza la tabla en cada página; sin coincidencia, la página no tiene tabla. */
  start: RegExp | null
  /** Si true, una página sin la línea de inicio se lee completa (páginas de continuación sin encabezado). */
  startOptional?: boolean
  /** Dónde termina la tabla en una página (pie, avisos). */
  stop: RegExp | null
  isAnchor: (line: Line) => boolean
  parseAnchor: (line: Line) => AnchorInfo
  /** Bordes derechos de las columnas de monto. `amount` = columna única con signo. */
  columns: Partial<Record<'debit' | 'credit' | 'amount' | 'balance' | 'balance2', number>>
  /**
   * Columnas relativas al encabezado de cada página (Hey mueve las columnas entre páginas):
   * borde derecho del título de la columna + `offset`.
   */
  headerColumns?: { titles: Partial<Record<'debit' | 'credit' | 'amount' | 'balance' | 'balance2', RegExp>>; offset: number }
  columnTolerance?: number
  /** Rango x del concepto (y de la referencia si va en columna propia). */
  description: [number, number]
  reference?: [number, number]
  attach: 'following' | 'nearest'
  band?: number
  orphan?: 'previous' | 'next'
  /** Filas que no son movimientos (saldo inicial impreso como fila). */
  skip?: (row: ParsedRow) => boolean
  isNoise?: (line: Line) => boolean
  /** Cambio de cuenta o periodo dentro del documento (Santander: cheques e inversión). */
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
  /** Problemas del parser con esta fila (montos de más o de menos); vacío si limpia. */
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
  // Las secciones se marcan antes de agrupar: una línea de sección cierra la fila anterior.
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

/** Saldo corrido: saldo(n) = saldo(n−1) ± monto(n), arrastrando el esperado por filas sin saldo. */
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
