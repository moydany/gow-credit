/**
 * Evaluate a supplier from their page: upload the bank statement, optionally the amount to request,
 * and follow the request here until it has a result. The PDF goes to `POST /suppliers/:id/statements`
 * and progress is polled from a status endpoint that does not touch the audit log. When the active
 * policy evaluates three months, several PDFs go into one request (ADR 0072): the first opens it on
 * hold, the rest are added and then it starts. One PDF with several months is enough too.
 */
import type { ApplicationStatus, SupplierDetail, SupplierStatementStatus } from '@gow/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { money } from '../../lib/format'
import { usePolicyVersions } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, StatusChip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

const RUNNING = new Set<ApplicationStatus>(['received', 'extracting', 'extracted', 'deciding'])
const MAX_BYTES = 40 * 1024 * 1024

/** Pesos as typed: "150000", "150,000.50", "$150,000", "150 mil", "1.2 millones". Null if empty or unreadable. */
export function parsePesos(text: string): number | null {
  const t = text.toLowerCase().replace(/mxn|pesos|\$/g, '').trim()
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(mil|k|millones|millón|millon|m)?$/.exec(t) ?? /^(\d+)(?:[.,](\d+))?\s*(mil|k|millones|millón|millon|m)$/.exec(t)
  if (!m?.[1]) return null
  const base = Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`)
  const amount = m[3] === 'mil' || m[3] === 'k' ? base * 1_000 : m[3] ? base * 1_000_000 : base
  return Number.isFinite(amount) && amount >= 1 && amount <= 1_000_000_000 ? Math.round(amount * 100) / 100 : null
}

const STEPS = ['Recibido', 'Leyendo el estado de cuenta', 'Perfil y decisión', 'Resultado'] as const

function stepOf(status: ApplicationStatus): number {
  if (status === 'received') return 0
  if (status === 'extracting') return 1
  if (status === 'extracted' || status === 'deciding') return 2
  return 3
}

/** `history.months` of the active policy; 1 while loading or without the field. */
function useHistoryMonths(): number {
  const { data } = usePolicyVersions()
  const doc = data?.find((v) => v.status === 'active')?.document as { history?: { months?: unknown } } | undefined
  return typeof doc?.history?.months === 'number' ? doc.history.months : 1
}

/**
 * Uploads the statements as one request: a single one starts right away; several open it on hold,
 * are added one by one and then start. If one of the extra ones fails, it starts with the ones that
 * arrived and the engine asks for what is missing; `skipped` says which.
 */
async function sendStatements(supplierId: string, files: readonly File[], amount: number | null, onStep: (n: number) => void): Promise<{ id: string; skipped: string[] }> {
  const [first, ...rest] = files
  if (!first) throw new Error('sin archivos')
  onStep(1)
  const opened = await api.uploadStatement(supplierId, first, amount, rest.length > 0)
  if (rest.length === 0) return { id: opened.id, skipped: [] }
  const skipped: string[] = []
  for (const [i, f] of rest.entries()) {
    onStep(i + 2)
    try {
      await api.addStatement(supplierId, opened.id, f)
    } catch (e) {
      skipped.push(`${f.name}: ${e instanceof ApiError ? e.message : 'no se pudo subir'}`)
    }
  }
  await api.startStatements(supplierId, opened.id)
  return { id: opened.id, skipped }
}

/** The card's words: one statement, or the months the policy evaluates; and the upload's progress. */
function uploadTexts(months: number, count: number, step: number, pending: boolean) {
  const several = months > 1
  const progress = count > 1 ? `Subiendo ${String(step)} de ${String(count)}…` : 'Subiendo…'
  const files = !several || count === 0 ? null : count === 1 ? '1 archivo: si trae los meses seguidos, basta.' : `${String(count)} archivos: se evalúan juntos, como una sola solicitud.`
  return {
    title: several ? 'Evaluar estados de cuenta' : 'Evaluar un estado de cuenta',
    subtitle: several
      ? `Esta política evalúa ${String(months)} meses seguidos: sube los ${String(months)} PDF juntos, o uno que los traiga todos. El monto es opcional; sin él se decide con la línea máxima.`
      : 'Sube el PDF y, si quieres, el monto a solicitar. Sin monto se decide con la línea máxima.',
    label: several ? 'Estados de cuenta (PDF)' : 'Estado de cuenta (PDF)',
    files,
    button: pending ? progress : 'Evaluar',
  }
}

/** Upload card plus the progress of the request it opened (or of one still running). */
export function StatementUpload({ supplier }: { supplier: SupplierDetail }) {
  const toast = useToast()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const months = useHistoryMonths()
  const several = months > 1
  const [files, setFiles] = useState<File[]>([])
  const [step, setStep] = useState(0)
  const [amountText, setAmountText] = useState('')
  const [tried, setTried] = useState(false)
  const [tracked, setTracked] = useState<string | null>(null)
  const amount = amountText.trim() ? parsePesos(amountText) : null
  const amountError = amountText.trim() && amount === null ? 'Escribe el monto en pesos, por ejemplo 150000 o 150 mil' : undefined
  const tooBig = files.find((f) => f.size > MAX_BYTES)
  const fileError = files.length === 0 ? (tried ? 'Elige el estado de cuenta en PDF' : undefined) : tooBig ? `${tooBig.name} pasa de 40 MB` : undefined

  // After a reload, keep following the most recent request that is still running.
  const running = supplier.applications.find((a) => RUNNING.has(a.status))?.id ?? null
  const following = tracked ?? running

  const upload = useMutation({
    mutationFn: () => sendStatements(supplier.id, files, amount, setStep),
    onSuccess: (r) => {
      setTracked(r.id)
      setFiles([])
      setStep(0)
      setAmountText('')
      setTried(false)
      if (input.current) input.current.value = ''
      if (r.skipped.length > 0) toast.error(`Se evalúa sin ${r.skipped.length === 1 ? 'un archivo' : `${String(r.skipped.length)} archivos`}. ${r.skipped.join('. ')}`)
      else toast.ok(files.length > 1 ? 'Estados de cuenta recibidos; ya se están evaluando juntos' : 'Estado de cuenta recibido; ya se está evaluando')
      void qc.invalidateQueries({ queryKey: ['supplier', supplier.id] })
      void qc.invalidateQueries({ queryKey: ['applications'] })
    },
    onError: (e: unknown) => {
      setStep(0)
      toast.error(e instanceof ApiError ? e.message : 'No se pudo subir el estado de cuenta')
    },
  })
  const texts = uploadTexts(months, files.length, step, upload.isPending)

  return (
    <Card rise={0} className="pb-5">
      <CardHeader title={texts.title} subtitle={texts.subtitle} />
      <form
        noValidate
        className="mt-4 grid gap-3 px-6 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-start"
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (files.length > 0 && !fileError && !amountError) upload.mutate()
        }}
      >
        <label className="block min-w-0">
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{texts.label}</span>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            multiple={several}
            className="input py-2 file:mr-3 file:rounded-full file:border-0 file:bg-sunken file:px-3 file:py-1 file:text-[12.5px] file:text-ink-2"
            aria-invalid={fileError !== undefined}
            onChange={(e) => { setFiles(Array.from(e.target.files ?? []).slice(0, several ? 12 : 1)) }}
          />
          {fileError ? <FieldError text={fileError} /> : null}
          {texts.files ? <span className="mt-1.5 block text-[12px] text-muted">{texts.files}</span> : null}
        </label>
        <label className="block min-w-0">
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Monto a solicitar</span>
          <input className="input tnum" inputMode="decimal" placeholder="Opcional, p. ej. 150 mil" value={amountText} onChange={(e) => { setAmountText(e.target.value) }} aria-invalid={amountError !== undefined} autoComplete="off" />
          {amountError ? <FieldError text={amountError} /> : amount !== null ? <span className="tnum mt-1.5 block text-[12px] text-muted">{money(amount)}</span> : null}
        </label>
        <div className="sm:pt-[26px]">
          <Button type="submit" variant="accent" disabled={upload.isPending} className="w-full sm:w-auto">
            <Icon name="bolt" size={15} /> {texts.button}
          </Button>
        </div>
      </form>
      {following ? <Progress supplierId={supplier.id} applicationId={following} /> : null}
    </Card>
  )
}

/** Polls every 2 s while the request runs; once it ends, refreshes the supplier's list once. */
function Progress({ supplierId, applicationId }: { supplierId: string; applicationId: string }) {
  const qc = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: ['statement-status', supplierId, applicationId],
    queryFn: () => api.statementStatus(supplierId, applicationId),
    refetchInterval: (q) => (q.state.data && !RUNNING.has(q.state.data.status) ? false : 2000),
  })
  const final = data !== undefined && !RUNNING.has(data.status)
  useEffect(() => {
    if (final) {
      void qc.invalidateQueries({ queryKey: ['supplier', supplierId] })
      void qc.invalidateQueries({ queryKey: ['applications'] })
    }
  }, [final, qc, supplierId])

  if (isError) return <p className="mx-6 mt-4 text-[13px] text-coral-ink">No se pudo leer el avance de la solicitud.</p>
  if (!data) return null
  const step = stepOf(data.status)
  return (
    <div className="mx-6 mt-5 rounded-3xl bg-sunken/60 px-5 py-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip status={data.status} />
        <Link to="/solicitudes/$id" params={{ id: data.id }} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
          Ver la solicitud <Icon name="right" size={14} />
        </Link>
      </div>
      <ol className="mt-4 grid grid-cols-4 gap-2" aria-label="Avance">
        {STEPS.map((label, i) => (
          <li key={label} className="min-w-0">
            <div className={`h-1.5 rounded-full ${i < step || final ? 'bg-accent' : i === step ? 'animate-pulse bg-accent/60' : 'bg-line'}`} />
            <p className={`mt-1.5 truncate text-[12px] ${i <= step ? 'text-ink-2' : 'text-muted'}`}>{label}</p>
          </li>
        ))}
      </ol>
      {final ? <Result s={data} /> : <p className="mt-3 text-[13px] text-muted">{data.requested === null ? 'Se decide con la línea máxima.' : `Se evalúa con ${money(data.requested)} solicitados.`} Suele tardar uno o dos minutos.</p>}
    </div>
  )
}

function Result({ s }: { s: SupplierStatementStatus }) {
  return (
    <div className="mt-4 space-y-3 text-[14px]">
      <Figures s={s} />
      <StatusNote s={s} />
      {s.decision?.explanation ? <p className="leading-relaxed text-ink-2">{s.decision.explanation}</p> : null}
    </div>
  )
}

/** Line or approved amount, requested and score; only when it qualifies. */
function Figures({ s }: { s: SupplierStatementStatus }) {
  const d = s.decision
  if (!d || (s.status !== 'qualified' && s.status !== 'qualified_with_limit')) return null
  // Same rule as the supplier's notice: the amount requested if it fits in the line, the line otherwise.
  const fits = s.requested !== null && d.limit !== null && s.requested <= d.limit + 0.005
  const label = fits ? 'Monto aprobado' : s.requested === null ? 'Línea máxima' : 'Línea aprobada'
  return (
    <dl className="tnum grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Figure label={label} value={money(fits ? s.requested : d.limit)} />
      {s.requested !== null ? <Figure label="Solicitado" value={money(s.requested)} /> : null}
      <Figure label="Puntaje" value={d.score === null ? '—' : String(Math.round(d.score))} />
    </dl>
  )
}

/** What to do next when there is no plain result: why it failed, the clarification or the review. */
function StatusNote({ s }: { s: SupplierStatementStatus }) {
  if (s.status === 'failed') return s.failure ? <p className="text-coral-ink">{s.failure}</p> : null
  if (s.status === 'human_review') return <p className="text-ink-2">Un analista tiene que revisarla en la solicitud antes de dar un resultado.</p>
  if (s.status !== 'needs_clarification') return null
  return (
    <p className="text-ink-2">
      {s.open_clarification ? 'Hay preguntas sobre el estado de cuenta antes de decidir. ' : ''}
      <Link to="/aclaraciones" className="font-medium underline underline-offset-2">
        Respóndelas en Aclaraciones
      </Link>{' '}
      y la evaluación sigue sola.
    </p>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-[16px] font-medium">{value}</dd>
    </div>
  )
}

function FieldError({ text }: { text: string }) {
  return (
    <span role="alert" className="mt-1.5 block rounded-2xl bg-coral-soft px-3 py-1.5 text-[12.5px] text-coral-ink">
      {text}
    </span>
  )
}
