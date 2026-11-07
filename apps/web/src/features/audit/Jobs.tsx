/**
 * "Trabajos" tab of the audit log: the lender's queue jobs (pg-boss), with their state, attempts,
 * duration and the error of the last attempt. Refreshes every 5 s while something is queued or
 * running. The process logs stay in Railway or `pnpm stack:logs`: they mix lenders.
 */
import type { JobItem, JobListQuery, JobState } from '@gow/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { api } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { Card, Chip, EmptyState, ErrorState, TableSkeleton } from '../../ui/primitives'

/** What each queue does, in the analyst's words. */
const QUEUE_LABEL: Record<string, string> = {
  'application.process': 'Procesar estado de cuenta',
  'application.resume': 'Reanudar con respuestas',
  'application.redecide': 'Reevaluar',
  'application.discard_notice': 'Avisar el descarte',
  'supplier.purge': 'Borrar archivos del proveedor',
  'application.dead': 'Agotó los reintentos',
}

const STATE: Record<JobState, { label: string; tone: 'accent' | 'indigo' | 'amber' | 'coral' | 'plain' }> = {
  created: { label: 'En cola', tone: 'plain' },
  retry: { label: 'Por reintentar', tone: 'amber' },
  active: { label: 'En curso', tone: 'indigo' },
  completed: { label: 'Terminó', tone: 'accent' },
  cancelled: { label: 'Cancelado', tone: 'coral' },
  failed: { label: 'Falló', tone: 'coral' },
}

const FILTERS: { key: JobListQuery['state']; label: string }[] = [
  { key: undefined, label: 'Todos' },
  { key: 'running', label: 'En curso' },
  { key: 'failed', label: 'Con error' },
]

const RUNNING = new Set<JobState>(['created', 'retry', 'active'])

const EMPTY_TITLE = { all: 'Sin trabajos', failed: 'Sin trabajos con error', running: 'Nada en curso' } as const

/** From start to end, or until now if it is still running. */
function duration(j: JobItem): string {
  if (!j.started_at) return '—'
  const ms = (j.completed_at ? new Date(j.completed_at).getTime() : Date.now()) - new Date(j.started_at).getTime()
  if (ms < 0) return '—'
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms / 60_000))} min`
}

export function Jobs() {
  const search = useSearch({ from: '/shell/configuracion/bitacora' })
  const navigate = useNavigate({ from: '/configuracion/bitacora' })
  const state = search.resultado === 'failed' || search.resultado === 'running' ? search.resultado : undefined
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['jobs', state],
    queryFn: () => api.jobs(state ? { state } : {}),
    refetchInterval: (q) => (q.state.data?.some((j) => RUNNING.has(j.state)) ? 5000 : false),
  })

  return (
    <>
      <div role="group" aria-label="Estado" className="mb-3 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            aria-pressed={state === f.key}
            onClick={() => void navigate({ search: (s: Record<string, string | undefined>) => ({ ...s, resultado: f.key }), replace: true })}
            className={clsx('h-9 rounded-full px-4 text-[13.5px] font-medium transition-colors', state === f.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Card rise={0} className="overflow-hidden pb-2">
        {isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : isPending ? (
          <TableSkeleton />
        ) : data.length === 0 ? (
          <EmptyState icon="clock" title={EMPTY_TITLE[state ?? 'all']}>
            Cada estado de cuenta, reanudación o reevaluación pasa por la cola; aquí se ve cómo le fue.
          </EmptyState>
        ) : (
          <JobTable jobs={data} />
        )}
      </Card>
      <p className="mt-3 px-2 text-[12.5px] text-muted">Los trabajos terminados se borran de la cola después de unos días. Los registros de los procesos están en Railway o en <span className="font-mono">pnpm stack:logs</span>.</p>
    </>
  )
}

function JobTable({ jobs }: { jobs: JobItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-[13.5px]">
        <caption className="sr-only">Últimos trabajos de la cola</caption>
        <thead>
          <tr className="text-[12px] uppercase tracking-wide text-muted">
            <th scope="col" className="px-7 py-4 font-medium">Cuándo</th>
            <th scope="col" className="px-3 py-4 font-medium">Trabajo</th>
            <th scope="col" className="px-3 py-4 font-medium">Estado</th>
            <th scope="col" className="px-3 py-4 text-right font-medium">Intentos</th>
            <th scope="col" className="px-3 py-4 text-right font-medium">Duración</th>
            <th scope="col" className="px-3 py-4 font-medium">Sobre</th>
            <th scope="col" className="px-7 py-4 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t border-line/70 align-top">
              <td className="tnum whitespace-nowrap px-7 py-3 text-muted">{dateTime(j.created_at)}</td>
              <td className="px-3 py-3 font-medium">
                {QUEUE_LABEL[j.queue] ?? j.queue}
                {j.dead_letter_from ? <span className="mt-0.5 block text-[12px] font-normal text-muted">de {QUEUE_LABEL[j.dead_letter_from] ?? j.dead_letter_from}</span> : null}
              </td>
              <td className="px-3 py-3">
                <Chip tone={STATE[j.state].tone} dot>
                  {STATE[j.state].label}
                </Chip>
              </td>
              <td className="tnum px-3 py-3 text-right text-ink-2">
                {j.attempts} de {j.max_attempts}
              </td>
              <td className="tnum whitespace-nowrap px-3 py-3 text-right text-ink-2">{duration(j)}</td>
              <td className="px-3 py-3 font-mono text-[12px] text-muted">
                {j.application_id ? (
                  <Link to="/solicitudes/$id" params={{ id: j.application_id }} className="underline-offset-2 hover:underline">
                    {j.application_id.slice(0, 8)}
                  </Link>
                ) : j.supplier_id ? (
                  <Link to="/proveedores/$id" params={{ id: j.supplier_id }} className="underline-offset-2 hover:underline">
                    prov {j.supplier_id.slice(0, 8)}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td className="max-w-[340px] px-7 py-3 text-[12.5px] text-coral-ink">{j.error ?? <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
