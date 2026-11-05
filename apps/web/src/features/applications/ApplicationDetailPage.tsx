import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { date, money } from '../../lib/format'
import { documentUrl } from '../../lib/api'
import { useApplication } from '../../lib/queries'
import { ClarificationCard } from '../clarifications/ClarificationCard'
import { Icon } from '../../ui/icons'
import { Card, ErrorState, Modal, Skeleton, StatusChip } from '../../ui/primitives'
import { DecisionPanel } from './DecisionPanel'
import { alertPages, ExtractionPanel, type ExtractionTab } from './Extraction'
import { FocusCtx, type FocusFn } from './focus'
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
            <h1 className="display text-[clamp(30px,4.2vw,46px)]">{data.supplier.legal_name}</h1>
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
          {doc ? (
            <a href={documentUrl(doc.id)} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[13.5px] font-medium hover:bg-sunken">
              Abrir PDF <Icon name="arrow" size={14} />
            </a>
          ) : null}
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
                <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">{data.status === 'failed' ? `La extracción falló: ${data.failure_reason ?? 'sin detalle'}.` : 'El documento se está leyendo. Esta pantalla se actualiza sola.'}</div>
              </div>
            )}
          </Card>

          <Card rise={2} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'decision' && 'hidden xl:block')}>
            <DecisionPanel detail={data} onAnswer={() => { setAnswering(true) }} />
          </Card>
        </div>
      </FocusCtx.Provider>

      <Modal open={answering && open.length > 0} onClose={() => { setAnswering(false) }} title="Responder a nombre del proveedor" wide>
        {open[0] ? <ClarificationCard item={open[0]} showSupplier={false} /> : null}
      </Modal>
    </div>
  )
}
