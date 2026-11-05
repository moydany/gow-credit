/** Búsqueda del fragmento citado dentro del texto de una página (pura, para poder probarla). */

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')

/** Busca el fragmento en la página: completo, y si el PDF lo parte distinto, por su inicio, su final o su token más largo. */
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
