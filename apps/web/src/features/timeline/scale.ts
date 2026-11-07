/**
 * Escalas del recorrido (sin React ni three). Una escala es una función por tramos entre el tiempo real
 * (ms desde epoch) y un eje "comprimido": los `gaps` (esperas de un día) ocupan un ancho fijo pequeño y
 * el resto del tiempo se reparte lineal. Es estrictamente creciente, así que se puede invertir.
 *
 * Hay dos usos con la misma pieza: el eje horizontal de la línea de tiempo 2D (píxeles) y el eje de
 * reproducción (segundos): ahí cada tramo dura algo legible, no su tiempo real.
 */
import type { ApplicationTimeline } from '@gow/contracts'

export interface AxisSegment {
  t0: number
  t1: number
  v0: number
  v1: number
  gap: boolean
}

export interface Axis {
  segments: AxisSegment[]
  /** Valor del eje al final del recorrido. */
  size: number
  tStart: number
  tEnd: number
  toV: (t: number) => number
  toT: (v: number) => number
  /** Milisegundos reales por unidad del eje en el tramo de `t` (cuánto "pesa" cada unidad ahí). */
  msPerUnit: (t: number) => number
}

export const ms = (iso: string): number => Date.parse(iso)

/** Los tramos de espera, recortados al recorrido, ordenados y sin traslapes. */
export function gapRanges(timeline: ApplicationTimeline): { t0: number; t1: number }[] {
  const lo = ms(timeline.start)
  const hi = ms(timeline.end)
  const raw = timeline.gaps
    .map((g) => ({ t0: Math.max(lo, ms(g.start)), t1: Math.min(hi, ms(g.end)) }))
    .filter((g) => g.t1 > g.t0)
    .sort((a, b) => a.t0 - b.t0)
  const out: { t0: number; t1: number }[] = []
  for (const g of raw) {
    const last = out[out.length - 1]
    if (last && g.t0 <= last.t1) last.t1 = Math.max(last.t1, g.t1)
    else out.push({ ...g })
  }
  return out
}

/**
 * Construye la escala. `weight(ms, isGap)` da el ancho de cada pieza en unidades del eje; `breaks`
 * parte los tramos activos (por ejemplo, en los límites de los capítulos).
 */
export function buildAxis(timeline: ApplicationTimeline, weight: (ms: number, gap: boolean) => number, breaks: number[] = []): Axis {
  const lo = ms(timeline.start)
  const hi = Math.max(ms(timeline.end), lo + 1)
  const gaps = gapRanges(timeline)
  const pieces: { t0: number; t1: number; gap: boolean }[] = []
  let cursor = lo
  const pushActive = (a: number, b: number) => {
    const cuts = breaks.filter((x) => x > a && x < b).sort((p, q) => p - q)
    let from = a
    for (const c of [...cuts, b]) {
      if (c > from) pieces.push({ t0: from, t1: c, gap: false })
      from = c
    }
  }
  for (const g of gaps) {
    if (g.t0 > cursor) pushActive(cursor, g.t0)
    pieces.push({ t0: g.t0, t1: g.t1, gap: true })
    cursor = g.t1
  }
  if (hi > cursor) pushActive(cursor, hi)
  if (pieces.length === 0) pieces.push({ t0: lo, t1: hi, gap: false })

  const segments: AxisSegment[] = []
  let v = 0
  for (const p of pieces) {
    const w = Math.max(weight(p.t1 - p.t0, p.gap), 1e-6)
    segments.push({ ...p, v0: v, v1: v + w })
    v += w
  }
  const first = segments[0] as AxisSegment
  const last = segments[segments.length - 1] as AxisSegment

  const search = (x: number, lowOf: (s: AxisSegment) => number): AxisSegment => {
    let loI = 0
    let hiI = segments.length - 1
    while (loI < hiI) {
      const mid = (loI + hiI + 1) >> 1
      if (lowOf(segments[mid] as AxisSegment) <= x) loI = mid
      else hiI = mid - 1
    }
    return segments[loI] as AxisSegment
  }
  const findT = (t: number): AxisSegment => search(t, (s) => s.t0)
  const findV = (v: number): AxisSegment => search(v, (s) => s.v0)

  return {
    segments,
    size: last.v1,
    tStart: first.t0,
    tEnd: last.t1,
    toV(t) {
      if (t <= first.t0) return 0
      if (t >= last.t1) return last.v1
      const s = findT(t)
      return s.v0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.v1 - s.v0)
    },
    toT(x) {
      if (x <= 0) return first.t0
      if (x >= last.v1) return last.t1
      const s = findV(x)
      return s.t0 + ((x - s.v0) / (s.v1 - s.v0)) * (s.t1 - s.t0)
    },
    msPerUnit(t) {
      const s = findT(Math.min(Math.max(t, first.t0), last.t1))
      return (s.t1 - s.t0) / (s.v1 - s.v0)
    },
  }
}

export const GAP_PX = 64

/** Eje horizontal (px) de la línea de tiempo 2D para un ancho visible y un zoom (1 = todo cabe). */
export function buildTrackAxis(timeline: ApplicationTimeline, viewportPx: number, zoom: number): Axis {
  const gaps = gapRanges(timeline)
  const activeMs = Math.max(ms(timeline.end) - ms(timeline.start) - gaps.reduce((a, g) => a + (g.t1 - g.t0), 0), 1)
  const free = Math.max(viewportPx - gaps.length * GAP_PX, 120)
  const pxPerMs = (free / activeMs) * Math.max(zoom, 1)
  return buildAxis(timeline, (span, gap) => (gap ? GAP_PX : span * pxPerMs))
}

export const GAP_PLAY_S = 1.6

/** Segundos de reproducción de un tramo activo de `span` ms: legible, sin seguir el tiempo real. */
export const playSeconds = (span: number): number => Math.min(Math.max(0.9 + Math.sqrt(span / 1000) * 0.5, 1.1), 6.5)

/** Eje de reproducción: cada tramo entre capítulos dura `playSeconds`, y cada espera `GAP_PLAY_S`. */
export function buildPlayAxis(timeline: ApplicationTimeline): Axis {
  const breaks = timeline.chapters.flatMap((c) => [ms(c.start), ms(c.end)])
  return buildAxis(timeline, (span, gap) => (gap ? GAP_PLAY_S : playSeconds(span)), breaks)
}

/** "1 d 4 h", "3 h 20 min", "2 min 10 s", "850 ms": la duración real de un tramo comprimido. */
export function formatSpan(span: number): string {
  if (span < 1000) return `${String(Math.round(span))} ms`
  const s = Math.round(span / 1000)
  if (s < 60) return `${String(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${String(m)} min` : `${String(m)} min ${String(s % 60)} s`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${String(h)} h` : `${String(h)} h ${String(m % 60)} min`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${String(d)} d` : `${String(d)} d ${String(h % 24)} h`
}
