import { describeFailure, DOCUMENT_AGE_WARNING, type ApplicationRow, type ApplicationStatus } from '@gow/contracts'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { useMemo } from 'react'
import { approvalOf } from '../../lib/approval'
import { ago, money, number } from '../../lib/format'
import { useApplications, useMe } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { BigMoney, Card, CardHeader, Chip, EmptyState, ErrorState, Meter, SegmentBar, Skeleton, StatusChip } from '../../ui/primitives'

const FILTERS: { key: string; label: string; match: (s: ApplicationStatus) => boolean }[] = [
  { key: 'todas', label: 'Todas', match: () => true },
  { key: 'pendientes', label: 'Por decidir', match: (s) => s === 'needs_clarification' || s === 'human_review' },
  { key: 'calificadas', label: 'Calificadas', match: (s) => s === 'qualified' || s === 'qualified_with_limit' },
  { key: 'no-calificadas', label: 'No calificadas', match: (s) => s === 'not_qualified' },
  { key: 'proceso', label: 'En proceso', match: (s) => s === 'received' || s === 'extracting' || s === 'extracted' || s === 'deciding' },
  { key: 'fallidas', label: 'Fallidas', match: (s) => s === 'failed' },
]

export function PageTitle({ title, muted, children }: { title: string; muted?: string | undefined; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-6 pt-4">
      <h1 className="display text-[clamp(34px,5vw,52px)]">
        {title} {muted ? <span className="text-muted/70">{muted}</span> : null}
      </h1>
      {children}
    </div>
  )
}

export function ApplicationsPage() {
  const { data, isPending, isError, error, refetch } = useApplications()
  const me = useMe()
  const { estado = 'todas', q = '' } = useSearch({ from: '/shell/' })
  const navigate = useNavigate({ from: '/' })

  const stats = useMemo(() => {
    const rows = data ?? []
    const by = (f: (a: ApplicationRow) => boolean) => rows.filter(f).length
    const approved = rows.filter((a) => (a.status === 'qualified' || a.status === 'qualified_with_limit') && a.decision?.limit)
    return {
      total: rows.length,
      clarification: by((a) => a.status === 'needs_clarification'),
      review: by((a) => a.status === 'human_review'),
      // Lo aprobado de cada solicitud: el monto que pidió si cabe en la línea (ADR 0053).
      approvedAmount: approved.reduce((s, a) => s + (a.decision ? (approvalOf(a.decision, a.request?.amount)?.value ?? 0) : 0), 0),
      approvedCount: approved.length,
      qualified: by((a) => a.status === 'qualified' || a.status === 'qualified_with_limit'),
      rejected: by((a) => a.status === 'not_qualified' || a.status === 'failed'),
      busy: by((a) => ['received', 'extracting', 'extracted', 'deciding'].includes(a.status)),
    }
  }, [data])

  const filter = FILTERS.find((f) => f.key === estado) ?? FILTERS[0]
  const needle = q.trim().toLowerCase()
  const rows = (data ?? []).filter((a) => filter?.match(a.status) && (!needle || [a.supplier.legal_name, a.document?.bank, a.document?.file_name].some((t) => t?.toLowerCase().includes(needle))))

  return (
    <div>
      <PageTitle title="Solicitudes" muted={me.data?.tenant.name} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Card rise={0} className="col-span-2 xl:col-span-1">
          <div className="flex h-full flex-col justify-between gap-4 p-5 sm:gap-5 sm:p-6">
            <h2 className="text-[17px] font-medium tracking-tight">Solicitudes</h2>
            <div>
              {isPending ? <Skeleton className="h-12 w-28" /> : <p className="display tnum text-[40px] sm:text-[52px]">{stats.total}</p>}
              <p className="mt-2 text-[13px] text-muted">{stats.busy > 0 ? `${String(stats.busy)} procesándose ahora` : 'Todas con resultado'}</p>
            </div>
            <SegmentBar
              segments={[
                { value: stats.qualified, className: 'bg-accent', label: 'Calificadas' },
                { value: stats.clarification, className: 'bg-indigo', label: 'Aclaración' },
                { value: stats.review, className: 'bg-amber', label: 'Revisión' },
                { value: stats.rejected, className: 'bg-ink', label: 'No calificadas o fallidas' },
                { value: stats.busy, className: 'hatch', label: 'En proceso' },
              ]}
            />
          </div>
        </Card>

        <Card rise={1}>
          <div className="flex h-full flex-col justify-between gap-4 p-5 sm:gap-5 sm:p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] font-medium tracking-tight">Piden aclaración</h2>
              <Link to="/aclaraciones" className="grid size-9 place-items-center rounded-full border border-line hover:bg-sunken" aria-label="Ir a Aclaraciones">
                <Icon name="right" size={16} />
              </Link>
            </div>
            <div>
              {isPending ? <Skeleton className="h-12 w-20" /> : <p className="display tnum text-[40px] sm:text-[52px]">{stats.clarification}</p>}
              <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted">
                <Icon name="chat" size={14} /> {me.data?.tenant.whatsapp_linked_number ? 'Se preguntan por WhatsApp o correo' : 'Sin WhatsApp: respondes desde aquí'}
              </p>
            </div>
          </div>
        </Card>

        <Card rise={2}>
          <div className="flex h-full flex-col justify-between gap-4 p-5 sm:gap-5 sm:p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] font-medium tracking-tight">Revisión humana</h2>
              <Link to="/revision" className="grid size-9 place-items-center rounded-full border border-line hover:bg-sunken" aria-label="Ir a Revisión">
                <Icon name="right" size={16} />
              </Link>
            </div>
            <div>
              {isPending ? <Skeleton className="h-12 w-20" /> : <p className="display tnum text-[40px] sm:text-[52px]">{stats.review}</p>}
              <p className="mt-2 text-[13px] text-muted">Un analista decide qué sigue</p>
            </div>
          </div>
        </Card>

        <Card rise={3}>
          <div className="flex h-full flex-col justify-between gap-4 p-5 sm:gap-5 sm:p-6">
            <h2 className="text-[17px] font-medium tracking-tight">Monto aprobado</h2>
            <div>
              {isPending ? <Skeleton className="h-12 w-40" /> : <BigMoney value={stats.approvedCount ? stats.approvedAmount : null} className="text-[32px] sm:text-[44px] xl:text-[40px] 2xl:text-[46px]" />}
              <p className="mt-2 text-[13px] text-muted">{stats.approvedCount ? `En ${String(stats.approvedCount)} solicitud${stats.approvedCount === 1 ? '' : 'es'}` : 'Aún ninguna califica'}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="mt-4 pb-3" rise={4}>
        <CardHeader
          title="Bandeja"
          subtitle="Se actualiza sola mientras tienes la pestaña abierta"
          action={
            <label className="relative block w-full max-w-60">
              <span className="sr-only">Buscar por proveedor, banco o archivo</span>
              <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                defaultValue={q}
                placeholder="Buscar"
                className="h-10 w-full rounded-full border border-line bg-card pl-10 pr-4 text-[14px] placeholder:text-muted/80"
                onChange={(e) => {
                  void navigate({ search: (s: { estado?: string; q?: string }) => ({ ...s, q: e.target.value || undefined }), replace: true })
                }}
              />
            </label>
          }
        />
        <div className="scroll-thin flex gap-1.5 overflow-x-auto px-6 pb-4 pt-4" role="tablist" aria-label="Filtrar por estado">
          {FILTERS.map((f) => {
            const n = (data ?? []).filter((a) => f.match(a.status)).length
            const active = f.key === estado || (f.key === 'todas' && !FILTERS.some((x) => x.key === estado))
            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => {
                  void navigate({ search: (s: { estado?: string; q?: string }) => ({ ...s, estado: f.key === 'todas' ? undefined : f.key }) })
                }}
                className={clsx('inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition-colors', active ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
              >
                {f.label}
                <span className={clsx('tnum text-[12px]', active ? 'text-white/70' : 'text-muted')}>{n}</span>
              </button>
            )
          })}
        </div>

        <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_24px] gap-4 px-8 pb-2 text-[12px] font-medium uppercase tracking-wide text-muted lg:grid" aria-hidden="true">
          <span>Proveedor</span>
          <span>Estado</span>
          <span>Solicitado</span>
          <span>Línea y score</span>
          <span>Recibida</span>
          <span />
        </div>

        {isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : isPending ? (
          <div className="space-y-2 px-3 pb-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[74px] rounded-3xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={data.length === 0 ? 'Aún no hay solicitudes' : 'Nada con ese filtro'}>
            {data.length === 0 ? 'Cuando llegue un estado de cuenta por la API aparecerá aquí con su extracción y su decisión.' : 'Prueba con otro estado o borra la búsqueda.'}
          </EmptyState>
        ) : (
          <ul className="px-3" aria-label="Solicitudes">
            {rows.map((a, i) => (
              <li key={a.id} className="rise" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
                <Row a={a} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Row({ a }: { a: ApplicationRow }) {
  // Estado de cuenta más viejo que el ajuste del tenant (ADR 0049): se analizó, con advertencia.
  const oldStatement = a.decision?.reasons.some((r) => r.code === DOCUMENT_AGE_WARNING) ?? false
  const reason = a.status === 'failed' ? describeFailure(a.failure_reason).label : a.failure_reason?.startsWith('document_discarded:') ? 'Documento descartado por el analista' : a.decision?.reasons[0]?.message
  return (
    <Link
      to="/solicitudes/$id"
      params={{ id: a.id }}
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-3xl px-5 py-4 transition-colors hover:bg-sunken lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_24px]"
    >
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium">{a.supplier.legal_name}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">
          {a.document?.bank ?? 'Banco sin identificar'}
          {a.document?.page_count ? ` · ${String(a.document.page_count)} pág.` : ''}
          {a.document && a.document.issues > 0 ? ` · ${String(a.document.issues)} alertas` : ''}
        </p>
      </div>
      <div className="min-w-0 justify-self-end lg:justify-self-stretch">
        <StatusChip status={a.status} />
        {oldStatement ? (
          <Chip tone="amber" className="ml-1.5 align-middle" icon="alert">
            Estado antiguo
          </Chip>
        ) : null}
        {a.open_clarifications > 0 ? (
          <p className="mt-1.5 hidden truncate text-[12.5px] text-indigo-ink lg:block">{a.open_clarifications === 1 ? '1 pregunta abierta' : `${String(a.open_clarifications)} preguntas abiertas`}</p>
        ) : reason ? (
          <p className="mt-1.5 hidden truncate text-[12.5px] text-muted lg:block" title={reason}>
            {reason}
          </p>
        ) : null}
      </div>
      <p className="tnum text-[14.5px] lg:text-[15px]">
        <span className="mr-2 text-[12px] text-muted lg:hidden">Solicitado</span>
        {money(a.request?.amount)}
      </p>
      <div className="hidden min-w-0 lg:block">
        {a.decision && a.decision.limit !== null ? (
          <>
            <p className="tnum text-[15px] font-medium">{money(a.decision.limit)}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="w-full max-w-24">
                <Meter value={a.decision.score ?? 0} />
              </div>
              <span className="tnum text-[12px] text-muted">{number(a.decision.score)}</span>
            </div>
          </>
        ) : (
          <span className="text-[13px] text-muted">{a.decision?.status === 'not_qualified' && a.decision.score !== null ? `Score ${number(a.decision.score)}` : '—'}</span>
        )}
      </div>
      <p className="hidden text-[13.5px] text-muted lg:block">{ago(a.created_at)}</p>
      <Icon name="right" size={18} className="hidden text-muted transition-transform group-hover:translate-x-0.5 lg:block" />
    </Link>
  )
}
