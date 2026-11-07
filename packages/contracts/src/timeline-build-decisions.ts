/**
 * Regla de decisiones (ADR 0067): una por fila de `decisions` (activa y en sombra). La hora guardada
 * es la del cierre del trabajo y `decided_at` del payload sale de `as_of`: ninguna es real, así que se
 * coloca al inicio del paso de decisión de su trabajo. El payload se lee defensivamente y nunca se
 * copian montos ni valores de features.
 */
import { DecisionStatus } from './enums.ts'
import { addEvent, arr, get, isRec, ms, num, oneOf, pageNumber, str, type Ctx, type Job } from './timeline-build-base.ts'
import { STATUS_ES } from './timeline-build-text.ts'
import type { TimelineEvent } from './timeline.ts'
import type { TimelineDecisionRow } from './timeline-sources.ts'

type DecisionEvent = Extract<TimelineEvent, { kind: 'decision' }>

const GATE_OUTCOMES = ['pass', 'fail', 'unknown'] as const
const GATE_EFFECTS = ['none', 'needs_clarification', 'human_review', 'not_qualified'] as const

function gatesOf(p: unknown): DecisionEvent['gates'] {
  return arr(get(p, 'evaluation', 'gates'))
    .filter(isRec)
    .flatMap((g) => {
      const id = str(g.id)
      const outcome = oneOf(g.outcome, GATE_OUTCOMES)
      const effect = oneOf(g.effect, GATE_EFFECTS)
      return id !== null && outcome !== null && effect !== null ? [{ id, outcome, effect }] : []
    })
}

function dimensionsOf(p: unknown): DecisionEvent['dimensions'] {
  return arr(get(p, 'evaluation', 'dimensions'))
    .filter(isRec)
    .flatMap((x) => {
      const id = str(x.id)
      const weight = num(x.weight)
      const n = num(x.normalized)
      return id !== null && weight !== null ? [{ id, weight, normalized: n !== null && n >= 0 && n <= 1 ? n : null, used: x.used === true }] : []
    })
}

function statusOf(d: TimelineDecisionRow): DecisionStatus | null {
  const row = DecisionStatus.safeParse(d.status)
  return row.success ? row.data : (DecisionStatus.safeParse(get(d.payload, 'status')).data ?? null)
}

function scoreOf(p: unknown): number | null {
  const score = num(get(p, 'score'))
  return score !== null && score >= 0 && score <= 100 ? score : null
}

function bandIndexOf(p: unknown): number | null {
  const band = get(p, 'band', 'index')
  return typeof band === 'number' && Number.isInteger(band) && band >= 0 ? band : null
}

function versionOf(d: TimelineDecisionRow): number | null {
  return d.policyVersion !== null && d.policyVersion >= 1 ? d.policyVersion : pageNumber(get(d.payload, 'policy', 'version'))
}

/** El trabajo que guardó la decisión: el que cierra más cerca de su hora guardada. */
function ownerOf(ctx: Ctx, d: TimelineDecisionRow): Job | undefined {
  const dist = (j: Job): number => Math.abs(j.endMs - ms(d.createdAt))
  return [...ctx.jobs].sort((a, b) => dist(a) - dist(b) || a.index - b.index)[0]
}

export function emitDecisions(ctx: Ctx): void {
  for (const d of ctx.src.decisions) {
    const status = statusOf(d)
    if (status === null) continue
    const p = d.payload
    const owner = ownerOf(ctx, d)
    const chap = owner ? (owner.kind === 'redecide' ? ctx.C.redecide(owner) : ctx.C.decision(owner.round + 1)) : ctx.C.decision(1)
    addEvent<'decision'>(
      ctx,
      {
        id: `decisions:${d.id}`,
        kind: 'decision',
        lane: 'engine',
        precision: 'inferred',
        label: `Decisión ${d.kind === 'shadow' ? 'en sombra' : 'activa'}: ${STATUS_ES[status]}`,
        source: { table: 'decisions', id: d.id },
        decision_id: d.id,
        decision_kind: d.kind,
        status,
        has_limit: get(p, 'limit') != null,
        score: scoreOf(p),
        band_index: bandIndexOf(p),
        policy_version: versionOf(d),
        gates: gatesOf(p),
        dimensions: dimensionsOf(p),
        asks: arr(get(p, 'clarification', 'topics')).filter((t): t is string => typeof t === 'string'),
      },
      owner?.decideAtMs ?? owner?.endMs ?? ms(d.createdAt),
      null,
      chap,
      { sub: d.kind === 'shadow' ? 1 : 0 },
    )
  }
}
