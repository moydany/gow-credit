/** Finds the cited snippet inside a page's text (pure, so it can be tested). */

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')

/** Finds the snippet in the page: whole, or, if the PDF splits it differently, by its start, end or longest token. */
export function locate(flat: string, snippet: string): { start: number; end: number } | null {
  const target = norm(snippet)
  if (!target) return null
  const tokens = snippet.split(/\s+/).map(norm).filter((t) => t.length >= 5).sort((a, b) => b.length - a.length)
  const candidates = [target, target.slice(0, 40), target.slice(-40), ...tokens.slice(0, 2)]
  for (const c of candidates) {
    if (c.length < 4) continue
    const i = flat.indexOf(c)
    if (i >= 0) return { start: i, end: i + c.length }
  }
  return null
}
