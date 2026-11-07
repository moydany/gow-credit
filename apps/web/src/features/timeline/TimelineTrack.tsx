import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ApplicationTimeline, TimelineChapter, TimelineEvent } from '@gow/contracts'
import { Icon } from '../../ui/icons'
import { formatSpan, buildTrackAxis, ms } from './scale'
import { LANES } from './labels'
import { EventMark } from './EventMark'
import { layoutTrack, LANE_PAD, ROW_H } from './track-layout'

const LABEL_W = 116
const CHAPTER_H = 28
const RULER_H = 20
const MAX_ZOOM = 400

interface Props {
  timeline: ApplicationTimeline
  t: number
  playing: boolean
  onSeek: (t: number) => void
  selectedId: string | null
  chapterId: string | null
  onSelectEvent: (ev: TimelineEvent) => void
  onSelectChapter: (c: TimelineChapter) => void
}

/** 2D SVG timeline: lanes, chapters, compressed waits, zoom and a draggable playhead. */
export function TimelineTrack({ timeline, t, playing, onSeek, selectedId, chapterId, onSelectEvent, onSelectChapter }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(900)
  const [zoom, setZoom] = useState(1)
  const anchor = useRef<{ t: number; offset: number } | null>(null)
  const dragging = useRef(false)

  const axis = useMemo(() => buildTrackAxis(timeline, width, zoom), [timeline, width, zoom])
  const { placed, lanes, height } = useMemo(() => layoutTrack(timeline, axis), [timeline, axis])
  const bodyTop = CHAPTER_H + RULER_H
  const totalH = bodyTop + height
  const headX = axis.toV(t)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => { setWidth(Math.max(el.clientWidth - 8, 320)) })
    ro.observe(el)
    setWidth(Math.max(el.clientWidth - 8, 320))
    return () => { ro.disconnect() }
  }, [])

  const zoomBy = useCallback(
    (factor: number, clientX?: number) => {
      const el = scroller.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const offset = clientX === undefined ? el.clientWidth / 2 : clientX - rect.left
      anchor.current = { t: axis.toT(el.scrollLeft + offset), offset }
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z * factor)))
    },
    [axis],
  )

  // Keeps the instant being looked at under the cursor while zooming.
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    el.scrollLeft = axis.toV(a.t) - a.offset
    anchor.current = null
  }, [axis])

  // Ctrl/Cmd + wheel (or pinch) zooms; the wheel alone scrolls the page.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [zoomBy])

  // While playing, the playhead stays in view.
  useEffect(() => {
    const el = scroller.current
    if (!el || !playing) return
    if (headX < el.scrollLeft + 24 || headX > el.scrollLeft + el.clientWidth - 90) el.scrollLeft = Math.max(headX - el.clientWidth * 0.3, 0)
  }, [headX, playing])

  const seekAt = (clientX: number) => {
    const svg = svgRef.current
    if (!svg) return
    onSeek(axis.toT(clientX - svg.getBoundingClientRect().left))
  }

  const colorOf = (lane: string) => LANES.find((l) => l.id === lane)?.color ?? '#14171f'

  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-end gap-1">
        <button type="button" aria-label="Alejar" title="Alejar (Ctrl + rueda)" disabled={zoom <= 1} onClick={() => { zoomBy(0.7) }} className="grid size-8 place-items-center rounded-full border border-line bg-card hover:bg-sunken disabled:opacity-40">
          <Icon name="zoomOut" size={16} />
        </button>
        <button type="button" aria-label="Acercar" title="Acercar (Ctrl + rueda)" disabled={zoom >= MAX_ZOOM} onClick={() => { zoomBy(1.4) }} className="grid size-8 place-items-center rounded-full border border-line bg-card hover:bg-sunken disabled:opacity-40">
          <Icon name="zoomIn" size={16} />
        </button>
        <button type="button" onClick={() => { setZoom(1) }} disabled={zoom === 1} className="h-8 rounded-full border border-line bg-card px-3 text-[12.5px] font-medium hover:bg-sunken disabled:opacity-40">
          Ajustar
        </button>
      </div>

      <div className="flex">
        <div className="shrink-0" style={{ width: LABEL_W, paddingTop: bodyTop }} aria-hidden="true">
          {lanes.map((l) => (
            <div key={l.id} className="flex items-center gap-2 border-t border-line/70 pr-2 text-[12px] font-medium text-ink-2" style={{ height: l.height }}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(l.id) }} />
              <span className="truncate">{LANES.find((x) => x.id === l.id)?.label}</span>
            </div>
          ))}
        </div>

        <div ref={scroller} className="scroll-thin min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-1" data-testid="track-scroller">
          <svg
            ref={svgRef}
            width={axis.size + 8}
            height={totalH + 4}
            role="group"
            aria-label="Línea de tiempo de la solicitud"
            className="block select-none"
            onPointerDown={(e) => {
              if ((e.target as Element).closest('[data-ev],[data-chapter]')) return
              dragging.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              seekAt(e.clientX)
            }}
            onPointerMove={(e) => { if (dragging.current) seekAt(e.clientX) }}
            onPointerUp={(e) => {
              dragging.current = false
              if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
            }}
          >
            <defs>
              {LANES.map((l) => (
                <pattern key={l.id} id={`hatch-${l.id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="5" height="5" fill="#fcfcfc" />
                  <line x1="0" y1="0" x2="0" y2="5" stroke={l.color} strokeWidth="2.2" />
                </pattern>
              ))}
              <pattern id="hatch-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="#efeff1" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(20,23,31,.22)" strokeWidth="1" />
              </pattern>
            </defs>

            {/* Chapters */}
            {timeline.chapters.map((c, i) => {
              const x0 = axis.toV(ms(c.start))
              const x1 = Math.max(axis.toV(ms(c.end)), x0 + 4)
              const on = c.id === chapterId
              return (
                <g key={c.id} data-chapter={c.id} role="button" tabIndex={0} aria-label={`Capítulo ${c.title}`} className="cursor-pointer outline-none" onClick={() => { onSelectChapter(c) }} onKeyDown={(e) => { if (e.key === 'Enter') onSelectChapter(c) }}>
                  <rect x={x0} y={2} width={x1 - x0 - 2} height={CHAPTER_H - 6} rx={9} fill={on ? '#14171f' : i % 2 ? '#e6e9ff' : '#efeff1'} />
                  <clipPath id={`clip-${c.id}`}>
                    <rect x={x0} y={0} width={Math.max(x1 - x0 - 8, 0)} height={CHAPTER_H} />
                  </clipPath>
                  <text clipPath={`url(#clip-${c.id})`} x={x0 + 8} y={CHAPTER_H / 2 + 1} fontSize={11.5} fontWeight={500} fill={on ? '#fff' : '#3b404b'} dominantBaseline="middle">
                    {c.title}
                  </text>
                </g>
              )
            })}

            {/* Compressed waits */}
            {axis.segments
              .filter((s) => s.gap)
              .map((s) => (
                <g key={s.t0}>
                  <rect x={s.v0} y={CHAPTER_H} width={s.v1 - s.v0} height={RULER_H + height} fill="url(#hatch-gap)" />
                  <text x={(s.v0 + s.v1) / 2} y={CHAPTER_H + RULER_H / 2} fontSize={11} fontWeight={600} textAnchor="middle" dominantBaseline="middle" fill="#3b404b">
                    {formatSpan(s.t1 - s.t0)}
                  </text>
                </g>
              ))}

            {/* Lanes */}
            {lanes.map((l) => (
              <line key={l.id} x1={0} x2={axis.size} y1={bodyTop + l.top} y2={bodyTop + l.top} stroke="#e3e3e7" />
            ))}

            {/* Events */}
            {placed.map(({ ev, x0, x1, row }) => {
              const lane = lanes.find((l) => l.id === ev.lane)
              if (!lane) return null
              return <EventMark key={ev.id} ev={ev} x0={x0} x1={x1} y={bodyTop + lane.top + LANE_PAD + row * ROW_H} laneColor={colorOf(ev.lane)} selected={ev.id === selectedId} onSelect={onSelectEvent} />
            })}

            {/* Playhead */}
            <g pointerEvents="none">
              <line x1={headX} x2={headX} y1={CHAPTER_H - 4} y2={totalH} stroke="#6574ff" strokeWidth={2} />
              <path d={`M${String(headX - 6)} ${String(CHAPTER_H - 6)} L${String(headX + 6)} ${String(CHAPTER_H - 6)} L${String(headX)} ${String(CHAPTER_H + 5)} Z`} fill="#6574ff" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}
