/** ISO dates (YYYY-MM-DD) as a UTC day number: no time zones or daylight saving. */

const MS_PER_DAY = 86_400_000

export function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / MS_PER_DAY)
}

export function fromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return fromDay(toDay(iso) + days)
}

/** Same day of the month, `months` months later; if it does not exist (February 31), the last day of the month. */
export function addMonths(iso: string, months: number): string {
  const [y = 1970, m = 1, d = 1] = iso.slice(0, 10).split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const ty = Math.floor(total / 12)
  const tm = total - ty * 12
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  return fromDay(Math.round(Date.UTC(ty, tm, Math.min(d, last)) / MS_PER_DAY))
}

/** Average days in a calendar month (365.25 / 12). */
export const AVG_MONTH_DAYS = 30.4375

export interface Interval {
  start: number
  end: number
}

/** Merges day intervals (inclusive) that touch or overlap. */
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.end >= i.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out.at(-1)
    if (last && i.start <= last.end + 1) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

export function intervalDays(intervals: readonly Interval[]): number {
  return intervals.reduce((s, i) => s + (i.end - i.start + 1), 0)
}
