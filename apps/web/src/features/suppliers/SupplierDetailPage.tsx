import type { SupplierApplicationItem, SupplierContactItem, SupplierDetail } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { CHANNEL_LABEL, date, money, OUTCOME_LABEL } from '../../lib/format'
import { useSupplier } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, Modal, SegmentBar, Skeleton, StatusChip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { StatementUpload } from './StatementUpload'
import { SupplierFormModal } from './SupplierForm'

const OUTCOME_TONE = { paid: 'accent', late: 'amber', default: 'coral', fraud: 'coral' } as const

/** One supplier: its data, verified contacts and everything it has requested. Opening it is logged. */
export function SupplierDetailPage() {
  const { id } = useParams({ from: '/shell/proveedores/$id' })
  const { data, isPending, isError, error, refetch } = useSupplier(id)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setEditing(true) }}>
              <Icon name="edit" size={16} /> Editar
            </Button>
            <Button variant="danger" onClick={() => { setDeleting(true) }}>
              <Icon name="trash" size={16} /> Borrar
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <StatementUpload supplier={data} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="space-y-4">
          <Card rise={0} className="pb-5">
            <CardHeader title="Datos" subtitle="Se usan para cotejar al titular del estado de cuenta" />
            <dl className="mt-4 space-y-3 px-6 text-[14px]">
              <Item label="RFC">{data.rfc ? <span className="font-mono">{data.rfc}</span> : <span className="text-muted">Sin RFC</span>}</Item>
              <Item label="Domicilio">{data.address ?? <span className="text-muted">Su estado de cuenta no lo trae</span>}</Item>
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
                { value: outcomes.filter((o) => o.outcome === 'paid').length, className: 'bg-accent', label: OUTCOME_LABEL.paid },
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
            <EmptyState title="Aún no ha pedido nada">Sube su estado de cuenta arriba, o cuando llegue por WhatsApp o la API aparecerá aquí con su decisión.</EmptyState>
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
      <DeleteSupplierModal open={deleting} onClose={() => { setDeleting(false) }} supplier={data} />
    </div>
  )
}

const IN_PROGRESS = new Set<SupplierApplicationItem['status']>(['received', 'extracting', 'extracted', 'deciding'])

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

/**
 * Delete the supplier with everything it owns. Says what will go using what the page already
 * shows; refused while a request is in progress (the API also answers 409).
 */
function DeleteSupplierModal({ open, onClose, supplier }: { open: boolean; onClose: () => void; supplier: SupplierDetail }) {
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const apps = supplier.applications
  const outcomes = apps.reduce((n, a) => n + a.outcomes.length, 0)
  const busy = apps.some((a) => IN_PROGRESS.has(a.status))
  const remove = useMutation({
    mutationFn: () => api.deleteSupplier(supplier.id),
    onSuccess: (r) => {
      toast.ok(`Proveedor borrado con ${plural(r.counts.applications, 'solicitud', 'solicitudes')} y ${plural(r.counts.documents, 'documento', 'documentos')}`)
      onClose()
      qc.removeQueries({ queryKey: ['supplier', supplier.id] })
      for (const key of ['suppliers', 'applications', 'clarifications', 'audit']) void qc.invalidateQueries({ queryKey: [key] })
      void navigate({ to: '/proveedores' })
    },
    onError: (e: unknown) => { toast.error(e instanceof ApiError ? e.message : 'No se pudo borrar') },
  })
  return (
    <Modal open={open} onClose={onClose} title="Borrar proveedor">
      <div className="space-y-3 text-[14px] leading-relaxed text-ink-2">
        <p>
          Se borra <span className="font-medium text-ink">{supplier.legal_name}</span> con todo lo suyo:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{plural(apps.length, 'solicitud', 'solicitudes')}, con sus estados de cuenta, extracciones y decisiones</li>
          <li>{outcomes ? `${plural(outcomes, 'resultado', 'resultados')} de crédito registrados` : 'Sus resultados de crédito, si hay'}</li>
          <li>Sus aclaraciones, su registro y los mensajes de WhatsApp o correo</li>
          <li>{plural(supplier.contacts.length, 'contacto', 'contactos')}: si vuelve a escribir, empieza desde cero</li>
        </ul>
        <p>No se puede deshacer. La bitácora conserva solo que se borró y cuántas cosas.</p>
        {busy ? <p className="hatch-amber rounded-2xl px-4 py-3 text-[13px] text-amber-ink">Tiene una solicitud en proceso. Espera a que termine para borrarlo.</p> : null}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="danger" disabled={busy || remove.isPending} onClick={() => { remove.mutate() }}>
          <Icon name="trash" size={15} /> {remove.isPending ? 'Borrando…' : 'Borrar todo'}
        </Button>
      </div>
    </Modal>
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
        <Chip tone="accent" dot>
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
