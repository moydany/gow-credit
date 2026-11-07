import { useNavigate, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { ago } from '../../lib/format'
import { useClarifications, useMe } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Card, Chip, EmptyState, ErrorState, Skeleton } from '../../ui/primitives'
import { PageTitle } from '../applications/ApplicationsPage'
import { ClarificationCard } from './ClarificationCard'

type Clarification = NonNullable<ReturnType<typeof useClarifications>['data']>[number]

/** The clarifications shown under each tab. */
function listFor(ver: string, all: readonly Clarification[]): readonly Clarification[] {
  if (ver === 'todas') return all
  if (ver === 'respondidas') return all.filter((c) => c.status !== 'open')
  return all.filter((c) => c.status === 'open')
}

export function ClarificationsPage() {
  const { data, isPending, isError, error, refetch } = useClarifications()
  const me = useMe()
  const { id, ver = 'abiertas' } = useSearch({ from: '/shell/aclaraciones' })
  const navigate = useNavigate({ from: '/aclaraciones' })

  const all = data ?? []
  const open = all.filter((c) => c.status === 'open')
  const list = listFor(ver, all)
  const selected = list.find((c) => c.id === id) ?? list[0]
  const tabs = [
    ['abiertas', 'Abiertas', open.length],
    ['respondidas', 'Respondidas', all.length - open.length],
    ['todas', 'Todas', all.length],
  ] as const

  return (
    <div>
      <PageTitle title="Aclaraciones" muted={me.data?.tenant.whatsapp_linked_number ? undefined : 'sin WhatsApp'}>
        <p className="max-w-sm text-[13.5px] text-muted">Preguntas al proveedor cuando un dato dudoso puede cambiar el resultado. Sin un contacto verificado, las respondes tú.</p>
      </PageTitle>

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card rise={0} className="self-start pb-3">
          <div role="tablist" aria-label="Estado de las aclaraciones" className="scroll-thin flex gap-1.5 overflow-x-auto px-5 pb-3 pt-5">
            {tabs.map(([k, l, n]) => (
              <button key={k} role="tab" type="button" aria-selected={ver === k} onClick={() => { void navigate({ search: { ver: k === 'abiertas' ? undefined : k } }) }} className={clsx('inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition-colors', ver === k ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
                {l} <span className={clsx('tnum text-[12px]', ver === k ? 'text-white/70' : 'text-muted')}>{n}</span>
              </button>
            ))}
          </div>
          {isError ? (
            <ErrorState message={error.message} onRetry={() => void refetch()} />
          ) : isPending ? (
            <div className="space-y-2 px-3 pb-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-20 rounded-3xl" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <EmptyState icon="chat" title={ver === 'abiertas' ? 'Nada por contestar' : 'Sin aclaraciones'}>
              {ver === 'abiertas' ? 'Cuando una solicitud necesite un dato del proveedor, su pregunta aparece aquí.' : 'Todavía no hay aclaraciones en este grupo.'}
            </EmptyState>
          ) : (
            <ul className="px-3">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" aria-current={selected?.id === c.id} onClick={() => { void navigate({ search: (s: { id?: string; ver?: string }) => ({ ...s, id: c.id }) }) }} className={clsx('flex w-full flex-col gap-1.5 rounded-3xl px-4 py-3.5 text-left transition-colors', selected?.id === c.id ? 'bg-sunken' : 'hover:bg-sunken/60')}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14.5px] font-medium">{c.supplier_name}</span>
                      <span className="shrink-0 text-[12px] text-muted">{ago(c.created_at)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                      <Chip tone={c.status === 'open' ? 'indigo' : 'accent'} dot>
                        {c.status === 'open' ? 'Abierta' : 'Respondida'}
                      </Chip>
                      {c.questions.length === 1 ? '1 pregunta' : `${String(c.questions.length)} preguntas`}
                      {c.channel === 'manual' ? ' · manual' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="min-w-0">
          {selected ? (
            <div key={selected.id} className="rise">
              <ClarificationCard item={selected} />
            </div>
          ) : (
            <Card className="hidden xl:block">
              <EmptyState icon="chat" title="Elige una aclaración">
                Verás las preguntas con los datos del documento y podrás responder a nombre del proveedor.
              </EmptyState>
            </Card>
          )}
          {selected && selected.status === 'open' ? (
            <p className="mt-3 flex items-center gap-2 px-2 text-[12.5px] text-muted">
              <Icon name="shield" size={14} /> Tu respuesta queda en la bitácora con tu usuario, y la evaluación se reanuda con ella como dato del analista.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
