import clsx from 'clsx'
import type { TimelineEvent } from '@gow/contracts'
import { ROW_H } from './track-layout'

const CORAL = '#f0594a'
const INK = '#14171f'

interface Style {
  fill: string
  stroke: string
  dash: string | undefined
  width: number
}

const isError = (ev: TimelineEvent): boolean => ev.kind === 'model_call' && ev.outcome === 'error'
const isCacheHit = (ev: TimelineEvent): boolean => ev.kind === 'model_call' && ev.cache_hit

/** Exacta: sólida; derivada: contorno punteado; inferida: rayado diagonal. */
function styleOf(ev: TimelineEvent, laneColor: string): Style {
  const color = isError(ev) ? CORAL : laneColor
  const fill = { exact: color, inferred: `url(#hatch-${ev.lane})`, derived: '#fcfcfc' }[ev.precision]
  const stroke = ev.precision === 'derived' ? color : isError(ev) ? '#a3271b' : INK
  return { fill, stroke, dash: ev.precision === 'derived' ? '3 2.5' : undefined, width: ev.precision === 'exact' ? 1 : 1.6 }
}

function Shape({ ev, x0, x1, cy, st }: { ev: TimelineEvent; x0: number; x1: number; cy: number; st: Style }) {
  const cx = x0 + (x1 - x0) / 2
  const common = { stroke: st.stroke, strokeWidth: st.width, strokeDasharray: st.dash }
  if (ev.kind === 'inbound_message') return <circle cx={cx} cy={cy} r={7} fill={st.fill} {...common} />
  if (ev.kind === 'outbound_message') return <rect x={cx - 7} y={cy - 7} width={14} height={14} rx={2} fill={st.fill} {...common} />
  if (ev.end !== null && x1 - x0 > 10) {
    return <rect x={x0} y={cy - 7} width={x1 - x0} height={14} rx={4} fill={st.fill} {...common} strokeWidth={ev.precision === 'exact' ? 0.8 : 1.6} opacity={isCacheHit(ev) ? 0.55 : 1} />
  }
  const d = `M${String(cx)} ${String(cy - 7)} L${String(cx + 6)} ${String(cy)} L${String(cx)} ${String(cy + 7)} L${String(cx - 6)} ${String(cy)} Z`
  return <path d={d} fill={isCacheHit(ev) ? '#a6f23b' : st.fill} {...common} />
}

/** Un evento en la línea de tiempo: círculo si entra, cuadrado si sale, barra si dura, rombo si es puntual. */
export function EventMark({ ev, x0, x1, y, laneColor, selected, onSelect }: { ev: TimelineEvent; x0: number; x1: number; y: number; laneColor: string; selected: boolean; onSelect: (ev: TimelineEvent) => void }) {
  const cy = y + ROW_H / 2 - 1
  return (
    <g
      data-ev={ev.id}
      role="button"
      tabIndex={0}
      aria-label={ev.label}
      aria-pressed={selected}
      className="cursor-pointer outline-none [&:focus-visible>.ring]:stroke-indigo"
      onClick={() => { onSelect(ev) }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSelect(ev)
      }}
    >
      <title>{ev.label}</title>
      <rect className={clsx('ring', selected ? 'stroke-ink' : 'stroke-transparent')} x={x0 - 3} y={cy - 10} width={Math.max(x1 - x0, 14) + 6} height={20} rx={7} fill="none" strokeWidth={2} />
      <Shape ev={ev} x0={x0} x1={x1} cy={cy} st={styleOf(ev, laneColor)} />
    </g>
  )
}
