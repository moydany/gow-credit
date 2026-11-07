import { Link } from '@tanstack/react-router'
import clsx from 'clsx'
import type { ApplicationTimeline, TimelineChapter, TimelineEvent } from '@gow/contracts'
import { Icon } from '../../ui/icons'
import { Button, Chip } from '../../ui/primitives'
import { chapterSummary, clock, detailRows, gateRows, KIND_LABEL, LANE_LABEL, PRECISION_LABEL, PRECISION_NOTE, usd } from './labels'
import { formatSpan, ms } from './scale'

export type Selection = { type: 'event'; id: string } | { type: 'chapter'; id: string }

function Rows({ rows }: { rows: { label: string; value: string; mono?: boolean }[] }) {
  return (
    <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted">{r.label}</dt>
          <dd className={clsx('break-words text-right text-ink', r.mono && 'font-mono text-[12.5px]')}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const GATE_TONE = { pass: 'accent', warn: 'amber', fail: 'coral', none: 'plain' } as const

/** Detalle del evento o capítulo seleccionado. Solo muestra lo que el contrato trae. */
export function EventPanel({ timeline, selection, pinned, onFollow }: { timeline: ApplicationTimeline; selection: Selection | null; pinned: boolean; onFollow: () => void }) {
  const ev = selection?.type === 'event' ? timeline.events.find((e) => e.id === selection.id) : undefined
  const chapter = selection?.type === 'chapter' ? timeline.chapters.find((c) => c.id === selection.id) : undefined

  return (
    <div aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[17px] font-medium leading-tight tracking-tight">{chapter ? 'Capítulo' : 'Detalle del evento'}</h2>
        {pinned ? (
          <Button variant="ghost" size="sm" onClick={onFollow}>
            Seguir la reproducción
          </Button>
        ) : (
          <Chip tone="plain" dot>
            Sigue la reproducción
          </Chip>
        )}
      </div>

      {!ev && !chapter ? <p className="mt-4 text-[14px] text-muted">Elige un evento en la línea de tiempo o un objeto de la maqueta.</p> : null}
      {chapter ? <ChapterBody timeline={timeline} chapter={chapter} /> : null}
      {ev ? <EventBody timeline={timeline} ev={ev} /> : null}
    </div>
  )
}

function ChapterBody({ timeline, chapter }: { timeline: ApplicationTimeline; chapter: TimelineChapter }) {
  const s = chapterSummary(timeline, chapter)
  const span = ms(chapter.end) - ms(chapter.start)
  return (
    <div>
      <p className="mt-3 text-[15px] font-medium">
        {chapter.title}
      </p>
      <Rows
        rows={[
          { label: 'Empieza', value: clock(ms(chapter.start)) },
          { label: 'Termina', value: clock(ms(chapter.end)) },
          { label: 'Duración', value: formatSpan(span) },
          { label: 'Eventos', value: String(s.events) },
          { label: 'Llamadas al modelo', value: String(s.calls) },
          { label: 'Costo', value: usd(s.cost) },
        ]}
      />
    </div>
  )
}

function EventBody({ timeline, ev }: { timeline: ApplicationTimeline; ev: TimelineEvent }) {
  const start = ms(ev.start)
  const dur = ev.end ? ms(ev.end) - start : null
  return (
    <div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Chip tone="indigo">{KIND_LABEL[ev.kind]}</Chip>
        <Chip tone="plain">{LANE_LABEL[ev.lane]}</Chip>
        <Chip tone={ev.precision === 'exact' ? 'accent' : ev.precision === 'derived' ? 'plain' : 'hatch'}>{PRECISION_LABEL[ev.precision]}</Chip>
      </div>
      <p className="mt-3 text-[15px] font-medium leading-snug">{ev.label}</p>
      <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{PRECISION_NOTE[ev.precision]}</p>

      <Rows
        rows={[
          { label: 'Hora', value: clock(start) },
          ...(dur !== null ? [{ label: 'Duración', value: formatSpan(dur) }] : []),
          ...detailRows(ev),
        ]}
      />

      {ev.kind === 'decision' ? (
        <>
          <h3 className="mt-5 text-[13px] font-medium text-ink-2">Compuertas</h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {gateRows(ev).map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="font-mono text-[12px]">{g.id}</span>
                <Chip tone={GATE_TONE[g.tone]} dot>
                  {g.text}
                </Chip>
              </li>
            ))}
          </ul>
          <h3 className="mt-5 text-[13px] font-medium text-ink-2">Dimensiones</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {ev.dimensions.map((d) => (
              <li key={d.id} className="text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[12px]">{d.id}</span>
                  <span className="tnum text-muted">
                    {d.used && d.normalized !== null ? `${String(Math.round(d.normalized * 100))} %` : 'sin usar'} · peso {d.weight}
                  </span>
                </div>
                <div className={clsx('mt-1 h-1.5 overflow-hidden rounded-full', d.used ? 'bg-sunken' : 'hatch')}>
                  {d.used && d.normalized !== null ? <div className="h-full rounded-full bg-indigo" style={{ width: `${String(Math.round(d.normalized * 100))}%` }} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {ev.kind === 'model_call' ? (
        ev.exchange_id ? (
          <Link
            to="/configuracion/bitacora"
            search={{ tab: 'modelo', solicitud: timeline.application_id, ver: ev.exchange_id }}
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[13.5px] font-medium hover:bg-sunken"
          >
            <Icon name="bolt" size={14} /> Ver la llamada al modelo
          </Link>
        ) : (
          <p className="mt-5 text-[12.5px] text-muted">Esta llamada es anterior al registro de llamadas: no hay detalle que abrir.</p>
        )
      ) : null}

      {ev.source ? (
        <p className="mt-5 text-[11.5px] text-muted">
          Fila de origen: <span className="font-mono">{ev.source.table}</span>
        </p>
      ) : null}
    </div>
  )
}
