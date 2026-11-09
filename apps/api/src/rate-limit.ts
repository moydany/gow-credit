export function createWindowLimiter(
  limit: number,
  windowMs: number,
  maxEntries = 10_000,
): (key: string) => boolean {
  const hits = new Map<string, { start: number; count: number }>()
  return (key: string): boolean => {
    const now = Date.now()
    if (hits.size > maxEntries) {
      for (const [k, v] of hits) {
        if (now - v.start > windowMs) hits.delete(k)
      }
    }
    const w = hits.get(key)
    if (!w || now - w.start > windowMs) {
      hits.set(key, { start: now, count: 1 })
      return true
    }
    return ++w.count <= limit
  }
}
