/**
 * Línea máxima sin monto solicitado (docs/07 A: "sin monto ni comprador, la salida es línea
 * máxima y perfil"; ADR 0015). Es el mayor monto que, pedido, la política aprobaría: la
 * dimensión de capacidad compara ingresos contra el monto, así que a más monto, menos puntaje
 * y una banda igual o peor. Se busca por bisección en centavos sobre la misma política.
 *
 * Las compuertas que piden aclaración no la anulan: se reportan como condiciones
 * (`conditional_on`). Una compuerta que rechaza o manda a revisión, o un resultado que depende
 * de datos dudosos, sí: entonces no hay línea máxima que ofrecer.
 */
import type { FinalDecisionStatus, MaxLine, Policy, Profile } from '@gow/contracts'
import { withFeatures } from './engine/counterfactuals.ts'
import { evaluate } from './engine/evaluate.ts'
import { floor2 } from './util/num.ts'

const QUALIFYING: ReadonlySet<string> = new Set<FinalDecisionStatus>(['qualified', 'qualified_with_limit'])
const MIN_AMOUNT = 0.01

interface Probe {
  ok: boolean
  status: string
  limit: number | null
  score: number | null
}

export function maxLine(policy: Policy, profile: Profile): MaxLine | null {
  const base = evaluate(policy, profile, { counterfactuals: false })
  if (base.evaluation.gates.some((g) => g.effect === 'not_qualified' || g.effect === 'human_review')) return null
  const pending = base.evaluation.gates.filter((g) => g.effect === 'needs_clarification').map((g) => g.id)
  const relaxed: Policy = { ...policy, gates: policy.gates.filter((g) => !pending.includes(g.id)) }

  const probe = (amount: number): Probe => {
    const d = evaluate(relaxed, withFeatures(profile, [{ feature: 'requested_amount', value: amount }]), { counterfactuals: false })
    const ok = QUALIFYING.has(d.status) && d.limit !== null && d.limit >= amount
    return { ok, status: d.status, limit: d.limit, score: d.score }
  }

  const first = probe(MIN_AMOUNT)
  if (!first.ok || first.limit === null) return null
  // A más monto, línea igual o menor: la línea de la solicitud mínima acota la búsqueda.
  let lo = Math.round(MIN_AMOUNT * 100)
  let hi = Math.round(first.limit * 100)
  if (probe(hi / 100).ok) lo = hi
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (probe(mid / 100).ok) lo = mid
    else hi = mid
  }
  const amount = floor2(lo / 100)
  const at = probe(amount)
  if (!at.ok) return null
  return { amount, status: at.status as MaxLine['status'], score: at.score, conditional_on: pending }
}
