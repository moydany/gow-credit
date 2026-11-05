import type { SourceRef, Verification } from '@gow/contracts'
import clsx from 'clsx'
import { createContext, useContext, type ReactNode } from 'react'
import { PROVENANCE_LABEL, VERIFICATION_LABEL } from '../../lib/format'
import { Icon } from '../../ui/icons'
import type { Tone } from './PdfViewer'

export type FocusFn = (target: { page: number; snippet: string | null } | null, tone: Tone) => void
export const FocusCtx = createContext<FocusFn>(() => undefined)
export const useFocus = () => useContext(FocusCtx)

interface FieldLike<T> {
  value: T | null
  source: SourceRef | null
  verification: Verification
  confidence: number
  provenance: string
}

/**
 * Un valor extraído con su estado visible: verificado se ve normal, sin verificar rayado ámbar,
 * en conflicto rayado coral. Clic = ir a su página en el PDF y resaltar el fragmento citado.
 */
export function Val<T>({ field, format, empty = '—', className }: { field: FieldLike<T>; format?: (v: T) => ReactNode; empty?: string; className?: string }) {
  const focus = useFocus()
  const shown: ReactNode = field.value === null ? empty : format ? format(field.value) : String(field.value)
  const status = VERIFICATION_LABEL[field.verification] ?? field.verification
  const where = field.source ? ` · p. ${String(field.source.page)}` : ''
  const label = `${status}${where} · confianza ${String(Math.round(field.confidence * 100))} % · ${PROVENANCE_LABEL[field.provenance] ?? field.provenance}`
  // Un dato que no aparece en el documento no es una alarma: se muestra apagado, sin rayado.
  const missing = field.value === null
  const cls = clsx('val', !missing && field.verification === 'unverified' && 'val-unverified', !missing && field.verification === 'conflict' && 'val-conflict', missing && 'text-muted', className)
  const marker = field.verification === 'verified' || missing ? null : <Icon name={field.verification === 'conflict' ? 'alert' : 'help'} size={12} className="mb-0.5 ml-1 inline" />
  if (!field.source) {
    return (
      <span className={cls} title={missing ? 'No aparece en el documento' : label}>
        {shown}
        {marker}
        <span className="sr-only">{`, ${status}`}</span>
      </span>
    )
  }
  const source = field.source
  return (
    <button type="button" className={cls} title={`${label}. Ver en el documento`} onClick={() => { focus(source, field.verification) }}>
      {shown}
      {marker}
      <span className="sr-only">{`, ${status}, página ${String(source.page)}`}</span>
    </button>
  )
}
