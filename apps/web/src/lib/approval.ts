import { money } from './format'

/** Lo que el panel y el tablero necesitan de una decisión para saber qué se aprobó. */
export interface ApprovalInput {
  limit: number | null
  reasons: readonly { code: string }[]
}

export interface Approval {
  label: string
  /** Lo aprobado: el monto pedido si cabe en la línea; si no cabe o no hay monto, la línea. */
  value: number
  note: string | null
}

/**
 * Lo que se aprueba contra lo que se pidió (ADR 0053): si el monto solicitado cabe en la línea se
 * aprueba el monto y la línea es lo disponible; si no cabe se aprueba la línea; sin monto es la línea
 * máxima. Una decisión evaluada con la línea máxima se tomó sin el monto (por ejemplo, mientras llega
 * la reevaluación con el monto que acaba de dar el proveedor), así que cuenta como sin monto. La
 * tolerancia de centavos es la del aviso por WhatsApp.
 */
export function approvalOf(d: ApprovalInput, requested: number | null | undefined): Approval | null {
  if (d.limit === null) return null
  const amount = d.reasons.some((r) => r.code === 'evaluated_at_max_line') ? null : (requested ?? null)
  if (amount === null) return { label: 'Línea máxima', value: d.limit, note: null }
  if (amount <= d.limit + 0.005) return { label: 'Monto aprobado', value: amount, note: `Línea disponible hasta ${money(d.limit)}` }
  return { label: 'Línea aprobada', value: d.limit, note: `de ${money(amount)} solicitados; el resto no cabe` }
}
