import type { SupplierApplicationItem, SupplierContactItem } from '@gow/contracts'
import { Link, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { CHANNEL_LABEL, date, money, OUTCOME_LABEL } from '../../lib/format'
import { useSupplier } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, SegmentBar, Skeleton, StatusChip } from '../../ui/primitives'
import { SupplierFormModal } from './SupplierForm'

const OUTCOME_TONE = { paid: 'lime', late: 'amber', default: 'coral', fraud: 'coral' } as const

/** Un proveedor (docs/08 §2): sus datos, sus contactos verificados y todo lo que ha pedido. Abrirlo queda en la bitácora. */
export function SupplierDetailPage() {
  const { id } = useParams({ from: '/shell/proveedores/$id' })
  const { data, isPending, isError, error, refetch } = useSupplier(id)
  const [editing, setEditing] = useState(false)

  if (isError) {
    return (
      <Card className="mt-6">
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Card>
    )
  }
  if (isPending) {
    return (
      <div className="pt-4">
        <Skeleton className="h-12 w-80" />
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <Skeleton className="h-80 rounded-[28px]" />
          <Skeleton className="h-80 rounded-[28px]" />
        </div>
      </div>
    )
  }

  const apps = data.applications
  const outcomes = apps.flatMap((a) => a.outcomes.slice(0, 1))
  const funded = apps.filter((a) => a.status === 'qualified' || a.status === 'qualified_with_limit').length

  return (
    <div>
      <div className="pb-5 pt-2">
        <Link to="/proveedores" className="inline-flex items-center gap-1.5 rounded-full py-1 pr-3 text-[13.5px] font-medium text-muted hover:text-ink">
          <Icon name="left" size={15} /> Proveedores
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="display text-[clamp(30px,4.2vw,46px)]">{data.legal_name}</h1>
            <p className="mt-2.5 text-[13.5px] text-muted">
              Alta {date(data.created_at)} · {apps.length === 1 ? '1 solicitud' : `${String(apps.length)} solicitudes`}
            </p>
          </div>
          <Button variant="ghost" onClick={() => { setEditing(true) }}>
            <Icon name="edit" size={16} /> Editar
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="space-y-4">
          <Card rise={0} className="pb-5">
            <CardHeader title="Datos" subtitle="Se usan para cotejar al titular del estado de cuenta" />
            <dl className="mt-4 space-y-3 px-6 text-[14px]">
              <Item label="RFC">{data.rfc ? <span className="font-mono">{data.rfc}</span> : <span className="text-muted">Sin RFC</span>}</Item>
              <Item label="Referencia externa">{data.external_ref ? <span className="font-mono">{data.external_ref}</span> : <span className="text-muted">Sin referencia</span>}</Item>
              <Item label="CLABEs">
                {data.clabes.length ? (
                  <ul className="space-y-1">
                    {data.clabes.map((c) => (
                      <li key={c} className="tnum font-mono">
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted">Ninguna registrada</span>
                )}
              </Item>
            </dl>
          </Card>

          <Card rise={1} className="pb-4">
            <CardHeader title="Contactos" subtitle="Solo a uno verificado se le pregunta y solo de él se aceptan respuestas" />
            {data.contacts.length === 0 ? (
              <EmptyState icon="chat" title="Sin contactos">Las aclaraciones de este proveedor las respondes tú desde Aclaraciones.</EmptyState>
            ) : (
              <ul className="mt-3 px-3">
                {data.contacts.map((c) => (
                  <li key={c.id} className="border-t border-line/70 first:border-0">
                    <Contact c={c} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card rise={2} className="p-6">
            <h2 className="text-[17px] font-medium tracking-tight">Outcomes</h2>
            <p className="display tnum mt-5 text-[44px]">{outcomes.length}</p>
            <p className="mt-2 text-[13px] text-muted">de {funded} {funded === 1 ? 'calificada' : 'calificadas'} con outcome registrado</p>
            <SegmentBar
              className="mt-5"
              segments={[
                { value: outcomes.filter((o) => o.outcome === 'paid').length, className: 'bg-lime', label: OUTCOME_LABEL.paid },
                { value: outcomes.filter((o) => o.outcome === 'late').length, className: 'bg-amber', label: OUTCOME_LABEL.late },
                { value: outcomes.filter((o) => o.outcome === 'default').length, className: 'bg-coral', label: OUTCOME_LABEL.default },
                { value: outcomes.filter((o) => o.outcome === 'fraud').length, className: 'bg-ink', label: OUTCOME_LABEL.fraud },
                { value: Math.max(0, funded - outcomes.length), className: 'hatch', label: 'Sin registrar' },
              ]}
            />
          </Card>
        </div>

        <Card rise={1} className="self-start pb-3">
          <CardHeader title="Solicitudes" subtitle="De la más reciente a la más antigua" />
          {apps.length === 0 ? (
            <EmptyState title="Aún no ha pedido nada">Cuando llegue un estado de cuenta de este proveedor aparecerá aquí con su decisión.</EmptyState>
          ) : (
            <ul className="mt-3 px-3" aria-label="Solicitudes del proveedor">
              {apps.map((a) => (
                <li key={a.id}>
                  <AppRow a={a} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SupplierFormModal open={editing} onClose={() => { setEditing(false) }} supplier={data} />
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function Contact({ c }: { c: SupplierContactItem }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sunken text-ink-2">
        <Icon name={c.channel === 'email' ? 'mail' : c.channel === 'whatsapp' ? 'phone' : 'user'} size={16} />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-mono text-[13.5px]">{c.address}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">{CHANNEL_LABEL[c.channel]}</p>
      </div>
      {c.verified_at ? (
        <Chip tone="lime" dot>
          Verificado{c.verification_method === 'kyc' ? ' por KYC' : ''} · {date(c.verified_at)}
        </Chip>
      ) : (
        <Chip tone="hatch" dot>
          Sin verificar
        </Chip>
      )}
    </div>
  )
}

function AppRow({ a }: { a: SupplierApplicationItem }) {
  const outcome = a.outcomes[0]
  return (
    <Link to="/solicitudes/$id" params={{ id: a.id }} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-3xl px-4 py-3.5 transition-colors hover:bg-sunken sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_20px]">
      <div className="min-w-0">
        <StatusChip status={a.status} />
        <p className="tnum mt-1.5 text-[12.5px] text-muted">Recibida {date(a.created_at)}</p>
      </div>
      <div className="tnum min-w-0 text-right text-[13.5px] sm:text-left">
        <p>
          <span className="text-muted">Solicitado </span>
          {money(a.request?.amount)}
        </p>
        <p className="mt-0.5">
          <span className="text-muted">Línea </span>
          {money(a.decision?.limit)}
        </p>
      </div>
      <div className="col-span-2 sm:col-span-1">
        {outcome ? (
          <Chip tone={OUTCOME_TONE[outcome.outcome]} dot>
            {OUTCOME_LABEL[outcome.outcome]} · {date(outcome.observed_at)}
          </Chip>
        ) : (
          <span className="text-[13px] text-muted">{a.status === 'qualified' || a.status === 'qualified_with_limit' ? 'Sin outcome' : '—'}</span>
        )}
      </div>
      <Icon name="right" size={18} className="hidden text-muted transition-transform group-hover:translate-x-0.5 sm:block" />
    </Link>
  )
}
