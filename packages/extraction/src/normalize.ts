/**
 * Normalization of amounts, dates and text, to compare what the model says against the PDF text
 * layer.
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** "1250.5" → ["1,250.50", "1250.50"]: the forms the amount may be printed in. */
export function amountForms(n: number): string[] {
  const abs = Math.abs(n)
  const fixed = abs.toFixed(2)
  const [int = '0', dec = '00'] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return [...new Set([`${grouped}.${dec}`, `${int}.${dec}`])]
}

/** Comparable text: lowercase, no accents, no punctuation except digits, single spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.,$-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Text without separators, to find amounts and numbers even when the PDF splits columns. */
export function compact(s: string): string {
  return s.replace(/[\s$]/g, '')
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

export function isValidIsoDate(s: string): boolean {
  const m = ISO.exec(s)
  if (!m) return false
  const [, y, mo, d] = m.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, enero: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, apr: 4, abril: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, aug: 8, agosto: 8, august: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, dec: 12, diciembre: 12, december: 12,
}

function iso(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isValidIsoDate(s) ? s : null
}

function parseNumericDate(s: string, resolveYear: (m: number, d: number, y: number | null) => string | null): string | null {
  const m1 = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s)
  if (m1) return resolveYear(Number(m1[2]), Number(m1[1]), Number(m1[3]))
  const m2 = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s)
  if (m2) return resolveYear(Number(m2[2]), Number(m2[1]), null)
  const m3 = /(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m3) return iso(Number(m3[1]), Number(m3[2]), Number(m3[3]))
  const m4 = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(s)
  if (m4) return resolveYear(Number(m4[2]), Number(m4[1]), Number(m4[3]))
  return null
}

function parseNamedMonthDate(s: string, resolveYear: (m: number, d: number, y: number | null) => string | null): string | null {
  const words = normalizeText(s)
    .replace(/[-/.,]/g, ' ')
    .split(' ')
    .filter((w) => w && !['de', 'del', 'al', 'a'].includes(w))
  let day: number | null = null
  let month: number | null = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (/^\d{1,2}$/.test(w) && day === null) day = Number(w)
    else if (MONTHS[w] !== undefined && month === null) month = MONTHS[w] ?? null
    if (day !== null && month !== null) {
      const next = words[i + 1] ?? ''
      const year = /^\d{4}$/.test(next) ? Number(next) : null
      return resolveYear(month, day, year)
    }
  }
  return null
}

/**
 * Tries to convert a Mexican or mixed date to ISO when the model did not return ISO:
 * "16/01/2025", "ENE. 16", "01/SEP", "31 JUL 2025", "13 de June de 2026". With no year, uses the
 * period's year; if the date falls after the period end, uses the previous year.
 */
export function parseLooseDate(raw: string, periodEnd: string | null): string | null {
  const s = raw.trim()
  if (isValidIsoDate(s)) return s
  const endYear = periodEnd && isValidIsoDate(periodEnd) ? Number(periodEnd.slice(0, 4)) : null
  const withYear = (m: number, d: number, y: number | null): string | null => {
    if (y !== null) return iso(y < 100 ? 2000 + y : y, m, d)
    if (endYear === null || periodEnd === null) return null
    const guess = iso(endYear, m, d)
    if (guess && guess > periodEnd) return iso(endYear - 1, m, d)
    return guess
  }
  return parseNumericDate(s, withYear) ?? parseNamedMonthDate(s, withYear)
}

/** Days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * Printed amount → number: "1,250.50", "$ 1,620.67", "-$865.12", "+$100.00", "(1,234.00)",
 * "1,234.00-", "1.250,50" (decimal comma). Empty or unreadable string → null.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim()
  if (s.length === 0) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (/-\s*$/.test(s)) {
    negative = true
    s = s.replace(/-\s*$/, '')
  }
  s = s.replace(/\b(MXN|MN|M\.N\.|USD|CR|DR|CA)\b/gi, '').replace(/[$\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? round2(negative ? -n : n) : null
}

/** Printed count → non-negative integer, or null. */
export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/[,\s]/g, '')
  return /^\d+$/.test(s) ? Number(s) : null
}
