import type { Account, Issue, Period, StatementExtraction, Transaction } from '@gow/contracts'
import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { CATEGORY_LABEL, date, ISSUE_SEVERITY_LABEL, money, number } from '../../lib/format'
import { Icon } from '../../ui/icons'
import { Chip, EmptyState } from '../../ui/primitives'
import { BalanceBreaks } from './BalanceBreaks'
import { balanceBreaks, periodBreaks } from './breaks'
import { useFocus, useReview, Val } from './focus'

export type ExtractionTab = 'resumen' | 'movimientos' | 'fiscal' | 'alertas'

export interface FlatTx {
  tx: Transaction
  account: Account
  period: Period
}

export function flattenTransactions(x: StatementExtraction): FlatTx[] {
  return x.accounts.flatMap((account) => account.periods.flatMap((period) => period.transactions.map((tx) => ({ tx, account, period }))))
}

type Walked = StatementExtraction['accounts'][number]['periods'][number]['transactions'][number]
type WalkedField = { verification: string; value: unknown; source: { page: number } | null }

/** Walks every extracted value (header, accounts, periods) and every movement, for the review warnings. */
function walkExtraction(x: StatementExtraction, onField: (f: WalkedField) => void, onTransaction: (t: Walked) => void): void {
  onField(x.bank_name)
  Object.values(x.holder).forEach(onField)
  for (const a of x.accounts) {
    ;[a.product_name, a.account_type, a.account_number, a.clabe, a.currency].forEach(onField)
    for (const p of a.periods) {
      ;[p.period_start, p.period_end, p.statement_date].forEach(onField)
      Object.values(p.summary).forEach(onField)
      p.transactions.forEach(onTransaction)
    }
  }
}

/** Every extracted value that isn't verified, with its label, for the header warning. */
export function unverifiedCount(x: StatementExtraction): number {
  let n = 0
  walkExtraction(
    x,
    (f) => {
      if (f.verification !== 'verified' && f.value !== null) n++
    },
    (t) => {
      if (t.verification !== 'verified') n++
    },
  )
  return n
}

/** Pages with something to review: unverified values, doubtful movements or alerts. */
export function alertPages(x: StatementExtraction): Set<number> {
  const pages = new Set<number>()
  walkExtraction(
    x,
    (f) => {
      if (f.verification !== 'verified' && f.source) pages.add(f.source.page)
    },
    (t) => {
      if (t.verification !== 'verified') pages.add(t.source.page)
    },
  )
  for (const i of x.issues) if (i.page && i.severity !== 'info') pages.add(i.page)
  for (const b of balanceBreaks(x)) pages.add(b.tx.source.page)
  return pages
}

const TABS: { key: ExtractionTab; label: string }[] = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'movimientos', label: 'Movimientos' },
  { key: 'fiscal', label: 'Fiscal' },
  { key: 'alertas', label: 'Alertas' },
]

export function ExtractionPanel({ x, tab, onTab }: { x: StatementExtraction; tab: ExtractionTab; onTab: (t: ExtractionTab) => void }) {
  const txs = useMemo(() => flattenTransactions(x), [x])
  const bad = txs.filter((t) => t.tx.verification !== 'verified').length
  const counts: Record<ExtractionTab, number | null> = { resumen: null, movimientos: txs.length, fiscal: x.fiscal_documents.length, alertas: x.issues.length }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-6 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-medium leading-tight tracking-tight">Extracción</h2>
            <p className="mt-0.5 truncate text-[13px] text-muted">
              {x.bank_name.value ?? 'Banco sin identificar'} · {x.document.page_count} págs. · {x.document.route === 'vision_only' ? 'leído por visión' : 'texto y visión'}
            </p>
          </div>
          {unverifiedCount(x) > 0 ? (
            <Chip tone="amber" icon="help">
              {unverifiedCount(x)} sin verificar
            </Chip>
          ) : (
            <Chip tone="accent" icon="check">
              Todo verificado
            </Chip>
          )}
        </div>
        <div role="tablist" aria-label="Secciones de la extracción" className="scroll-thin mt-4 flex gap-1.5 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => { onTab(t.key) }}
              className={clsx('inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition-colors', tab === t.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
            >
              {t.label}
              {counts[t.key] !== null ? <span className={clsx('tnum text-[12px]', tab === t.key ? 'text-white/70' : 'text-muted')}>{counts[t.key]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4" role="tabpanel">
        {tab === 'resumen' ? <Summary x={x} /> : tab === 'movimientos' ? <Transactions txs={txs} bad={bad} /> : tab === 'fiscal' ? <Fiscal x={x} /> : <Alerts issues={x.issues} />}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-2.5 last:border-0">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[14px] font-medium">{children}</dd>
    </div>
  )
}

const HOLDER_TYPE: Record<string, string> = { individual: 'Persona física', individual_with_business_activity: 'Persona física con actividad empresarial', legal_entity: 'Persona moral' }
const ACCOUNT_TYPE: Record<string, string> = { checking: 'Cheques', savings: 'Ahorro', investment: 'Inversión', credit_card: 'Tarjeta de crédito', other: 'Otro' }

function Summary({ x }: { x: StatementExtraction }) {
  return (
    <div className="space-y-5">
      <section className="inner px-5 py-3">
        <h3 className="pb-1 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted">Titular</h3>
        <dl>
          <Row label="Nombre">
            <Val field={x.holder.name} target={{ kind: 'holder', field: 'name' }} label="el nombre del titular" />
          </Row>
          <Row label="RFC">
            <Val field={x.holder.rfc} className="font-mono text-[13px]" target={{ kind: 'holder', field: 'rfc' }} label="el RFC del titular" />
          </Row>
          <Row label="Tipo">
            <Val field={x.holder.holder_type} format={(v) => HOLDER_TYPE[v] ?? v} target={{ kind: 'holder', field: 'holder_type' }} label="el tipo de titular" />
          </Row>
          <Row label="Domicilio">
            <Val field={x.holder.address} />
          </Row>
          <Row label="Banco">
            <Val field={x.bank_name} />
          </Row>
        </dl>
      </section>
      {x.accounts.map((a) => (
        <AccountBlock key={a.id} a={a} />
      ))}
    </div>
  )
}

function AccountBlock({ a }: { a: Account }) {
  return (
    <div className="space-y-4">
      <section className="inner px-5 py-3">
        <h3 className="pb-1 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted">Cuenta</h3>
        <dl>
          <Row label="Producto">
            <Val field={a.product_name} />
          </Row>
          <Row label="Tipo">
            <Val field={a.account_type} format={(v) => ACCOUNT_TYPE[v] ?? v} />
          </Row>
          <Row label="CLABE">
            <Val field={a.clabe} className="font-mono text-[13px]" target={{ kind: 'account', account_id: a.id, field: 'clabe' }} label="la CLABE" />
          </Row>
          <Row label="Número">
            <Val field={a.account_number} className="font-mono text-[13px]" target={{ kind: 'account', account_id: a.id, field: 'account_number' }} label="el número de cuenta" />
          </Row>
          <Row label="Moneda">
            <Val field={a.currency} />
          </Row>
        </dl>
      </section>
      {a.periods.map((p) => (
        <PeriodBlock key={p.id} p={p} />
      ))}
    </div>
  )
}

function PeriodBlock({ p }: { p: Period }) {
  const s = p.summary
  return (
    <section className="rounded-[22px] border border-line px-5 py-3">
      <h3 className="pb-1 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted">
        Periodo <Val field={p.period_start} format={date} /> – <Val field={p.period_end} format={date} />
      </h3>
      <dl>
        <Row label="Saldo inicial">
          <Val field={s.opening_balance} format={(v) => money(v)} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'opening_balance' }} label="el saldo inicial" />
        </Row>
        <Row label="Abonos">
          <Val field={s.total_credits} format={(v) => money(v)} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'total_credits' }} label="el total de abonos" />
        </Row>
        <Row label="Número de abonos">
          <Val field={s.credits_count} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'credits_count' }} label="el número de abonos" />
        </Row>
        <Row label="Cargos">
          <Val field={s.total_debits} format={(v) => money(v)} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'total_debits' }} label="el total de cargos" />
        </Row>
        <Row label="Número de cargos">
          <Val field={s.debits_count} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'debits_count' }} label="el número de cargos" />
        </Row>
        <Row label="Saldo final">
          <Val field={s.closing_balance} format={(v) => money(v)} className="tnum" target={{ kind: 'period', period_id: p.id, field: 'closing_balance' }} label="el saldo final" />
        </Row>
        <Row label="Saldo promedio">
          <Val field={s.average_balance} format={(v) => money(v)} className="tnum" />
        </Row>
        <Row label="Comisiones">
          <Val field={s.fees_charged} format={(v) => money(v)} className="tnum" />
        </Row>
        <Row label="Intereses">
          <Val field={s.interest_earned} format={(v) => money(v)} className="tnum" />
        </Row>
        <Row label="ISR retenido">
          <Val field={s.tax_withheld} format={(v) => money(v)} className="tnum" />
        </Row>
      </dl>
      <Reconciliation p={p} />
    </section>
  )
}

const RECON: Record<string, { label: string; tone: 'accent' | 'amber' | 'coral' | 'hatch' }> = {
  reconciled: { label: 'Cuadra', tone: 'accent' },
  partially_reconciled: { label: 'Cuadra en parte', tone: 'amber' },
  not_reconciled: { label: 'No cuadra', tone: 'coral' },
  not_checkable: { label: 'No se puede comprobar', tone: 'hatch' },
}

function Reconciliation({ p }: { p: Period }) {
  const r = p.reconciliation
  if (!r) return null
  const meta = RECON[r.status] ?? { label: r.status, tone: 'hatch' as const }
  const g = r.global
  return (
    <div className="mt-3 rounded-2xl bg-sunken p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium">Cuadre del periodo</p>
        <Chip tone={meta.tone} dot>
          {meta.label}
        </Chip>
      </div>
      {g ? (
        <p className="tnum mt-3 text-[13px] leading-relaxed text-ink-2">
          {money(g.opening_balance)} + {money(g.credits)} − {money(g.debits)} = <strong>{money(g.expected_closing)}</strong>
          <span className="text-muted"> · impreso {money(g.printed_closing)}</span>
          {!g.ok ? <span className="ml-1 font-medium text-coral-ink">(diferencia {money(g.difference)})</span> : null}
        </p>
      ) : (
        <p className="mt-2 text-[13px] text-muted">Falta saldo inicial o final impreso para cuadrar.</p>
      )}
      {r.running_balance ? (
        <p className="mt-2 text-[12.5px] text-muted">
          Saldo corrido: {r.running_balance.rows_checked} filas revisadas, {r.running_balance.breaks.length === 0 ? 'sin saltos' : r.running_balance.breaks.length === 1 ? 'deja de cuadrar en este movimiento:' : `deja de cuadrar en ${String(r.running_balance.breaks.length)} movimientos:`}
        </p>
      ) : null}
      <BalanceBreaks breaks={periodBreaks(p)} className="mt-2" />
    </div>
  )
}

function Transactions({ txs, bad }: { txs: FlatTx[]; bad: number }) {
  const focus = useFocus()
  const review = useReview()
  const [mode, setMode] = useState<'todos' | 'dudosos' | 'abonos' | 'cargos'>(bad > 0 ? 'dudosos' : 'todos')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(80)
  const needle = q.trim().toLowerCase()
  const rows = txs.filter(({ tx }) => {
    if (mode === 'dudosos' && tx.verification === 'verified') return false
    if (mode === 'abonos' && tx.type !== 'credit') return false
    if (mode === 'cargos' && tx.type !== 'debit') return false
    return !needle || tx.description.toLowerCase().includes(needle) || tx.reference?.toLowerCase().includes(needle) === true
  })
  const modes = [
    ['todos', `Todos ${String(txs.length)}`],
    ['dudosos', `Sin verificar ${String(bad)}`],
    ['abonos', 'Abonos'],
    ['cargos', 'Cargos'],
  ] as const
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        {modes.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={mode === k} onClick={() => { setMode(k); setLimit(80) }} className={clsx('h-8 rounded-full px-3.5 text-[12.5px] font-medium transition-colors', mode === k ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
            {l}
          </button>
        ))}
        <label className="relative ml-auto block min-w-32 flex-1 sm:max-w-44">
          <span className="sr-only">Buscar en la descripción</span>
          <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(80) }} placeholder="Buscar" className="h-8 w-full rounded-full border border-line bg-card pl-8 pr-3 text-[13px]" />
        </label>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="check" title={mode === 'dudosos' ? 'Ningún movimiento dudoso' : 'Sin movimientos'}>
          {mode === 'dudosos' ? 'Todos los movimientos quedaron verificados contra el documento.' : 'Prueba con otro filtro.'}
        </EmptyState>
      ) : (
        <ul className="-mx-2">
          {rows.slice(0, limit).map(({ tx }) => {
            const tone = tx.verification === 'verified' ? 'verified' : tx.verification
            return (
              <li key={tx.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { focus(tx.source, tone) }}
                  className={clsx('grid min-w-0 flex-1 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-2xl px-2.5 py-2.5 text-left transition-colors hover:bg-sunken', tx.verification === 'unverified' && 'hatch-amber', tx.verification === 'conflict' && 'hatch-coral')}
                >
                  <span className="min-w-0 truncate text-[13.5px] font-medium">{tx.description}</span>
                  <span className={clsx('tnum text-[13.5px] font-medium', tx.type === 'credit' && tx.verification === 'verified' && 'text-accent-ink')}>
                    {tx.type === 'credit' ? '+' : '−'}
                    {money(tx.amount)}
                  </span>
                  <span className="truncate text-[12px] text-muted">
                    {date(tx.date)} · p. {tx.source.page}
                    {tx.classification ? ` · ${CATEGORY_LABEL[tx.classification.category] ?? tx.classification.category}` : ''}
                    {tx.verification !== 'verified' ? ` · ${tx.verification === 'conflict' ? 'en conflicto' : 'sin verificar'}` : ''}
                  </span>
                  <span className="tnum text-right text-[12px] text-muted">{tx.balance === null ? '' : `saldo ${money(tx.balance)}`}</span>
                </button>
                {review.enabled ? (
                  <button
                    type="button"
                    className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-indigo-soft hover:text-indigo-ink"
                    aria-label={`Corregir el movimiento ${tx.description}`}
                    title="Corregir monto, sentido o fecha"
                    onClick={() => { review.edit({ target: { kind: 'transaction', transaction_id: tx.id, field: 'amount' }, label: `Movimiento «${tx.description.slice(0, 40)}»`, current: tx.amount, page: tx.source.page, snippet: tx.source.snippet, tx: { id: tx.id, amount: tx.amount, type: tx.type, date: tx.date } }) }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {rows.length > limit ? (
        <button type="button" className="mx-auto mt-3 block h-9 rounded-full bg-sunken px-5 text-[13px] font-medium hover:bg-line" onClick={() => { setLimit((l) => l + 120) }}>
          Mostrar más ({rows.length - limit})
        </button>
      ) : null}
    </div>
  )
}

function Fiscal({ x }: { x: StatementExtraction }) {
  if (x.fiscal_documents.length === 0) return <EmptyState icon="file" title="Sin CFDI en el documento">Este estado de cuenta no trae impreso el comprobante fiscal del banco.</EmptyState>
  return (
    <div className="space-y-4">
      {x.fiscal_documents.map((f) => (
        <section key={f.id} className="rounded-[22px] border border-line px-5 py-3">
          <h3 className="pb-1 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted">{f.kind === 'income' ? 'CFDI de ingreso' : f.kind === 'withholding' ? 'Constancia de retenciones' : 'Comprobante'}</h3>
          <dl>
            <Row label="Folio fiscal">
              <Val field={f.uuid} className="break-all font-mono text-[12px]" />
            </Row>
            <Row label="Emisor">
              <Val field={f.issuer.name} />
            </Row>
            <Row label="Receptor">
              <Val field={f.receiver.name} />
            </Row>
            <Row label="RFC receptor">
              <Val field={f.receiver.rfc} className="font-mono text-[13px]" />
            </Row>
            <Row label="Régimen del receptor">
              <Val field={f.receiver.tax_regime} />
            </Row>
            <Row label="Subtotal">
              <Val field={f.subtotal} format={(v) => money(v)} className="tnum" />
            </Row>
            <Row label="IVA">
              <Val field={f.tax} format={(v) => money(v)} className="tnum" />
            </Row>
            <Row label="Total">
              <Val field={f.total} format={(v) => money(v)} className="tnum" />
            </Row>
          </dl>
          <p className="mt-2 flex flex-wrap gap-1.5 pb-1">
            <Chip tone={f.seals.issuer_present && f.seals.sat_present ? 'accent' : 'amber'} icon={f.seals.issuer_present && f.seals.sat_present ? 'check' : 'alert'}>
              Sellos {f.seals.issuer_present && f.seals.sat_present ? 'presentes' : 'incompletos'}
            </Chip>
            {f.seals.looks_truncated ? <Chip tone="amber">Se ven cortados</Chip> : null}
          </p>
        </section>
      ))}
    </div>
  )
}

function Alerts({ issues }: { issues: Issue[] }) {
  const focus = useFocus()
  if (issues.length === 0) return <EmptyState icon="check" title="Sin alertas">La verificación no encontró nada que reportar.</EmptyState>
  const order = { error: 0, warning: 1, info: 2 } as const
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity])
  return (
    <ul className="space-y-2">
      {sorted.map((i) => (
        <li key={i.id} className={clsx('rounded-[20px] p-4', i.severity === 'error' ? 'bg-coral-soft' : i.severity === 'warning' ? 'bg-amber-soft' : 'bg-sunken')}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={i.severity === 'error' ? 'coral' : i.severity === 'warning' ? 'amber' : 'plain'} className="bg-white/60">
              {ISSUE_SEVERITY_LABEL[i.severity]}
            </Chip>
            <code className="font-mono text-[11.5px] text-muted">{i.code}</code>
            {i.page ? (
              <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1 text-[12px] font-medium hover:bg-white" onClick={() => { focus({ page: i.page ?? 1, snippet: null }, 'verified') }}>
                Ver p. {i.page} <Icon name="arrow" size={12} />
              </button>
            ) : null}
          </div>
          <p className="mt-2 text-[13.5px] leading-snug">{i.message}</p>
          {Object.keys(i.details).length > 0 ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
              {Object.entries(i.details).slice(0, 8).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="min-w-0 break-words">{typeof v === 'number' ? number(v) : typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
