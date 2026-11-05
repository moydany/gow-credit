import { Link } from '@tanstack/react-router'
import { ago, money } from '../../lib/format'
import { useApplications } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Card, CardHeader, Chip, EmptyState, ErrorState, Skeleton } from '../../ui/primitives'
import { PageTitle } from '../applications/ApplicationsPage'

/**
 * Cola de revisión humana (docs/08 §2). Hoy lista el motivo y abre la solicitud con el PDF al lado.
 * La corrección de un valor (par leído / correcto / página) que alimenta las evals y reencola a
 * `decide` queda pendiente: necesita un endpoint de decisión manual que aún no existe.
 */
export function ReviewPage() {
  const { data, isPending, isError, error, refetch } = useApplications()
  const rows = (data ?? []).filter((a) => a.status === 'human_review')
  return (
    <div>
      <PageTitle title="Revisión humana" muted={isPending ? undefined : String(rows.length)} />
      {isError ? (
        <Card>
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        </Card>
      ) : isPending ? (
        <Skeleton className="h-48 rounded-[28px]" />
      ) : rows.length === 0 ? (
        <Card rise={0}>
          <EmptyState icon="shield" title="Nada en revisión">
            Aquí llegan las solicitudes que el motor no quiere decidir solo: identidad dudosa, documento que no cuadra o una sospecha de manipulación.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((a, i) => (
            <Card key={a.id} rise={Math.min(i, 8)} className="pb-5">
              <CardHeader title={a.supplier.legal_name} subtitle={`${a.document?.bank ?? 'Banco sin identificar'} · ${money(a.request?.amount)} · ${ago(a.updated_at)}`} action={<Chip tone="amber" dot>Revisión humana</Chip>} />
              <div className="px-6 pt-4">
                <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Por qué llegó aquí</p>
                <ul className="mt-2 space-y-2">
                  {(a.decision?.reasons ?? []).slice(0, 4).map((r) => (
                    <li key={r.code} className="flex gap-2.5 text-[13.5px] leading-snug">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-amber" aria-hidden="true" />
                      {r.message}
                    </li>
                  ))}
                  {(a.decision?.reasons.length ?? 0) === 0 ? <li className="text-[13.5px] text-muted">El motor no dejó un motivo escrito.</li> : null}
                </ul>
                <Link to="/solicitudes/$id" params={{ id: a.id }} className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-[14px] font-medium text-white hover:bg-ink-2">
                  Abrir con el PDF <Icon name="arrow" size={14} />
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
