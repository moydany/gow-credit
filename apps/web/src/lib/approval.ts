import { money } from './format'

/** What the panel and the board need from a decision to know what was approved. */
export interface ApprovalInput {
  limit: number | null
  reasons: readonly { code: string }[]
}

export interface Approval {
  label: string
  /** Approved: the requested amount if it fits the line; otherwise (or with no amount) the line. */
  value: number
  note: string | null
}

/**
 * What is approved against what was requested: if the requested amount fits the line, the amount
 * is approved and the line is what is available; if not, the line is approved; with no amount it
 * is the maximum line. A decision evaluated with the maximum line was made without the amount
 * (for example while the re-evaluation with the amount the supplier just gave is pending), so it
 * counts as no amount. The cents tolerance matches the WhatsApp notice.
 */
export function approvalOf(d: ApprovalInput, requested: number | null | undefined): Approval | null {
  if (d.limit === null) return null
  const amount = d.reasons.some((r) => r.code === 'evaluated_at_max_line') ? null : (requested ?? null)
  if (amount === null) return { label: 'Línea máxima', value: d.limit, note: null }
  if (amount <= d.limit + 0.005) return { label: 'Monto aprobado', value: amount, note: `Línea disponible hasta ${money(d.limit)}` }
  return { label: 'Línea aprobada', value: d.limit, note: `de ${money(amount)} solicitados; el resto no cabe` }
}
