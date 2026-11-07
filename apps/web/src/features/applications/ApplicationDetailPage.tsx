import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { describeFailure, DISCARD_REASON_LABELS, DiscardReason } from '@gow/contracts'
import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { date, money } from '../../lib/format'
import { api, ApiError, documentUrl } from '../../lib/api'
import { useApplication } from '../../lib/queries'
import { ClarificationCard } from '../clarifications/ClarificationCard'
import { Icon } from '../../ui/icons'
import { Button, Card, ErrorState, Modal, Skeleton, StatusChip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { CorrectionModal } from './CorrectionModal'
import { DecisionPanel } from './DecisionPanel'
import { alertPages, ExtractionPanel, type ExtractionTab } from './Extraction'
import { FocusCtx, ReviewCtx, targetKey, type EditSpec, type FocusFn, type PendingFix, type ReviewApi } from './focus'
import type { PdfFocus } from './PdfViewer'

// pdf.js pesa más que todo el resto de la app: se descarga solo al abrir una solicitud.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })))

type Panel = 'documento' | 'extraccion' | 'decision'
const PANELS: { key: Panel; label: string }[] = [
  { key: 'documento', label: 'Documento' },
  { key: 'extraccion', label: 'Extracción' },
  { key: 'decision', label: 'Decisión' },
]

export function ApplicationDetailPage() {
  const { id } = useParams({ from: '/shell/solicitudes/$id' })
  const { tab = 'resumen', pag } = useSearch({ from: '/shell/solicitudes/$id' })
  const navigate = useNavigate({ from: '/solicitudes/$id' })
  const { data, isPending, isError, error, refetch } = useApplication(id)
  const [panel, setPanel] = useState<Panel>('extraccion')
  const [answering, setAnswering] = useState(false)
  const [focus, setFocus] = useState<PdfFocus>({ page: pag ?? 1, snippet: null, tone: 'verified', nonce: 0 })

  const goTo: FocusFn = useCallback(
    (target, tone) => {
      if (!target) return
      setFocus((f) => ({ page: target.page, snippet: target.snippet, tone, nonce: f.nonce + 1 }))
      setPanel('documento')
    },
    [],
  )
  const [pending, setPending] = useState<PendingFix[]>([])
  const [editing, setEditing] = useState<EditSpec | null>(null)
  const toast = useToast()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.correct(id, pending.map((p) => ({ target: p.target, value: p.value, page: p.page }))),
    onSuccess: () => {
      toast.ok('Correcciones guardadas. Se reevalúa la solicitud.')
      setPending([])
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => { toast.error(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'No se pudieron guardar las correcciones') },
  })
  const [discardReason, setDiscardReason] = useState<DiscardReason | ''>('')
  const discard = useMutation({
    mutationFn: (reason: DiscardReason) => api.discard(id, reason),
    onSuccess: () => {
      toast.ok('Documento descartado. La solicitud cerró en no califica.')
      setDiscardReason('')
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => { toast.error(e instanceof ApiError ? e.message : 'No se pudo descartar el documento') },
  })
  const review: ReviewApi = useMemo(
    () => ({
      enabled: data?.status === 'human_review',
      pending,
      edit: (spec) => {
        setEditing(spec)
        if (spec.page) goTo({ page: spec.page, snippet: spec.snippet }, 'unverified')
      },
    }),
    [data?.status, pending, goTo],
  )
  const pages = useMemo(() => (data?.extraction ? alertPages(data.extraction) : new Set<number>()), [data?.extraction])
  const doc = data?.documents[0]
  const open = data?.clarifications.filter((c) => c.status === 'open') ?? []

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
        <Skeleton className="h-14 w-96" />
        <div className="mt-6 grid gap-4 xl:grid-cols-[1fr_1.15fr_0.95fr]">
          <Skeleton className="h-[70dvh] rounded-[28px]" />
          <Skeleton className="h-[70dvh] rounded-[28px]" />
          <Skeleton className="h-[70dvh] rounded-[28px]" />
        </div>
      </div>
    )
  }

  const x = data.extraction
  const h = 'xl:h-[calc(100dvh-215px)] xl:min-h-[520px]'

  return (
    <div>
      <div className="pb-5 pt-2">
        <Link to="/" className="inline-flex items-center gap-1.5 rounded-full py-1 pr-3 text-[13.5px] font-medium text-muted hover:text-ink">
          <Icon name="left" size={15} /> Solicitudes
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="display text-[clamp(30px,4.2vw,46px)]">
              <Link to="/proveedores/$id" params={{ id: data.supplier.id }} className="rounded-xl decoration-2 underline-offset-[6px] hover:underline">
                {data.supplier.legal_name}
              </Link>
            </h1>
            <p className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13.5px] text-muted">
              <StatusChip status={data.status} />
              <span>{x?.bank_name.value ?? 'Banco sin identificar'}</span>
              <span aria-hidden="true">·</span>
              <span>Solicitado {money(data.request?.amount)}</span>
              {data.request?.maturity ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>vence {date(data.request.maturity)}</span>
                </>
              ) : null}
              {data.request?.buyer ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>comprador {data.request.buyer.name}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/solicitudes/$id/recorrido" params={{ id: data.id }} className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[13.5px] font-medium hover:bg-sunken">
              <Icon name="clock" size={14} /> Ver recorrido
            </Link>
            {/* Prompts y respuestas tal cual de esta solicitud (ADR 0064). */}
            <Link to="/configuracion/bitacora" search={{ tab: 'modelo', solicitud: data.id }} className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[13.5px] font-medium hover:bg-sunken">
              <Icon name="bolt" size={14} /> Llamadas al modelo
            </Link>
            {doc ? (
              <a href={documentUrl(doc.id)} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[13.5px] font-medium hover:bg-sunken">
                Abrir PDF <Icon name="arrow" size={14} />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div role="tablist" aria-label="Panel visible" className="mb-3 flex gap-1.5 xl:hidden">
        {PANELS.map((p) => (
          <button key={p.key} role="tab" type="button" aria-selected={panel === p.key} onClick={() => { setPanel(p.key) }} className={clsx('h-10 flex-1 rounded-full text-[14px] font-medium transition-colors', panel === p.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2')}>
            {p.label}
          </button>
        ))}
      </div>

      <FocusCtx.Provider value={goTo}>
        <ReviewCtx.Provider value={review}>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]">
          <Card rise={0} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'documento' && 'hidden xl:block')}>
            {doc ? (
              <Suspense fallback={<Skeleton className="m-4 h-[70%]" />}>
              <PdfViewer
                documentId={doc.id}
                focus={focus}
                alertPages={pages}
                onPage={(p) => {
                  setFocus((f) => ({ ...f, page: p, snippet: null, nonce: f.nonce + 1 }))
                  void navigate({ search: (s: { tab?: string; pag?: number }) => ({ ...s, pag: p }), replace: true })
                }}
              />
              </Suspense>
            ) : (
              <p className="p-6 text-[14px] text-muted">Esta solicitud no tiene un documento PDF.</p>
            )}
          </Card>

          <Card rise={1} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'extraccion' && 'hidden xl:block')}>
            {x ? (
              <ExtractionPanel
                x={x}
                tab={(['resumen', 'movimientos', 'fiscal', 'alertas'] as const).includes(tab as ExtractionTab) ? (tab as ExtractionTab) : 'resumen'}
                onTab={(t) => { void navigate({ search: (s: { tab?: string; pag?: number }) => ({ ...s, tab: t }), replace: true }) }}
              />
            ) : (
              <div className="p-6">
                <h2 className="text-[17px] font-medium tracking-tight">Extracción</h2>
                <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">{data.status === 'failed' ? describeFailure(data.failure_reason).label : 'El documento se está leyendo. Esta pantalla se actualiza sola.'}</div>
              </div>
            )}
          </Card>

          <Card rise={2} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'decision' && 'hidden xl:block')}>
            <DecisionPanel
              detail={data}
              onAnswer={() => { setAnswering(true) }}
              tray={
                review.enabled ? (
                  <div className="mt-4 rounded-[24px] bg-amber-soft p-5">
                    <p className="flex items-center gap-2 text-[14px] font-medium text-amber-ink">
                      <Icon name="edit" size={16} /> {pending.length === 0 ? 'Revisa el documento' : pending.length === 1 ? '1 corrección por guardar' : `${String(pending.length)} correcciones por guardar`}
                    </p>
                    {pending.length === 0 ? (
                      <p className="mt-1 text-[13px] leading-snug text-amber-ink/85">Si la extracción leyó mal algo, toca el lápiz junto al valor y escribe lo correcto con el PDF al lado. Al guardar, el motor decide de nuevo con tus correcciones.</p>
                    ) : (
                      <>
                        <ul className="mt-3 space-y-2">
                          {pending.map((p) => (
                            <li key={targetKey(p.target)} className="flex items-start gap-2 rounded-2xl bg-white/70 px-3.5 py-2.5 text-[13px]">
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{p.label}</span>
                                <span className="tnum text-muted">
                                  <span className="line-through">{p.read === null ? 'sin dato' : String(p.read)}</span> → <span className="font-medium text-ink">{String(p.value)}</span>
                                </span>
                              </span>
                              <button type="button" aria-label={`Quitar la corrección de ${p.label}`} className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-amber-soft" onClick={() => { setPending((x) => x.filter((y) => targetKey(y.target) !== targetKey(p.target))) }}>
                                <Icon name="x" size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                        <Button className="mt-3 w-full" variant="primary" size="sm" disabled={save.isPending} onClick={() => { save.mutate() }}>
                          {save.isPending ? 'Guardando…' : 'Guardar y reevaluar'}
                        </Button>
                      </>
                    )}
                    {pending.length === 0 ? (
                      <div className="mt-4 border-t border-amber-ink/15 pt-3">
                        <label htmlFor="discard-reason" className="text-[13px] font-medium text-amber-ink">O descarta el documento si no sirve para decidir</label>
                        <div className="mt-2 flex gap-2">
                          <select id="discard-reason" className="min-w-0 flex-1 rounded-full bg-white/80 px-3 py-1.5 text-[13px]" value={discardReason} onChange={(e) => { setDiscardReason(e.target.value as DiscardReason | '') }}>
                            <option value="">Elige el motivo…</option>
                            {DiscardReason.options.map((r) => <option key={r} value={r}>{DISCARD_REASON_LABELS[r]}</option>)}
                          </select>
                          <Button variant="danger" size="sm" disabled={discardReason === '' || discard.isPending} onClick={() => { if (discardReason !== '') discard.mutate(discardReason) }}>
                            {discard.isPending ? 'Descartando…' : 'Descartar'}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null
              }
            />
          </Card>
        </div>
        </ReviewCtx.Provider>
      </FocusCtx.Provider>

      <CorrectionModal
        spec={editing}
        onClose={() => { setEditing(null) }}
        onAdd={(fixes) => {
          setPending((x) => [...x.filter((p) => !fixes.some((f) => targetKey(f.target) === targetKey(p.target))), ...fixes])
        }}
      />

      <Modal open={answering && open.length > 0} onClose={() => { setAnswering(false) }} title="Responder a nombre del proveedor" wide>
        {open[0] ? <ClarificationCard item={open[0]} showSupplier={false} /> : null}
      </Modal>
    </div>
  )
}
