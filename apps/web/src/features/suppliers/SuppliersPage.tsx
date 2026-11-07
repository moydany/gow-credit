import type { SupplierRow } from '@gow/contracts'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { ago } from '../../lib/format'
import { useSuppliers } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, StatusChip } from '../../ui/primitives'
import { PageTitle } from '../applications/ApplicationsPage'
import { SupplierFormModal } from './SupplierForm'

const matchesSearch = (s: SupplierRow, needle: string) => !needle || [s.legal_name, s.rfc].some((t) => t?.toLowerCase().includes(needle))

function headerText(data: readonly SupplierRow[] | undefined) {
  if (!data) return { total: undefined, withApps: 'Cargando…' }
  const withApps = data.filter((s) => s.applications > 0).length
  return { total: `${String(data.length)} en total`, withApps: `${String(withApps)} con al menos una solicitud` }
}

/** The tenant's suppliers: how many requests each has and how the latest is going. */
export function SuppliersPage() {
  const { data, isPending, isError, error, refetch } = useSuppliers()
  const { q = '' } = useSearch({ from: '/shell/proveedores' })
  const navigate = useNavigate({ from: '/proveedores' })
  const [creating, setCreating] = useState(false)
  const needle = q.trim().toLowerCase()
  const rows = (data ?? []).filter((s) => matchesSearch(s, needle))
  const header = headerText(data)

  return (
    <div>
      <PageTitle title="Proveedores" muted={header.total}>
        <Button variant="accent" onClick={() => { setCreating(true) }}>
          <Icon name="plus" size={16} /> Dar de alta
        </Button>
      </PageTitle>

      <Card rise={0} className="pb-3">
        <CardHeader
          title="Todos"
          subtitle={header.withApps}
          action={
            <label className="relative block w-full max-w-60">
              <span className="sr-only">Buscar por razón social o RFC</span>
              <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                defaultValue={q}
                placeholder="Buscar"
                className="h-10 w-full rounded-full border border-line bg-card pl-10 pr-4 text-[14px] placeholder:text-muted/80"
                onChange={(e) => {
                  void navigate({ search: { q: e.target.value || undefined }, replace: true })
                }}
              />
            </label>
          }
        />

        <div className="mt-4 hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_24px] gap-4 px-8 pb-2 text-[12px] font-medium uppercase tracking-wide text-muted lg:grid" aria-hidden="true">
          <span>Proveedor</span>
          <span>RFC</span>
          <span>Solicitudes</span>
          <span>Última solicitud</span>
          <span />
        </div>

        {isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : isPending ? (
          <div className="space-y-2 px-3 pb-3 pt-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[70px] rounded-3xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="user" title={data.length === 0 ? 'Aún no hay proveedores' : 'Nadie con esa búsqueda'}>
            {data.length === 0 ? 'Llegan por la API de integración junto con su primera solicitud, o dalos de alta aquí.' : 'Prueba con otra razón social o RFC.'}
          </EmptyState>
        ) : (
          <ul className="px-3" aria-label="Proveedores">
            {rows.map((s, i) => (
              <li key={s.id} className="rise" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
                <Row s={s} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SupplierFormModal open={creating} onClose={() => { setCreating(false) }} onCreated={(id) => void navigate({ to: '/proveedores/$id', params: { id } })} />
    </div>
  )
}

function Row({ s }: { s: SupplierRow }) {
  return (
    <Link
      to="/proveedores/$id"
      params={{ id: s.id }}
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-3xl px-5 py-4 transition-colors hover:bg-sunken lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_24px]"
    >
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium">{s.legal_name}</p>
        {/* On small screens the RFC column is hidden: it goes under the name. */}
        <p className="mt-0.5 truncate font-mono text-[13px] text-muted lg:hidden">{s.rfc ?? <span className="font-sans">Sin RFC</span>}</p>
      </div>
      <p className="hidden truncate font-mono text-[13px] text-ink-2 lg:block">{s.rfc ?? <span className="font-sans text-muted">Sin RFC</span>}</p>
      <p className="tnum justify-self-end text-[14.5px] lg:justify-self-start">
        {s.applications}
        <span className="ml-1.5 text-[12px] text-muted lg:hidden">{s.applications === 1 ? 'solicitud' : 'solicitudes'}</span>
      </p>
      <div className="col-span-2 flex min-w-0 items-center gap-2.5 lg:col-span-1">
        {s.last_application ? (
          <>
            <StatusChip status={s.last_application.status} />
            <span className="truncate text-[13px] text-muted">{ago(s.last_application.created_at)}</span>
          </>
        ) : (
          <span className="text-[13px] text-muted">Ninguna todavía</span>
        )}
      </div>
      <Icon name="right" size={18} className="hidden text-muted transition-transform group-hover:translate-x-0.5 lg:block" />
    </Link>
  )
}
