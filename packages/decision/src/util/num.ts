/** Arithmetic on amounts in integer cents: summing hundreds of movements in floats leaves residue. */

export const toCents = (n: number): number => Math.round(n * 100)
export const fromCents = (c: number): number => c / 100

export function sumMoney(values: Iterable<number>): number {
  let cents = 0
  for (const v of values) cents += toCents(v)
  return fromCents(cents)
}

export function round2(n: number): number {
  return fromCents(Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7)))
}

export function floor2(n: number): number {
  return Math.floor(n * 100 + 1e-7) / 100
}

export function ceil2(n: number): number {
  return Math.ceil(n * 100 - 1e-7) / 100
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Weighted mean; `fallback` if there is no weight. */
export function weightedMean(pairs: Iterable<{ value: number; weight: number }>, fallback: number): number {
  let num = 0
  let den = 0
  for (const { value, weight } of pairs) {
    num += value * weight
    den += weight
  }
  return den > 0 ? num / den : fallback
}
