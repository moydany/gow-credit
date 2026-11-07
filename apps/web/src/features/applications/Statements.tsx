/**
 * Several statements in one request (ADR 0072): which months each document covers and what the
 * profile did with them (evaluated, cut to the evaluated months, left out), a picker to move
 * between documents and the table of every month side by side.
 */
import type { ApplicationDetail, DetailStatement, PeriodWindowStatus } from '@gow/contracts'
import clsx from 'clsx'
import { moneyParts } from '../../lib/format'
import { Chip, type Tone } from '../../ui/primitives'

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${iso.slice(0, 4)}`

/** "oct 2026", "jun–sep 2026" or "nov 2025–ene 2026". */
export function rangeLabel(start: string | null, end: string | null): string {
  if (!start && !end) return 'sin fechas'
  const a = month(start ?? end ?? '')
  const b = month(end ?? start ?? '')
  if (a === b) return a
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, -5)}–${b}` : `${a}–${b}`
}

export const WINDOW_STATUS: Record<PeriodWindowStatus, { label: string; tone: Tone; hint: string }> = {
  evaluated: { label: 'Evaluado', tone: 'accent', hint: 'Entra completo al perfil' },
  cut: { label: 'Recortado', tone: 'amber', hint: 'Solo entran los meses evaluados de este periodo' },
  outside: { label: 'No se evaluó', tone: 'hatch', hint: 'Es anterior a los meses que evalúa la política' },
  excluded: { label: 'No entra', tone: 'coral', hint: 'Tarjeta de crédito, otra moneda, documento repetido o extracción fallida' },
}

/** The document's dates: from its first period start to its last end. */
function statementRange(s: DetailStatement): string {
  const starts = s.periods.flatMap((p) => (p.start ? [p.start] : []))
  const ends = s.periods.flatMap((p) => (p.end ? [p.end] : []))
  const printed = s.extraction.accounts.flatMap((a) => a.periods)
  const first = [...starts, ...printed.flatMap((p) => (p.period_start.value ? [p.period_start.value] : []))].sort()[0] ?? null
  const last = [...ends].sort().at(-1) ?? null
  return rangeLabel(first, last)
}

/** One status for the whole document: the best of its periods. */
export function statementStatus(s: DetailStatement): PeriodWindowStatus {
  const order: PeriodWindowStatus[] = ['evaluated', 'cut', 'outside', 'excluded']
  return order.find((o) => s.periods.some((p) => p.status === o)) ?? 'excluded'
}

/** Is there more than one month to tell apart? */
export function hasSeveralMonths(d: ApplicationDetail): boolean {
  return d.statements.length > 1 || d.statements.some((s) => s.periods.length > 1)
}

/** "3 estados de cuenta · evalúa ago–oct 2026 (3 meses)" */
export function evaluationSummary(d: ApplicationDetail): string | null {
  if (!hasSeveralMonths(d)) return null
  const docs = d.statements.length === 1 ? '1 estado de cuenta' : `${String(d.statements.length)} estados de cuenta`
  const e = d.evaluation
  if (!e?.end) return docs
  return `${docs} · evalúa ${rangeLabel(e.start, e.end)} (${e.months === 1 ? '1 mes' : `${String(e.months)} meses`})`
}

export function StatementPicker({ statements, selected, onSelect, locked }: { statements: readonly DetailStatement[]; selected: string; onSelect: (id: string) => void; locked: boolean }) {
  return (
    <div role="tablist" aria-label="Estados de cuenta de la solicitud" className="scroll-thin mb-3 flex gap-2 overflow-x-auto pb-1">
      {statements.map((s) => {
        const st = WINDOW_STATUS[statementStatus(s)]
        const active = s.document_id === selected
        return (
          <button
            key={s.document_id}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={locked && !active}
            title={locked && !active ? 'Guarda o quita las correcciones de este documento antes de cambiar' : st.hint}
            onClick={() => { onSelect(s.document_id) }}
            className={clsx('flex shrink-0 items-center gap-2.5 rounded-full border px-4 py-2 text-left transition-colors disabled:opacity-45', active ? 'border-ink bg-ink text-white' : 'border-line bg-card hover:bg-sunken')}
          >
            <span className="text-[13.5px] font-medium">{statementRange(s)}</span>
            <span className={clsx('text-[12px]', active ? 'text-white/70' : 'text-muted')}>{s.extraction.bank_name.value ?? 'Banco'}</span>
            <Chip tone={st.tone} dot>
              {st.label}
            </Chip>
            {s.origin === 'owner_answer' ? <span className={clsx('text-[11.5px]', active ? 'text-white/70' : 'text-muted')}>respuesta</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/** Every period of every document, oldest first, with the printed totals and what the profile did with it. */
export function MonthsTable({ statements, selected, onSelect }: { statements: readonly DetailStatement[]; selected: string; onSelect: (id: string) => void }) {
  const rows = statements
    .flatMap((s) =>
      s.periods.map((w) => {
        const period = s.extraction.accounts.find((a) => a.id === w.account_id)?.periods.find((p) => p.id === w.period_id)
        return { s, w, period }
      }),
    )
    .sort((a, b) => (a.w.end ?? '').localeCompare(b.w.end ?? ''))
  if (rows.length === 0) return <p className="text-[14px] text-muted">Aún no hay periodos leídos.</p>
  // The bank only says something when the months come from more than one.
  const banks = new Set(rows.map((r) => r.s.extraction.bank_name.value ?? ''))
  const amount = (v: number | null | undefined) => moneyParts(v).amount
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-snug text-muted">Totales impresos por el banco en cada periodo, en pesos. Toca una fila para ver ese estado de cuenta.</p>
      <div className="inner overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2.5 font-medium">Periodo</th>
              <th className="px-2 py-2.5 text-right font-medium">Abonos</th>
              <th className="px-2 py-2.5 text-right font-medium">Cargos</th>
              <th className="px-2 py-2.5 text-right font-medium">Saldo final</th>
              <th className="px-3 py-2.5 text-right font-medium">Perfil</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, w, period }) => {
              const st = WINDOW_STATUS[w.status]
              return (
                <tr key={`${s.document_id}-${w.account_id}-${w.period_id}`} onClick={() => { onSelect(s.document_id) }} className={clsx('cursor-pointer border-t border-line/70 hover:bg-sunken', s.document_id === selected && 'bg-sunken')}>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span className="font-medium">{rangeLabel(w.start, w.end)}</span>
                    {banks.size > 1 ? <span className="block text-[12px] text-muted">{s.extraction.bank_name.value ?? 'Banco'}</span> : null}
                  </td>
                  <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">{amount(period?.summary.total_credits.value)}</td>
                  <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">{amount(period?.summary.total_debits.value)}</td>
                  <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">{amount(period?.summary.closing_balance.value)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right" title={st.hint}>
                    <Chip tone={st.tone} dot>
                      {st.label}
                    </Chip>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
