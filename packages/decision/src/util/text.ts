/** Normalización de descripciones y nombres para comparar sin acentos, mayúsculas ni puntuación. */

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9&]+/g, ' ')
    .trim()
}

/** Sufijos societarios y palabras vacías que no distinguen a una empresa. */
const NAME_NOISE = new Set([
  'SA', 'DE', 'CV', 'S', 'A', 'C', 'V', 'SAB', 'SAPI', 'SC', 'RL', 'SRL', 'SPR', 'SAS', 'SOFOM', 'ENR', 'ER', 'AC', 'IAP',
  'LA', 'EL', 'LOS', 'LAS', 'Y', 'DEL', 'E', 'CIA', 'COMPANIA',
])

/** Palabras significativas de un nombre de persona o empresa. */
export function nameTokens(name: string): string[] {
  return normalizeText(name)
    .split(' ')
    .filter((t) => t.length >= 2 && !NAME_NOISE.has(t))
}

/**
 * ¿La descripción menciona este nombre? Todas sus palabras significativas deben aparecer como
 * palabras completas. Un nombre de una sola palabra corta no basta (falsos positivos).
 */
export function mentionsName(description: string, name: string): boolean {
  const tokens = nameTokens(name)
  if (tokens.length === 0) return false
  if (tokens.length === 1 && (tokens[0]?.length ?? 0) < 5) return false
  const words = new Set(normalizeText(description).split(' '))
  return tokens.every((t) => words.has(t))
}

/** Distancia de edición con transposición (Damerau–Levenshtein restringida), cortada en `max + 1`. */
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
 * ¿Dos palabras de nombre son la misma, con un typo de por medio? (ADR 0040). Exactas si tienen
 * menos de 5 letras; un error (letra cambiada, de más, de menos o dos invertidas) desde 5; dos desde
 * 10. Acentos, mayúsculas y puntuación ya se quitaron en `normalizeText`.
 */
export function sameNameToken(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  const allowed = shorter >= 10 ? 2 : shorter >= 5 ? 1 : 0
  return allowed > 0 && editDistance(a, b, allowed) <= allowed
}

/**
 * Similitud de nombres por palabras: 1 si son el mismo conjunto, 0 si no comparten nada. Cada
 * palabra se empareja a lo más con una del otro nombre, con tolerancia a typos (`sameNameToken`).
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = [...new Set(nameTokens(a))]
  const tb = [...new Set(nameTokens(b))]
  if (ta.length === 0 || tb.length === 0) return 0
  const used = new Set<number>()
  let common = 0
  for (const t of ta) {
    // Primero la exacta, para que un typo no le gane la pareja a la palabra correcta.
    let k = tb.findIndex((u, i) => !used.has(i) && u === t)
    if (k < 0) k = tb.findIndex((u, i) => !used.has(i) && sameNameToken(t, u))
    if (k >= 0) {
      used.add(k)
      common++
    }
  }
  return common / Math.min(ta.length, tb.length)
}
