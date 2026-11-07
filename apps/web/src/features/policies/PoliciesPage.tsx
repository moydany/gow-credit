import { parsePolicy, type DecisionStatus, type SimulationReport, type PolicyVersionItem } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { dateTime, DECISION_LABEL, money, percent } from '../../lib/format'
import { useApplications, usePolicyVersions } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, Modal, SegmentBar, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { PageTitle } from '../applications/ApplicationsPage'

const STATUS_CHIP = { draft: ['Borrador', 'plain'], shadow: ['En sombra', 'indigo'], active: ['Activa', 'accent'], archived: ['Archivada', 'hatch'] } as const
const SEG: Record<DecisionStatus, string> = { qualified: 'bg-accent', qualified_with_limit: 'bg-accent-ink', not_qualified: 'bg-ink', needs_clarification: 'bg-indigo', human_review: 'bg-amber' }
const ORDER: DecisionStatus[] = ['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review']

export function PoliciesPage() {
  const { data, isPending, isError, error, refetch } = usePolicyVersions()
  const { v } = useSearch({ from: '/shell/configuracion/politicas' })
  const navigate = useNavigate({ from: '/configuracion/politicas' })
  const toast = useToast()
  const qc = useQueryClient()
  const selected = data?.find((x) => x.id === v) ?? data?.find((x) => x.status === 'active') ?? data?.[0]
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState<'activate' | null>(null)

  // The editor starts from the chosen version's document; editing doesn't change it (versions are immutable).
  useEffect(() => {
    if (selected) setText(JSON.stringify(selected.document, null, 2))
  }, [selected?.id])

  const check = useMemo(() => {
    try {
      const parsed = parsePolicy(JSON.parse(text))
      return parsed.ok ? ({ ok: true } as const) : ({ ok: false, errors: parsed.errors } as const)
    } catch (e) {
      return { ok: false, errors: [{ path: '', message: e instanceof Error ? `JSON inválido: ${e.message}` : 'JSON inválido' }] } as const
    }
  }, [text])
  const dirty = selected ? text !== JSON.stringify(selected.document, null, 2) : false

  const fail = (e: unknown) => { toast.error(e instanceof ApiError ? (e.issues[0] ? `${e.issues[0].path}: ${e.issues[0].message}` : e.message) : 'No se pudo completar') }
  const done = (msg: string) => () => {
    toast.ok(msg)
    void qc.invalidateQueries({ queryKey: ['policies'] })
  }
  const create = useMutation({
    mutationFn: () => api.createDraft(JSON.parse(text)),
    onSuccess: (r) => {
      done(`Borrador v${String(r.version)} guardado`)()
      void navigate({ search: { v: r.id } })
    },
    onError: fail,
  })
  const simulate = useMutation({ mutationFn: (id: string) => api.simulate(id), onSuccess: done('Simulación lista'), onError: fail })
  const shadow = useMutation({ mutationFn: (id: string) => api.shadow(id), onSuccess: done('La política corre en sombra: se evalúa y se registra sin decidir'), onError: fail })
  const activate = useMutation({
    mutationFn: (id: string) => api.activate(id),
    onSuccess: () => { setConfirm(null); done('Política activada')() },
    onError: fail,
  })

  return (
    <div>
      <PageTitle title="Políticas" muted={selected ? `v${String(selected.version)}` : undefined} />
      {isError ? (
        <Card>
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        </Card>
      ) : isPending ? (
        <Skeleton className="h-96 rounded-[28px]" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card rise={0} className="self-start pb-3">
            <CardHeader title="Versiones" subtitle="Borrador → simular → sombra → activa" />
            <ul className="mt-3 px-3">
              {data.map((x) => (
                <li key={x.id}>
                  <button type="button" aria-current={selected?.id === x.id} onClick={() => { void navigate({ search: { v: x.id } }) }} className={clsx('flex w-full items-center justify-between gap-3 rounded-3xl px-4 py-3.5 text-left transition-colors', selected?.id === x.id ? 'bg-sunken' : 'hover:bg-sunken/60')}>
                    <span>
                      <span className="block text-[15px] font-medium">Versión {x.version}</span>
                      <span className="mt-0.5 block text-[12.5px] text-muted">{x.activated_at ? `activada ${dateTime(x.activated_at)}` : dateTime(x.created_at)}</span>
                    </span>
                    <Chip tone={STATUS_CHIP[x.status][1]} dot>
                      {STATUS_CHIP[x.status][0]}
                    </Chip>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="min-w-0 space-y-4">
            <Card rise={1}>
              <CardHeader
                title={`Política v${String(selected?.version)}`}
                subtitle="Documento JSON validado con el mismo esquema que usa el motor"
                action={
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={!check.ok || !dirty || create.isPending} onClick={() => { create.mutate() }}>
                      Guardar como nueva versión
                    </Button>
                  </div>
                }
              />
              <div className="px-6 pb-2 pt-4">
                <label className="sr-only" htmlFor="policy-json">
                  Documento de la política en JSON
                </label>
                <textarea id="policy-json" spellCheck={false} value={text} onChange={(e) => { setText(e.target.value) }} className="input scroll-thin h-80 resize-y font-mono text-[12.5px] leading-relaxed" aria-invalid={!check.ok} aria-describedby="policy-status" />
                <div id="policy-status" className="mt-3" role="status">
                  {check.ok ? (
                    <p className="flex items-center gap-2 text-[13px] font-medium text-accent-ink">
                      <Icon name="check" size={15} /> Política válida{dirty ? ' · con cambios sin guardar' : ''}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {check.errors.slice(0, 4).map((e, i) => (
                        <li key={i} className="rounded-2xl bg-coral-soft px-3.5 py-2 text-[12.5px] text-coral-ink">
                          {e.path ? <code className="mr-1.5 font-mono font-medium">{e.path}</code> : null}
                          {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {selected ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-4">
                  <Button size="sm" variant="primary" disabled={simulate.isPending} onClick={() => { simulate.mutate(selected.id) }}>
                    <Icon name="flask" size={15} /> {simulate.isPending ? 'Simulando…' : 'Simular'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={selected.status === 'shadow' || selected.status === 'archived' || selected.status === 'active' || shadow.isPending} onClick={() => { shadow.mutate(selected.id) }}>
                    Activar en sombra
                  </Button>
                  <Button size="sm" variant="accent" disabled={selected.status === 'active' || selected.status === 'archived'} onClick={() => { setConfirm('activate') }}>
                    Promover a activa
                  </Button>
                  <p className="ml-auto text-[12px] text-muted">{selected.status === 'draft' ? 'Simula antes de promover.' : ''}</p>
                </div>
              ) : null}
            </Card>

            {selected?.simulation ? <SimulationView report={selected.simulation} /> : <SimulationEmpty />}
          </div>
        </div>
      )}

      <Modal open={confirm === 'activate'} onClose={() => { setConfirm(null) }} title={`Promover v${String(selected?.version)} a activa`}>
        <p className="text-[14.5px] leading-relaxed text-ink-2">
          Las solicitudes nuevas se decidirán con esta versión y la activa actual pasará a archivada. Las decisiones ya tomadas no cambian. Queda en la bitácora con tu usuario.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { setConfirm(null) }}>
            Cancelar
          </Button>
          <Button variant="accent" disabled={activate.isPending} onClick={() => { if (selected) activate.mutate(selected.id) }}>
            {activate.isPending ? 'Activando…' : 'Promover'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function SimulationEmpty() {
  return (
    <Card rise={2}>
      <EmptyState icon="flask" title="Aún no se ha simulado esta versión">
        Simular vuelve a decidir las solicitudes ya evaluadas con esta política y la compara con la activa, sin tocar nada.
      </EmptyState>
    </Card>
  )
}

function SimulationView({ report }: { report: NonNullable<PolicyVersionItem['simulation']> }) {
  const apps = useApplications()
  const name = (id: string) => apps.data?.find((a) => a.id === id)?.supplier.legal_name ?? id.slice(0, 8)
  const base = countBase(report)
  const t = report.transitions
  const changed = report.cases.filter((c) => c.baseline && c.baseline.status !== c.draft.status)
  return (
    <Card rise={2} className="pb-6">
      <CardHeader title="Simulación" subtitle={`${String(report.total)} solicitudes reevaluadas con la v${String(report.policy.version)}${report.baseline ? ` contra la v${String(report.baseline.version)} vigente` : ''}`} />
      <div className="space-y-6 px-6 pt-5">
        {t ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Mejoran" value={t.upgraded} tone="accent" />
            <Tile label="Empeoran" value={t.downgraded} tone="coral" />
            <Tile label="Sin cambio" value={t.unchanged} tone="plain" />
            <Tile label="Línea cambia" value={t.limit_increased + t.limit_decreased} tone="indigo" hint={`${String(t.limit_increased)} sube · ${String(t.limit_decreased)} baja`} />
          </div>
        ) : (
          <p className="rounded-2xl bg-sunken p-4 text-[13px] text-ink-2">No hay una política activa contra la cual comparar.</p>
        )}

        <div className="space-y-4">
          {base ? <Distribution title={`Vigente v${String(report.baseline?.version ?? '')}`} by={base} /> : null}
          <Distribution title={`Esta versión v${String(report.policy.version)}`} by={report.by_status} />
        </div>

        {report.outcomes.some((o) => o.with_outcome > 0) ? (
          <div>
            <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Mora observada con esta política</h3>
            <ul className="divide-y divide-line/70 text-[13.5px]">
              {report.outcomes.filter((o) => o.with_outcome > 0).map((o) => (
                <li key={o.status} className="flex items-center justify-between py-2">
                  <span>{DECISION_LABEL[o.status]}</span>
                  <span className="tnum text-muted">
                    {o.bad} de {o.with_outcome} con problema · <strong className="font-medium text-ink">{percent(o.bad_rate)}</strong>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Aún no hay outcomes registrados: la simulación no puede medir mora. Regístralos en Outcomes.</p>
        )}

        {changed.length > 0 ? (
          <div>
            <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">Solicitudes que cambian ({changed.length})</h3>
            <ul className="space-y-1.5">
              {changed.map((c) => (
                <li key={c.id} className="inner flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1 basis-44 truncate font-medium">{name(c.id)}</span>
                  <span className="flex items-center gap-1.5">
                    <Chip tone="plain">{c.baseline ? DECISION_LABEL[c.baseline.status] : '—'}</Chip>
                    <Icon name="right" size={12} />
                    <Chip tone="indigo">{DECISION_LABEL[c.draft.status]}</Chip>
                  </span>
                  {c.draft.limit !== null ? <span className="tnum text-muted">{money(c.draft.limit)}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function countBase(r: SimulationReport): Record<DecisionStatus, number> | null {
  if (!r.baseline) return null
  const out = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<DecisionStatus, number>
  for (const c of r.cases) if (c.baseline) out[c.baseline.status]++
  return out
}

function Tile({ label, value, tone, hint }: { label: string; value: number; tone: 'accent' | 'coral' | 'plain' | 'indigo'; hint?: string }) {
  return (
    <div className={clsx('rounded-[22px] p-4', tone === 'accent' && 'bg-accent-soft', tone === 'coral' && 'bg-coral-soft', tone === 'plain' && 'bg-sunken', tone === 'indigo' && 'bg-indigo-soft')}>
      <p className="text-[12.5px] text-ink-2">{label}</p>
      <p className="display tnum mt-2 text-[34px]">{value}</p>
      {hint ? <p className="mt-1 text-[11.5px] text-ink-2">{hint}</p> : null}
    </div>
  )
}

function Distribution({ title, by }: { title: string; by: Record<DecisionStatus, number> }) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium">{title}</p>
      <SegmentBar segments={ORDER.map((s) => ({ value: by[s], className: SEG[s], label: DECISION_LABEL[s] }))} />
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        {ORDER.filter((s) => by[s] > 0).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={clsx('size-2 rounded-full', SEG[s])} aria-hidden="true" />
            {DECISION_LABEL[s]} <span className="tnum font-medium text-ink-2">{by[s]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
