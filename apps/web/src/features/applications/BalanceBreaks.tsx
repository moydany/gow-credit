/**
 * The movements where the balance stops adding up, pointed out where the analyst is already
 * looking (the review tray and the period's balance check) instead of buried in Movimientos.
 */
import clsx from 'clsx'
import { date, money } from '../../lib/format'
import { Icon } from '../../ui/icons'
import type { BalanceBreak } from './breaks'
import { targetKey, useFocus, useReview } from './focus'

export function BalanceBreaks({ breaks, className }: { breaks: BalanceBreak[]; className?: string }) {
  const focus = useFocus()
  const review = useReview()
  if (breaks.length === 0) return null
  const fixed = new Set(review.pending.map((p) => targetKey(p.target)))
  return (
    <ul className={clsx('space-y-2', className)}>
      {breaks.map((b) => {
        const { tx } = b
        const done = fixed.has(targetKey({ kind: 'transaction', transaction_id: tx.id, field: 'amount' }))
        const open = () => {
          focus(tx.source, 'conflict')
          if (!review.enabled) return
          review.edit({
            target: { kind: 'transaction', transaction_id: tx.id, field: 'amount' },
            label: `Movimiento «${tx.description.slice(0, 40)}»`,
            current: tx.amount,
            page: tx.source.page,
            snippet: tx.source.snippet,
            tx: { id: tx.id, amount: tx.amount, type: tx.type, date: tx.date },
            suggestedAmount: b.suggestedAmount,
            hint: `Aquí el saldo deja de cuadrar: con lo leído da ${money(b.expected)} y el PDF imprime ${money(b.printed)}.`,
          })
        }
        return (
          <li key={tx.id} className="rounded-2xl bg-white/75 px-3.5 py-3 text-[13px] leading-snug">
            <p className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{tx.description}</span>
              <span className="tnum shrink-0 font-medium">
                {tx.type === 'credit' ? '+' : '−'}
                {money(tx.amount)}
              </span>
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              {date(tx.date)} · p. {tx.source.page} · el saldo da <span className="tnum">{money(b.expected)}</span>, el PDF dice <span className="tnum">{money(b.printed)}</span>
            </p>
            {b.suggestedAmount !== null ? (
              <p className="mt-1 text-[12px] text-ink-2">
                Si el monto real es <strong className="tnum font-medium">{money(b.suggestedAmount)}</strong>, el saldo cuadra.
              </p>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              {done ? (
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-ink">
                  <Icon name="check" size={13} /> En tus correcciones
                </span>
              ) : (
                <button type="button" onClick={open} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-white hover:bg-ink/85">
                  <Icon name={review.enabled ? 'edit' : 'search'} size={13} /> {review.enabled ? 'Revisar y corregir' : 'Ver en el PDF'}
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
