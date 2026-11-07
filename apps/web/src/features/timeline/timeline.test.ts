/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests: the indexes exist in the fixture */
import { describe, expect, it } from 'vitest'
import { ApplicationTimeline } from '@gow/contracts'
import { fixtureTimeline as tl } from './fixture'
import { buildPlayAxis, buildTrackAxis, formatSpan, GAP_PX, ms } from './scale'
import { eventForPick, sceneLayout, sceneStateAt } from './scene-state'
import { detailRows } from './labels'
import { layoutTrack } from './track-layout'

const at = (id: string): number => ms((tl.events.find((e) => e.id === id) ?? { start: '' }).start)

describe('fixture', () => {
  it('pasa el contrato del recorrido', () => {
    expect(() => ApplicationTimeline.parse(tl)).not.toThrow()
    expect(tl.events.some((e) => e.kind === 'decision' && e.decision_kind === 'shadow')).toBe(true)
    expect(tl.limitations.length).toBeGreaterThan(0)
  })

  it('los eventos vienen ordenados por inicio', () => {
    const starts = tl.events.map((e) => ms(e.start))
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })
})

describe('escala comprimida', () => {
  const axis = buildTrackAxis(tl, 1000, 1)
  const gap = tl.gaps[0]!

  it('la espera ocupa su ancho fijo, sin importar cuánto duró', () => {
    const seg = axis.segments.find((s) => s.gap)!
    expect(seg.v1 - seg.v0).toBe(GAP_PX)
    expect(ms(gap.end) - ms(gap.start)).toBeGreaterThan(86_400_000)
    expect(axis.toV(ms(gap.end)) - axis.toV(ms(gap.start))).toBeCloseTo(GAP_PX)
    // Zoom enlarges active time, not the wait.
    const zoomed = buildTrackAxis(tl, 1000, 20)
    expect(zoomed.segments.find((s) => s.gap)!.v1 - zoomed.segments.find((s) => s.gap)!.v0).toBe(GAP_PX)
    expect(zoomed.size).toBeGreaterThan(axis.size * 5)
  })

  it('conserva el orden y t ↔ x se invierte', () => {
    const times = tl.events.map((e) => ms(e.start))
    const xs = times.map((t) => axis.toV(t))
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!)
    for (const t of times) expect(axis.toT(axis.toV(t))).toBeCloseTo(t, 3)
    for (const x of [0, 10, 333, 700, axis.size]) expect(axis.toV(axis.toT(x))).toBeCloseTo(x, 4)
    expect(axis.toV(ms(tl.start))).toBe(0)
    expect(axis.toV(ms(tl.end))).toBeCloseTo(axis.size)
  })

  it('el eje de reproducción también es invertible y estrictamente creciente', () => {
    const play = buildPlayAxis(tl)
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const t = ms(tl.start) + ((ms(tl.end) - ms(tl.start)) * i) / 200
      const v = play.toV(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
      expect(play.toT(v)).toBeCloseTo(t, 3)
    }
    // Each chapter lasts something readable; the one-day wait, an instant.
    expect(play.size).toBeLessThan(60)
    const waiting = play.segments.find((s) => s.gap)!
    expect(waiting.v1 - waiting.v0).toBeLessThan(3)
  })

  it('rotula la duración real', () => {
    expect(formatSpan(ms(gap.end) - ms(gap.start))).toBe('1 d 4 h')
    expect(formatSpan(45_000)).toBe('45 s')
    expect(formatSpan(190_000)).toBe('3 min 10 s')
    expect(formatSpan(3 * 3_600_000 + 20 * 60_000)).toBe('3 h 20 min')
    expect(formatSpan(850)).toBe('850 ms')
  })

  it('reparte los eventos en filas sin traslapes', () => {
    const { placed } = layoutTrack(tl, axis)
    expect(placed).toHaveLength(tl.events.length)
    for (const a of placed) for (const b of placed) if (a !== b && a.ev.lane === b.ev.lane && a.row === b.row) expect(a.x1 <= b.x0 || b.x1 <= a.x0).toBe(true)
  })
})

describe('sceneStateAt', () => {
  it('antes de nada: ficha en el chat, páginas sin verificar', () => {
    const s = sceneStateAt(tl, ms(tl.start) - 1000)
    expect(s.token.station).toBe('chat')
    expect(s.pages.every((p) => p.verification === 'pending')).toBe(true)
    expect(s.beams).toHaveLength(0)
    expect(s.activeEventId).toBeNull()
  })

  it('mientras llega el PDF viaja una cápsula entrante y el relay se ilumina', () => {
    const t = at('inbound_messages:in-2') + 300
    const s = sceneStateAt(tl, t, { lingerMs: 1000 })
    expect(s.capsules).toHaveLength(1)
    expect(s.capsules[0]).toMatchObject({ direction: 'in', message: 'document' })
    expect(s.capsules[0]!.progress).toBeGreaterThan(0)
    expect(s.relayGlow).toBeGreaterThan(0.5)
    expect(s.token.station).toBe('relay')
  })

  it('en la extracción: haces a las páginas que lee y destello de caché', () => {
    const t = at('llm:tx-a') + 5000
    const s = sceneStateAt(tl, t)
    const ids = s.beams.map((b) => b.eventId)
    expect(ids).toContain('llm:tx-a')
    expect(ids).toContain('llm:tx-b')
    const a = s.beams.find((b) => b.eventId === 'llm:tx-a')!
    expect(a.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(a.progress).toBeGreaterThan(0)
    expect(a.progress).toBeLessThan(1)
    expect(s.token.station).toBe('extract')
    expect(s.pages.filter((p) => p.reading).map((p) => p.page)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]))
    // No verification yet: all striped.
    expect(s.pages.every((p) => p.verification === 'pending')).toBe(true)
    const flash = sceneStateAt(tl, at('llm:tx-c') + 200, { lingerMs: 1000 })
    expect(flash.flashes).toHaveLength(1)
    expect(flash.flashes[0]!.strength).toBeCloseTo(0.8)
  })

  it('un error es un haz coral', () => {
    const s = sceneStateAt(tl, at('llm:retry-5') + 800)
    expect(s.beams.find((b) => b.eventId === 'llm:retry-5')?.kind).toBe('error')
  })

  it('tras la verificación las páginas toman su color', () => {
    const s = sceneStateAt(tl, at('extractions:ex-1') + 10)
    const by = Object.fromEntries(s.pages.map((p) => [p.page, p.verification]))
    expect(by).toEqual({ 1: 'verified', 2: 'verified', 3: 'unverified', 4: 'conflict', 5: 'verified', 6: 'none' })
    expect(s.pages.find((p) => p.page === 4)?.issues).toBe(true)
  })

  it('decisión ronda 1: compuertas coloreadas, pilares y ficha fantasma de la sombra', () => {
    const t = at('decisions:dec-1s') + 100
    const s = sceneStateAt(tl, t, { lingerMs: 1000 })
    expect(s.token.station).toBe('decide')
    expect(s.gates.map((g) => g.color)).toEqual(['pass', 'clarify', 'pass'])
    expect(s.dimensions.find((d) => d.id === 'cash_flow_stability')).toMatchObject({ used: true, value: 0.72 })
    expect(s.dimensions.find((d) => d.id === 'income_concentration')?.used).toBe(false)
    expect(s.ghost).toMatchObject({ status: 'qualified_with_limit' })
    // Shadow doesn't change the token or the gates, and fades out.
    expect(sceneStateAt(tl, t + 5000, { lingerMs: 1000 }).ghost).toBeNull()
  })

  it('la espera de la aclaración deja la ficha flotando en el chat', () => {
    const gap = tl.gaps[0]!
    const mid = (ms(gap.start) + ms(gap.end)) / 2
    const s = sceneStateAt(tl, mid)
    expect(s.token).toMatchObject({ station: 'chat', floating: true, status: 'needs_clarification' })
    expect(s.beams).toHaveLength(0)
  })

  it('al reanudar la ficha baja de nuevo y la ronda 2 cambia las compuertas', () => {
    const resumed = sceneStateAt(tl, at('queue:resume') + 100)
    expect(resumed.token).toMatchObject({ station: 'queue', floating: false })
    const s = sceneStateAt(tl, at('decisions:dec-2') + 100)
    expect(s.gates.every((g) => g.color === 'pass')).toBe(true)
    expect(s.token.status).toBe('qualified_with_limit')
  })

  it('el veredicto lleva la ficha a la plataforma que toca', () => {
    const s = sceneStateAt(tl, ms(tl.end))
    expect(s.token.station).toBe('verdict_ok')
    expect(s.token.status).toBe('qualified_with_limit')
    expect(s.chapterId).toBe('c-verdict')
  })

  it('retroceder da el mismo estado que llegar ahí', () => {
    const t1 = at('llm:double') + 3000
    const t2 = at('decisions:dec-2') + 100
    const direct = sceneStateAt(tl, t1)
    sceneStateAt(tl, t2)
    expect(sceneStateAt(tl, t1)).toEqual(direct)
    // And once back, what came later disappears.
    expect(direct.gates.every((g) => g.color === 'unknown')).toBe(true)
    expect(direct.pages.every((p) => p.verification === 'pending')).toBe(true)
  })

  it('el layout de la escena sale de los modelos, compuertas y páginas del recorrido', () => {
    const l = sceneLayout(tl)
    expect(l.models).toEqual(['gemini-3.8-flash', 'claude-opus-5-5', 'claude-haiku-5-5'])
    expect(l.gates).toHaveLength(3)
    expect(l.documents[0]!.pages).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('clic en la escena', () => {
  it('página → su verificación; orbe → su última llamada; compuerta → la decisión vigente', () => {
    const t = at('decisions:dec-1') + 50
    expect(eventForPick(tl, t, { type: 'page', document: 0, page: 4 })?.kind).toBe('verification')
    expect(eventForPick(tl, at('llm:classify') + 100, { type: 'page', document: 0, page: 1 })?.id).toBe('llm:classify')
    expect(eventForPick(tl, t, { type: 'orb', model: 'claude-opus-5-5' })?.id).toBe('llm:retry-5b')
    expect(eventForPick(tl, t, { type: 'gate', id: 'min_history_months' })?.id).toBe('decisions:dec-1')
    expect(eventForPick(tl, at('decisions:dec-2') + 50, { type: 'gate', id: 'min_history_months' })?.id).toBe('decisions:dec-2')
  })
})

describe('panel', () => {
  it('muestra los campos de una llamada al modelo y nada que el contrato no traiga', () => {
    const call = tl.events.find((e) => e.id === 'llm:tx-a')!
    const labels = detailRows(call).map((r) => r.label)
    expect(labels).toEqual(expect.arrayContaining(['Modelo', 'Propósito', 'Prompt', 'Esfuerzo', 'Páginas', 'De caché', 'Tokens', 'Costo', 'Latencia']))
  })
})
