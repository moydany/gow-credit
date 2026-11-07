import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApplicationTimeline } from '@gow/contracts'
import { buildPlayAxis, ms } from './scale'

export const SPEEDS = [0.5, 1, 2, 4] as const

/**
 * Journey playback. The playhead lives in real time (`t`, ms since epoch) but advances along the
 * playback axis: each chapter lasts something readable and each wait an instant.
 */
export function usePlayback(timeline: ApplicationTimeline, autoplay: boolean) {
  const axis = useMemo(() => buildPlayAxis(timeline), [timeline])
  const chapters = useMemo(() => [...timeline.chapters].map((c) => ms(c.start)).sort((a, b) => a - b), [timeline.chapters])
  const [t, setT] = useState(() => ms(timeline.start))
  const [playing, setPlaying] = useState(autoplay)
  const [speed, setSpeed] = useState<number>(1)
  const tRef = useRef(t)
  const axisRef = useRef(axis)
  axisRef.current = axis

  const seek = useCallback((next: number) => {
    const a = axisRef.current
    const v = Math.min(Math.max(next, a.tStart), a.tEnd)
    tRef.current = v
    setT(v)
  }, [])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const a = axisRef.current
      const v = a.toV(tRef.current) + dt * speed
      if (v >= a.size) {
        seek(a.tEnd)
        setPlaying(false)
        return
      }
      seek(a.toT(v))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf) }
  }, [playing, speed, seek])

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && tRef.current >= axisRef.current.tEnd) seek(axisRef.current.tStart)
      return !p
    })
  }, [seek])

  const nextChapter = useCallback(() => {
    const next = chapters.find((c) => c > tRef.current + 1)
    seek(next ?? axisRef.current.tEnd)
  }, [chapters, seek])

  const prevChapter = useCallback(() => {
    // If a bit of the chapter has already played, go to its start; otherwise to the previous one.
    const here = tRef.current
    const slack = Math.min(axisRef.current.msPerUnit(here) * 0.4, 3000)
    const before = chapters.filter((c) => c < here - Math.max(slack, 1))
    seek(before[before.length - 1] ?? axisRef.current.tStart)
  }, [chapters, seek])

  return { t, seek, playing, setPlaying, toggle, speed, setSpeed, nextChapter, prevChapter, axis }
}
