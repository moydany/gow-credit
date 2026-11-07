import type { CorrectionTarget, SourceRef, Verification } from '@gow/contracts'
import clsx from 'clsx'
import { createContext, useContext, type ReactNode } from 'react'
import { PROVENANCE_LABEL, VERIFICATION_LABEL } from '../../lib/format'
import { Icon } from '../../ui/icons'
import type { Tone } from './PdfViewer'

export type FocusFn = (target: { page: number; snippet: string | null } | null, tone: Tone) => void
export const FocusCtx = createContext<FocusFn>(() => undefined)
export const useFocus = () => useContext(FocusCtx)

/** A correction the analyst built and hasn't saved yet. */
export interface PendingFix {
  target: CorrectionTarget
  value: string | number
  page: number | null
  /** What the extraction says today, to show "before -> after". */
  read: string | number | null
  label: string
}
export interface EditSpec {
  target: CorrectionTarget
  label: string
  current: string | number | null
  page: number | null
  snippet: string | null
  /** A movement is corrected whole: amount, direction and date in the same form. */
  tx?: { id: string; amount: number; type: 'credit' | 'debit'; date: string }
}
export interface ReviewApi {
  /** Only on requests in human review. */
  enabled: boolean
  pending: PendingFix[]
  edit: (spec: EditSpec) => void
}
export const ReviewCtx = createContext<ReviewApi>({ enabled: false, pending: [], edit: () => undefined })
export const useReview = () => useContext(ReviewCtx)
export const targetKey = (t: CorrectionTarget) => JSON.stringify(t)

interface FieldLike<T> {
  value: T | null
  source: SourceRef | null
  verification: Verification
  confidence: number
  provenance: string
}

/**
 * An extracted value with its visible status: verified looks normal, unverified gets amber
 * stripes, conflicting gets coral stripes. Click = go to its PDF page and highlight the snippet.
 */
export function Val<T>({ field, format, empty = '—', className, target, label }: { field: FieldLike<T>; format?: (v: T) => ReactNode; empty?: string; className?: string; target?: CorrectionTarget; label?: string }) {
  const focus = useFocus()
  const review = useReview()
  const pending = target ? review.pending.find((p) => targetKey(p.target) === targetKey(target)) : undefined
  const shown: ReactNode = pending ? (format ? format(pending.value as T) : String(pending.value)) : field.value === null ? empty : format ? format(field.value) : String(field.value)
  const status = VERIFICATION_LABEL[field.verification] ?? field.verification
  const where = field.source ? ` · p. ${String(field.source.page)}` : ''
  const tip = `${status}${where} · confianza ${String(Math.round(field.confidence * 100))} % · ${PROVENANCE_LABEL[field.provenance] ?? field.provenance}`
  // A value absent from the document is not an alarm: shown muted, no stripes.
  const missing = field.value === null
  const cls = clsx('val', pending && 'bg-indigo-soft text-indigo-ink', !pending && !missing && field.verification === 'unverified' && 'val-unverified', !pending && !missing && field.verification === 'conflict' && 'val-conflict', missing && !pending && 'text-muted', field.provenance === 'analyst_answer' && !pending && 'underline decoration-indigo decoration-2 underline-offset-4', className)
  const marker = field.verification === 'verified' || missing ? null : <Icon name={field.verification === 'conflict' ? 'alert' : 'help'} size={12} className="mb-0.5 ml-1 inline" />

  const source = field.source
  const main = !source ? (
    <span className={cls} title={missing && !pending ? 'No aparece en el documento' : tip}>
      {shown}
      {marker}
      <span className="sr-only">{`, ${status}`}</span>
    </span>
  ) : (
    <button type="button" className={cls} title={`${tip}. Ver en el documento`} onClick={() => { focus(source, field.verification) }}>
      {shown}
      {marker}
      <span className="sr-only">{`, ${status}, página ${String(source.page)}`}</span>
    </button>
  )
  if (!review.enabled || !target) return main
  return (
    <span className="inline-flex items-baseline gap-1">
      {main}
      <button
        type="button"
        className="inline-grid size-6 translate-y-1 place-items-center rounded-full text-muted transition-colors hover:bg-indigo-soft hover:text-indigo-ink"
        aria-label={`Corregir ${label ?? 'este valor'}`}
        title="Corregir este valor"
        onClick={() => { review.edit({ target, label: label ?? 'Valor', current: field.value as string | number | null, page: source?.page ?? null, snippet: source?.snippet ?? null }) }}
      >
        <Icon name="edit" size={13} />
      </button>
    </span>
  )
}
