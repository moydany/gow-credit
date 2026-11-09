import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { describeFailure, DISCARD_REASON_LABELS, DiscardReason, type ApplicationDetail } from '@gow/contracts'
import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { date, money } from '../../lib/format'
import { api, ApiError, documentUrl } from '../../lib/api'
import { useApplication } from '../../lib/queries'
import { ClarificationCard } from '../clarifications/ClarificationCard'
import { Icon } from '../../ui/icons'
import { Button, Card, ErrorState, Modal, Skeleton, StatusChip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { BalanceBreaks } from './BalanceBreaks'
import { balanceBreaks } from './breaks'
import { CorrectionModal } from './CorrectionModal'
import { DecisionPanel } from './DecisionPanel'
import { ExtractionPanel, type ExtractionTab } from './Extraction'
import { pageAlerts, type PageAlert } from './pageAlerts'
import { evaluationSummary, hasSeveralMonths, StatementPicker } from './Statements'
import { FocusCtx, ReviewCtx, targetKey, type EditSpec, type FocusFn, type PendingFix, type ReviewApi } from './focus'
import type { PdfFocus } from './PdfViewer'

// pdf.js outweighs the rest of the app: load it only when a request is opened.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })))

type Panel = 'documento' | 'extraccion' | 'decision'
const PANELS: { key: Panel; label: string }[] = [
  { key: 'documento', label: 'Documento' },
  { key: 'extraccion', label: 'Extracción' },
  { key: 'decision', label: 'Decisión' },
]

function resolveStatementDoc(documents: ApplicationDetail['documents'], statement?: ApplicationDetail['statements'][0]) {
  if (statement) {
    const found = documents.find((d) => d.id === statement.document_id)
    if (found) return found
  }
  return documents[0]
}

function saveErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return e.issues[0]?.message ?? e.message
  }
  return 'No se pudieron guardar las correcciones'
}

function discardErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return 'No se pudo descartar el documento'
}

function DetailLoadingView() {
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

function ApplicationDetailHeader({
  data,
  shown,
  summary,
  doc,
}: {
  data: ApplicationDetail
  shown: ApplicationDetail['extraction'] | null
  summary: string | null
  doc?: { id: string }
}) {
  return (
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
            {summary ? <span className="font-medium text-ink-2">{summary}</span> : <span>{shown?.bank_name.value ?? 'Banco sin identificar'}</span>}
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
  )
}

function MobilePanelTabs({
  panel,
  onSelect,
}: {
  panel: Panel
  onSelect: (p: Panel) => void
}) {
  return (
    <div role="tablist" aria-label="Panel visible" className="mb-3 flex gap-1.5 xl:hidden">
      {PANELS.map((p) => (
        <button
          key={p.key}
          role="tab"
          type="button"
          aria-selected={panel === p.key}
          onClick={() => { onSelect(p.key) }}
          className={clsx('h-10 flex-1 rounded-full text-[14px] font-medium transition-colors', panel === p.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2')}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

function ReviewTrayDiscard({
  discardReason,
  onReasonChange,
  isPending,
  onDiscard,
}: {
  discardReason: DiscardReason | ''
  onReasonChange: (r: DiscardReason | '') => void
  isPending: boolean
  onDiscard: () => void
}) {
  return (
    <div className="mt-4 border-t border-amber-ink/15 pt-3">
      <label htmlFor="discard-reason" className="text-[13px] font-medium text-amber-ink">O descarta el documento si no sirve para decidir</label>
      <div className="mt-2 flex gap-2">
        <select
          id="discard-reason"
          className="min-w-0 flex-1 rounded-full bg-white/80 px-3 py-1.5 text-[13px]"
          value={discardReason}
          onChange={(e) => { onReasonChange(e.target.value as DiscardReason | '') }}
        >
          <option value="">Elige el motivo…</option>
          {DiscardReason.options.map((r) => <option key={r} value={r}>{DISCARD_REASON_LABELS[r]}</option>)}
        </select>
        <Button
          variant="danger"
          size="sm"
          disabled={discardReason === '' || isPending}
          onClick={onDiscard}
        >
          {isPending ? 'Descartando…' : 'Descartar'}
        </Button>
      </div>
    </div>
  )
}

function ReviewTray({
  pending,
  onRemovePending,
  onSave,
  isSaving,
  breaks,
  discardReason,
  onDiscardReasonChange,
  onDiscard,
  isDiscarding,
}: {
  pending: PendingFix[]
  onRemovePending: (targetKeyStr: string) => void
  onSave: () => void
  isSaving: boolean
  breaks: ReturnType<typeof balanceBreaks>
  discardReason: DiscardReason | ''
  onDiscardReasonChange: (r: DiscardReason | '') => void
  onDiscard: () => void
  isDiscarding: boolean
}) {
  return (
    <div className="mt-4 rounded-[24px] bg-amber-soft p-5">
      <p className="flex items-center gap-2 text-[14px] font-medium text-amber-ink">
        <Icon name="edit" size={16} /> {pending.length === 0 ? 'Revisa el documento' : pending.length === 1 ? '1 corrección por guardar' : `${String(pending.length)} correcciones por guardar`}
      </p>
      {breaks.length > 0 ? (
        <>
          <p className="mt-1 text-[13px] leading-snug text-amber-ink/85">El saldo deja de cuadrar {breaks.length === 1 ? 'en este movimiento' : `en ${String(breaks.length)} movimientos`}. Compáralo con el PDF y corrige lo que se leyó mal.</p>
          <BalanceBreaks breaks={breaks} className="mt-3" />
        </>
      ) : null}
      {pending.length === 0 ? (
        <p className="mt-2 text-[13px] leading-snug text-amber-ink/85">{breaks.length > 0 ? 'Para cualquier otro dato, ' : 'Si la extracción leyó mal algo, '}toca el lápiz junto al valor y escribe lo correcto con el PDF al lado. Al guardar, el motor decide de nuevo con tus correcciones.</p>
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
                <button
                  type="button"
                  aria-label={`Quitar la corrección de ${p.label}`}
                  className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-amber-soft"
                  onClick={() => { onRemovePending(targetKey(p.target)) }}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <Button className="mt-3 w-full" variant="primary" size="sm" disabled={isSaving} onClick={onSave}>
            {isSaving ? 'Guardando…' : 'Guardar y reevaluar'}
          </Button>
        </>
      )}
      {pending.length === 0 ? (
        <ReviewTrayDiscard
          discardReason={discardReason}
          onReasonChange={onDiscardReasonChange}
          isPending={isDiscarding}
          onDiscard={onDiscard}
        />
      ) : null}
    </div>
  )
}

function PdfViewerCard({
  doc,
  h,
  panel,
  focus,
  alerts,
  onAlert,
  onPage,
}: {
  doc?: { id: string }
  h: string
  panel: Panel
  focus: PdfFocus
  alerts: Map<number, PageAlert[]>
  onAlert: (page: number, a: PageAlert) => void
  onPage: (p: number) => void
}) {
  return (
    <Card rise={0} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'documento' && 'hidden xl:block')}>
      {doc ? (
        <Suspense fallback={<Skeleton className="m-4 h-[70%]" />}>
          <PdfViewer
            documentId={doc.id}
            focus={focus}
            alerts={alerts}
            onAlert={onAlert}
            onPage={onPage}
          />
        </Suspense>
      ) : (
        <p className="p-6 text-[14px] text-muted">Esta solicitud no tiene un documento PDF.</p>
      )}
    </Card>
  )
}

function ExtractionCard({
  x,
  status,
  failureReason,
  h,
  panel,
  tab,
  several,
  statement,
  statements,
  onSelectStatement,
  onTab,
}: {
  x: ApplicationDetail['extraction'] | null
  status: string
  failureReason?: string | null
  h: string
  panel: Panel
  tab?: string
  several: boolean
  statement?: { document_id: string }
  statements?: ApplicationDetail['statements']
  onSelectStatement: (docId: string) => void
  onTab: (t: ExtractionTab) => void
}) {
  const activeTab: ExtractionTab = (['resumen', 'meses', 'movimientos', 'fiscal', 'alertas'] as const).includes(tab as ExtractionTab) ? (tab as ExtractionTab) : 'resumen'
  return (
    <Card rise={1} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'extraccion' && 'hidden xl:block')}>
      {x ? (
        <ExtractionPanel
          x={x}
          tab={activeTab}
          months={several && statement && statements ? { statements, selected: statement.document_id, onSelect: onSelectStatement } : undefined}
          onTab={onTab}
        />
      ) : (
        <div className="p-6">
          <h2 className="text-[17px] font-medium tracking-tight">Extracción</h2>
          <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">
            {status === 'failed' ? describeFailure(failureReason ?? null).label : 'El documento se está leyendo. Esta pantalla se actualiza sola.'}
          </div>
        </div>
      )}
    </Card>
  )
}

function ApplicationDetailView({ data, id }: { data: ApplicationDetail; id: string }) {
  const { tab = 'resumen', pag, doc: docParam } = useSearch({ from: '/shell/solicitudes/$id' })
  const navigate = useNavigate({ from: '/solicitudes/$id' })
  const [panel, setPanel] = useState<Panel>('extraccion')
  const [answering, setAnswering] = useState(false)
  const [focus, setFocus] = useState<PdfFocus>({ page: pag ?? 1, snippet: null, tone: 'verified', nonce: 0 })
  const [pending, setPending] = useState<PendingFix[]>([])
  const [editing, setEditing] = useState<EditSpec | null>(null)
  const [discardReason, setDiscardReason] = useState<DiscardReason | ''>('')
  const toast = useToast()
  const qc = useQueryClient()

  const goTo: FocusFn = useCallback(
    (target, tone) => {
      if (!target) return
      setFocus((f) => ({ page: target.page, snippet: target.snippet, tone, nonce: f.nonce + 1 }))
      setPanel('documento')
    },
    [],
  )

  const statement = data.statements.find((s) => s.document_id === docParam) ?? data.statements.at(-1)
  const shown = statement?.extraction ?? data.extraction ?? null
  const alerts = useMemo(() => (shown ? pageAlerts(shown) : new Map<number, PageAlert[]>()), [shown])
  const breaks = useMemo(() => (shown ? balanceBreaks(shown) : []), [shown])
  const doc = resolveStatementDoc(data.documents, statement)

  const save = useMutation({
    mutationFn: () => api.correct(id, pending.map((p) => ({ target: p.target, value: p.value, page: p.page })), statement?.document_id),
    onSuccess: () => {
      toast.ok('Correcciones guardadas. Se reevalúa la solicitud.')
      setPending([])
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => { toast.error(saveErrorMessage(e)) },
  })

  const discard = useMutation({
    mutationFn: (reason: DiscardReason) => api.discard(id, reason),
    onSuccess: () => {
      toast.ok('Documento descartado. La solicitud cerró en no califica.')
      setDiscardReason('')
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => { toast.error(discardErrorMessage(e)) },
  })

  const review: ReviewApi = useMemo(
    () => ({
      enabled: data.status === 'human_review',
      pending,
      edit: (spec) => {
        setEditing(spec)
        if (spec.page) goTo({ page: spec.page, snippet: spec.snippet }, 'unverified')
      },
    }),
    [data.status, pending, goTo],
  )

  const selectStatement = useCallback(
    (documentId: string) => {
      setFocus((f) => ({ page: 1, snippet: null, tone: 'verified', nonce: f.nonce + 1 }))
      void navigate({ search: (s: { tab?: string; pag?: number; doc?: string }) => ({ ...s, doc: documentId, pag: undefined }), replace: true })
    },
    [navigate],
  )

  const several = hasSeveralMonths(data)
  const summary = evaluationSummary(data)
  const h = several ? 'xl:h-[calc(100dvh-270px)] xl:min-h-[520px]' : 'xl:h-[calc(100dvh-215px)] xl:min-h-[520px]'
  const openClarification = data.clarifications.find((c) => c.status === 'open')

  return (
    <div>
      <ApplicationDetailHeader data={data} shown={shown} summary={summary} doc={doc} />
      <MobilePanelTabs panel={panel} onSelect={setPanel} />

      {several && statement ? <StatementPicker statements={data.statements} selected={statement.document_id} onSelect={selectStatement} locked={pending.length > 0} /> : null}

      <FocusCtx.Provider value={goTo}>
        <ReviewCtx.Provider value={review}>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]">
            <PdfViewerCard
              doc={doc}
              h={h}
              panel={panel}
              focus={focus}
              alerts={alerts}
              onAlert={(page, a) => { goTo({ page, snippet: a.snippet }, a.tone) }}
              onPage={(p) => {
                setFocus((f) => ({ ...f, page: p, snippet: null, nonce: f.nonce + 1 }))
                void navigate({ search: (s: { tab?: string; pag?: number }) => ({ ...s, pag: p }), replace: true })
              }}
            />

            <ExtractionCard
              x={shown}
              status={data.status}
              failureReason={data.failure_reason}
              h={h}
              panel={panel}
              tab={tab}
              several={several}
              statement={statement}
              statements={data.statements}
              onSelectStatement={selectStatement}
              onTab={(t) => { void navigate({ search: (s: { tab?: string; pag?: number }) => ({ ...s, tab: t }), replace: true }) }}
            />

            <Card rise={2} className={clsx(h, 'min-h-[70dvh] overflow-hidden', panel !== 'decision' && 'hidden xl:block')}>
              <DecisionPanel
                detail={data}
                onAnswer={() => { setAnswering(true) }}
                tray={
                  review.enabled ? (
                    <ReviewTray
                      pending={pending}
                      onRemovePending={(targetKeyStr) => { setPending((x) => x.filter((y) => targetKey(y.target) !== targetKeyStr)) }}
                      onSave={() => { save.mutate() }}
                      isSaving={save.isPending}
                      breaks={breaks}
                      discardReason={discardReason}
                      onDiscardReasonChange={setDiscardReason}
                      onDiscard={() => { if (discardReason !== '') discard.mutate(discardReason) }}
                      isDiscarding={discard.isPending}
                    />
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

      <Modal open={answering && openClarification !== undefined} onClose={() => { setAnswering(false) }} title="Responder a nombre del proveedor" wide>
        {openClarification ? <ClarificationCard item={openClarification} showSupplier={false} /> : null}
      </Modal>
    </div>
  )
}

export function ApplicationDetailPage() {
  const { id } = useParams({ from: '/shell/solicitudes/$id' })
  const { data, isPending, isError, error, refetch } = useApplication(id)

  if (isError) {
    return (
      <Card className="mt-6">
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </Card>
    )
  }
  if (isPending) {
    return <DetailLoadingView />
  }

  return <ApplicationDetailView data={data} id={id} />
}
