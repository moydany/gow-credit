import { Link, useParams } from '@tanstack/react-router'
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApplicationTimeline, TimelineEvent } from '@gow/contracts'
import { useApplicationTimeline } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Card, ErrorState, Skeleton, StatusChip } from '../../ui/primitives'
import { EventPanel, type Selection } from './EventPanel'
import { formatSpan, ms } from './scale'
import { eventForPick, sceneLayout, sceneStateAt, type ScenePick } from './scene-state'
import { Scene3D, prefersReducedMotion } from './Scene3D'
import { TimelineTrack } from './TimelineTrack'
import { usd } from './labels'
import { SPEEDS, usePlayback } from './usePlayback'

export function TimelinePage() {
  const { id } = useParams({ from: '/shell/solicitudes/$id/recorrido' })
  const { data, isPending, isError, error, refetch } = useApplicationTimeline(id)

  if (isError) {
    return (
      <Card className="mt-6">
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Card>
    )
  }
  if (isPending) {
    return (
      <div className="pt-4">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="mt-6 h-[55dvh] rounded-[28px]" />
        <Skeleton className="mt-4 h-64 rounded-[28px]" />
      </div>
    )
  }
  return <TimelineView timeline={data} />
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-sunken px-3.5 py-2">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className="tnum text-[15px] font-medium leading-tight">{value}</div>
    </div>
  )
}

const Glyph = ({ kind }: { kind: 'play' | 'pause' }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {kind === 'play' ? <path d="M8 5.5v13l11-6.5z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}
  </svg>
)

function TimelineView({ timeline }: { timeline: ApplicationTimeline }) {
  const reduced = useMemo(prefersReducedMotion, [])
  // Sin autoplay con movimiento reducido ni mientras la solicitud sigue viva (el recorrido crece).
  const live = !['qualified', 'qualified_with_limit', 'not_qualified', 'failed'].includes(timeline.status)
  const pb = usePlayback(timeline, !reduced && !live)
  const { seek, toggle, nextChapter, prevChapter } = pb
  const [pinned, setPinned] = useState<Selection | null>(null)

  const layout = useMemo(() => sceneLayout(timeline), [timeline])
  // Lo que dura "un instante" en pantalla: casi un segundo de reproducción, en tiempo real del tramo actual.
  const linger = Math.min(Math.max(pb.axis.msPerUnit(pb.t) * 0.9, 400), 6000)
  const state = useMemo(() => sceneStateAt(timeline, pb.t, { lingerMs: linger }), [timeline, pb.t, linger])

  const shown: Selection | null = pinned ?? (state.activeEventId ? { type: 'event', id: state.activeEventId } : null)

  const selectEvent = useCallback(
    (ev: TimelineEvent) => {
      setPinned({ type: 'event', id: ev.id })
      seek(ms(ev.start))
    },
    [seek],
  )
  const onPick = useCallback(
    (pick: ScenePick) => {
      const ev = eventForPick(timeline, pb.t, pick)
      if (ev) setPinned({ type: 'event', id: ev.id })
    },
    [timeline, pb.t],
  )

  // Teclado: ←/→ capítulos, espacio reproduce o pausa (sin robarle teclas a los controles enfocados).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      if (e.key === 'ArrowRight') { e.preventDefault(); nextChapter() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prevChapter() }
      else if (e.key === ' ' && !(el && ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)) && !el?.closest('[role="button"]')) { e.preventDefault(); toggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [nextChapter, prevChapter, toggle])

  return (
    <div>
      <div className="pb-4 pt-2">
        <Link to="/solicitudes/$id" params={{ id: timeline.application_id }} className="inline-flex items-center gap-1.5 rounded-full py-1 pr-3 text-[13.5px] font-medium text-muted hover:text-ink">
          <Icon name="left" size={15} /> Volver a la solicitud
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="display text-[clamp(28px,3.6vw,40px)]">Recorrido</h1>
            <p className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13.5px] text-muted">
              <StatusChip status={timeline.status} />
              <span>
                Solicitud <span className="font-mono">{timeline.application_id.slice(0, 8)}</span>
              </span>
              {live ? <span>· se actualiza sola</span> : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Totales">
            <Total label="Tiempo activo" value={formatSpan(timeline.totals.active_ms)} />
            <Total label="Llamadas al modelo" value={String(timeline.totals.model_calls)} />
            <Total label="Aciertos de caché" value={String(timeline.totals.cache_hits)} />
            <Total label="Costo" value={usd(timeline.totals.cost_usd)} />
          </div>
        </div>
      </div>

      {timeline.limitations.length > 0 ? (
        <details className="group mb-3 rounded-2xl bg-amber-soft text-[13.5px] text-amber-ink">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 font-medium [&::-webkit-details-marker]:hidden">
            <Icon name="alert" size={16} className="shrink-0" />
            <span>
              {timeline.limitations.length === 1 ? '1 aviso' : `${String(timeline.limitations.length)} avisos`} sobre la precisión de los tiempos
            </span>
            <Icon name="down" size={15} className="ml-auto shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="flex flex-col gap-1.5 px-4 pb-3 pl-[42px]" aria-label="Avisos del recorrido">
            {timeline.limitations.map((l) => (
              <li key={l} className="list-disc">
                {l}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card rise={0} className="h-[58dvh] min-h-[340px] p-2">
            <Scene3D layout={layout} state={state} onPick={onPick} />
          </Card>

          <Card rise={1} className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Reproducción">
              <button type="button" onClick={prevChapter} aria-label="Capítulo anterior" title="Capítulo anterior (←)" className="grid size-10 place-items-center rounded-full border border-line bg-card hover:bg-sunken">
                <Icon name="left" />
              </button>
              <button type="button" onClick={toggle} aria-label={pb.playing ? 'Pausar' : 'Reproducir'} title="Reproducir / pausar (espacio)" className="grid size-10 place-items-center rounded-full bg-ink text-white hover:bg-ink-2">
                <Glyph kind={pb.playing ? 'pause' : 'play'} />
              </button>
              <button type="button" onClick={nextChapter} aria-label="Capítulo siguiente" title="Capítulo siguiente (→)" className="grid size-10 place-items-center rounded-full border border-line bg-card hover:bg-sunken">
                <Icon name="right" />
              </button>
              <div role="group" aria-label="Velocidad" className="ml-1 flex gap-1 rounded-full bg-sunken p-1">
                {SPEEDS.map((s) => (
                  <button key={s} type="button" aria-pressed={pb.speed === s} onClick={() => { pb.setSpeed(s) }} className={clsx('h-8 rounded-full px-3 text-[12.5px] font-medium tnum transition-colors', pb.speed === s ? 'bg-ink text-white' : 'text-ink-2 hover:bg-line')}>
                    {s}×
                  </button>
                ))}
              </div>
              <Legend />
            </div>
            <TimelineTrack
              timeline={timeline}
              t={pb.t}
              playing={pb.playing}
              onSeek={seek}
              selectedId={shown?.type === 'event' ? shown.id : null}
              chapterId={state.chapterId}
              onSelectEvent={selectEvent}
              onSelectChapter={(c) => {
                setPinned({ type: 'chapter', id: c.id })
                seek(ms(c.start))
              }}
            />
          </Card>
        </div>

        <Card rise={2} className="h-fit p-5 xl:sticky xl:top-4">
          <EventPanel timeline={timeline} selection={shown} pinned={pinned !== null} onFollow={() => { setPinned(null) }} />
        </Card>
      </div>
    </div>
  )
}

/** Cómo leer las formas: exacto sólido, derivado punteado, inferido rayado; círculo entra, cuadrado sale. */
function Legend() {
  return (
    <ul className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted" aria-label="Leyenda">
      <li className="flex items-center gap-1.5">
        <span className="size-3.5 rounded bg-ink" /> Hora exacta
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3.5 rounded border border-dashed border-ink bg-card" /> Derivada
      </li>
      <li className="flex items-center gap-1.5">
        <span className="hatch size-3.5 rounded border border-ink/50" /> Inferida
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3.5 rounded-full border border-ink bg-card" /> Entra
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3.5 rounded-[3px] border border-ink bg-card" /> Sale
      </li>
    </ul>
  )
}
