import clsx from 'clsx'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { dateTime } from '../../lib/format'
import { useAudit } from '../../lib/queries'
import { Card, EmptyState, ErrorState, TableSkeleton } from '../../ui/primitives'
import { PageTitle } from '../applications/ApplicationsPage'
import { LlmExchanges } from './LlmExchanges'

const ACTION: Record<string, string> = {
  'application.viewed': 'Abrió una solicitud',
  'application.received': 'Recibió una solicitud',
  'application.success': 'Terminó de evaluar una solicitud',
  'application.suspended': 'Pausó una solicitud para aclarar',
  'application.failed': 'Falló al evaluar una solicitud',
  'clarification.opened': 'Abrió una aclaración',
  'clarification.answered': 'Respondió una aclaración',
  'policy.draft_created': 'Creó un borrador de política',
  'policy.simulated': 'Simuló una política',
  'policy.shadowed': 'Puso una política en sombra',
  'policy.activated': 'Activó una política',
  'prompt.version_created': 'Creó una versión de un prompt',
  'prompt.activated': 'Activó una versión de un prompt',
  'outcome.recorded': 'Registró un outcome',
  'supplier.created': 'Dio de alta un proveedor',
  'supplier.viewed': 'Abrió un proveedor',
  'supplier.updated': 'Editó un proveedor',
  'user.added': 'Invitó a un usuario',
  'user.removed': 'Quitó a un usuario',
  'api_key.created': 'Creó una llave de API',
  'api_key.revoked': 'Revocó una llave de API',
  'settings.updated': 'Cambió la antigüedad máxima del estado de cuenta',
  'correction.recorded': 'Corrigió valores de una extracción',
  'application.discarded': 'Descartó un documento',
  'contact.created': 'Agregó un contacto',
  'tenant.created': 'Se creó el tenant',
  'supplier.deleted': 'Borró un proveedor',
  'whatsapp.qr_viewed': 'Vio el QR de WhatsApp',
  'whatsapp.unlink_requested': 'Pidió desvincular WhatsApp',
  'llm_exchange.viewed': 'Vio una llamada al modelo',
}

function who(actor: string, label: string | null): { name: string; kind: string } {
  if (label) return { name: label, kind: 'Usuario' }
  if (actor.startsWith('api:')) return { name: actor.slice(4), kind: 'Llave de API' }
  if (actor === 'worker') return { name: 'Sistema', kind: 'Worker' }
  return { name: actor, kind: '' }
}

const TABS = [
  { key: 'movimientos', label: 'Movimientos' },
  { key: 'modelo', label: 'Llamadas al modelo' },
] as const

export function AuditPage() {
  const { tab = 'movimientos' } = useSearch({ from: '/shell/configuracion/bitacora' })
  const navigate = useNavigate({ from: '/configuracion/bitacora' })
  const current = tab === 'modelo' ? 'modelo' : 'movimientos'
  return (
    <div>
      <PageTitle title="Bitácora" muted="solo lectura" />
      <div role="tablist" aria-label="Qué ver" className="mb-4 flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={current === t.key}
            // Switching tabs clears the other tab's filters.
            onClick={() => void navigate({ search: { tab: t.key === 'movimientos' ? undefined : t.key } })}
            className={clsx('inline-flex h-10 items-center rounded-full px-5 text-[14px] font-medium transition-colors', current === t.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{current === 'modelo' ? <LlmExchanges /> : <Movements />}</div>
    </div>
  )
}

function Movements() {
  const { data, isPending, isError, error, refetch } = useAudit()
  return (
      <Card rise={0} className="overflow-hidden pb-2">
        {isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : isPending ? (
          <TableSkeleton />
        ) : data.length === 0 ? (
          <EmptyState icon="list" title="Sin movimientos">Aquí queda quién hizo qué.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <caption className="sr-only">Últimos 200 movimientos del tenant</caption>
              <thead>
                <tr className="text-[12px] uppercase tracking-wide text-muted">
                  <th scope="col" className="px-7 py-4 font-medium">Cuándo</th>
                  <th scope="col" className="px-3 py-4 font-medium">Quién</th>
                  <th scope="col" className="px-3 py-4 font-medium">Qué</th>
                  <th scope="col" className="px-7 py-4 font-medium">Sobre</th>
                </tr>
              </thead>
              <tbody>
                {data.map((e) => {
                  const w = who(e.actor, e.actor_label)
                  return (
                    <tr key={e.id} className="border-t border-line/70 transition-colors hover:bg-sunken/60">
                      <td className="tnum whitespace-nowrap px-7 py-3 text-muted">{dateTime(e.at)}</td>
                      <td className="px-3 py-3">
                        <span className="font-medium">{w.name}</span>
                        {w.kind ? <span className="ml-2 text-[12px] text-muted">{w.kind}</span> : null}
                      </td>
                      <td className="px-3 py-3">{ACTION[e.action] ?? e.action}</td>
                      <td className="px-7 py-3 font-mono text-[12px] text-muted">{e.subject ? e.subject.slice(0, 8) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
  )
}
