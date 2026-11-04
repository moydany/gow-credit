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

/** Similitud de nombres por palabras: 1 si son el mismo conjunto, 0 si no comparten nada. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a))
  const tb = new Set(nameTokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return common / Math.min(ta.size, tb.size)
}
