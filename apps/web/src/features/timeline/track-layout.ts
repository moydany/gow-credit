/** Splits events into lanes and rows of the 2D timeline (no React). */
import type { ApplicationTimeline, TimelineEvent, TimelineLane } from '@gow/contracts'
import type { Axis } from './scale'
import { ms } from './scale'
import { LANES } from './labels'

export const ROW_H = 20
export const LANE_PAD = 8

export interface Placed {
  ev: TimelineEvent
  x0: number
  x1: number
  row: number
}
export interface LaneBox {
  id: TimelineLane
  rows: number
  top: number
  height: number
}

/** Minimum width to see and tap them: a point event doesn't vanish when compressed. */
const minWidth = (ev: TimelineEvent): number => (ev.kind === 'inbound_message' || ev.kind === 'outbound_message' ? 14 : 9)

export function layoutTrack(tl: ApplicationTimeline, axis: Axis): { placed: Placed[]; lanes: LaneBox[]; height: number } {
  const placed: Placed[] = []
  const lanes: LaneBox[] = []
  let top = 0
  for (const lane of LANES) {
    const evs = tl.events.filter((e) => e.lane === lane.id)
    const rowEnds: number[] = []
    const items = evs
      .map((ev) => {
        const x0 = axis.toV(ms(ev.start))
        const x1 = Math.max(ev.end ? axis.toV(ms(ev.end)) : x0, x0 + minWidth(ev))
        return { ev, x0, x1 }
      })
      .sort((a, b) => a.x0 - b.x0)
    for (const it of items) {
      let row = rowEnds.findIndex((end) => end + 3 <= it.x0)
      if (row < 0) {
        row = rowEnds.length
        rowEnds.push(0)
      }
      rowEnds[row] = it.x1
      placed.push({ ...it, row })
    }
    const rows = Math.max(rowEnds.length, 1)
    const height = rows * ROW_H + LANE_PAD * 2
    lanes.push({ id: lane.id, rows, top, height })
    top += height
  }
  return { placed, lanes, height: top }
}
