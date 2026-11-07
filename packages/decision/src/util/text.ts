/** Normalizes descriptions and names for comparing without accents, case or punctuation. */

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9&]+/g, ' ')
    .trim()
}

/** Corporate suffixes and stopwords that do not distinguish a company. */
const NAME_NOISE = new Set([
  'SA', 'DE', 'CV', 'S', 'A', 'C', 'V', 'SAB', 'SAPI', 'SC', 'RL', 'SRL', 'SPR', 'SAS', 'SOFOM', 'ENR', 'ER', 'AC', 'IAP',
  'LA', 'EL', 'LOS', 'LAS', 'Y', 'DEL', 'E', 'CIA', 'COMPANIA',
])

/** Significant words of a person or company name. */
export function nameTokens(name: string): string[] {
  return normalizeText(name)
    .split(' ')
    .filter((t) => t.length >= 2 && !NAME_NOISE.has(t))
}

/**
 * Does the description mention this name? All its significant words must appear as whole words.
 * A single short word is not enough (false positives).
 */
export function mentionsName(description: string, name: string): boolean {
  const tokens = nameTokens(name)
  if (tokens.length === 0) return false
  if (tokens.length === 1 && (tokens[0]?.length ?? 0) < 5) return false
  const words = new Set(normalizeText(description).split(' '))
  return tokens.every((t) => words.has(t))
}

/** Edit distance with transposition (restricted Damerau-Levenshtein), cut off at `max + 1`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = rows[i] as number[]
      const prev = rows[i - 1] as number[]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, (rows[i - 2]?.[j - 2] ?? 0) + 1)
      row[j] = d
    }
  }
  return Math.min(rows[a.length]?.[b.length] ?? max + 1, max + 1)
}

/**
 * Are two name words the same, allowing a typo? Exact under 5 letters; one error (changed,
 * extra, missing letter or two swapped) from 5; two from 10. Accents, case and punctuation are
 * already removed in `normalizeText`.
 */
export function sameNameToken(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  const allowed = shorter >= 10 ? 2 : shorter >= 5 ? 1 : 0
  return allowed > 0 && editDistance(a, b, allowed) <= allowed
}

/**
 * Name similarity by words: 1 if the same set, 0 if nothing shared. Each word pairs with at most
 * one word of the other name, tolerating typos (`sameNameToken`).
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = [...new Set(nameTokens(a))]
  const tb = [...new Set(nameTokens(b))]
  if (ta.length === 0 || tb.length === 0) return 0
  const used = new Set<number>()
  let common = 0
  for (const t of ta) {
    // Exact match first, so a typo does not take the pair from the correct word.
    let k = tb.findIndex((u, i) => !used.has(i) && u === t)
    if (k < 0) k = tb.findIndex((u, i) => !used.has(i) && sameNameToken(t, u))
    if (k >= 0) {
      used.add(k)
      common++
    }
  }
  return common / Math.min(ta.length, tb.length)
}
