/**
 * Una aclaración con sus preguntas (docs/08 §2). Abierta: el analista responde a nombre del
 * proveedor (la API deja `user:<id>` en la bitácora y el nombre aquí). Respondida: lectura.
 * Las preguntas de documentos nuevos no se contestan a mano (el PDF llega por la API): se pueden
 * declinar para que la evaluación siga sin ellos.
 */
import { checkClabe, checkRfc, type ClarificationItem, type OwnerAnswer, type Question } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import clsx from 'clsx'
import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { ago, CATEGORY_LABEL, CHANNEL_LABEL, dateTime, money } from '../../lib/format'
import { Icon } from '../../ui/icons'
import { Button, Chip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

type Draft = { kind: 'deposit'; category: string; counterparty: string } | { kind: 'identity'; legal_name: string; rfc: string; clabe: string } | { kind: 'decline'; note: string }

const DEPOSIT_OPTIONS = ['customer_payment', 'loan_disbursement', 'own_transfer', 'interest', 'other'] as const

function factText(name: string, value: string | number | boolean | null): string {
  if (typeof value === 'number' && /monto|amount|total/i.test(name)) return money(value, true)
  return value === null ? '—' : String(value)
}

const TOPIC: Record<string, string> = {
  recent_statement: 'Estado de cuenta reciente',
  identity_fields: 'Identidad del titular',
  deposit_classification: 'Abono por clasificar',
  reconciliation_gap: 'Diferencia en el cuadre',
  additional_months: 'Más meses',
  missing_pages: 'Páginas faltantes',
}

function toAnswer(q: Question, d: Draft | undefined): OwnerAnswer | null {
  if (!d) return null
  if (d.kind === 'decline') return { question_id: q.id, kind: 'decline', note: d.note.trim() || null }
  if (d.kind === 'deposit') {
    if (!d.category) return null
    return { question_id: q.id, kind: 'deposit', category: d.category as never, counterparty: d.counterparty.trim() || null }
  }
  const legal = d.legal_name.trim()
  const rfc = d.rfc.trim().toUpperCase()
  const clabe = d.clabe.replace(/\s/g, '')
  if (!legal && !rfc && !clabe) return null
  if (rfc && checkRfc(rfc).result === 'invalid') return null
  if (clabe && checkClabe(clabe) === 'invalid') return null
  return { question_id: q.id, kind: 'identity', legal_name: legal || null, rfc: rfc || null, clabe: clabe || null }
}

export function ClarificationCard({ item, showSupplier = true }: { item: ClarificationItem; showSupplier?: boolean }) {
  const open = item.status === 'open'
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const toast = useToast()
  const qc = useQueryClient()
  const send = useMutation({
    mutationFn: (answers: OwnerAnswer[]) => api.answer(item.id, answers),
    onSuccess: (r) => {
      toast.ok(r.complete ? 'Respuesta guardada. Se reanuda la evaluación.' : 'Respuesta guardada. Faltan preguntas por contestar.')
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'No se pudo guardar la respuesta')
    },
  })

  const answers = item.questions.map((q) => toAnswer(q, drafts[q.id]))
  const ready = open && answers.every((a) => a !== null)
  const set = (id: string, d: Draft) => { setDrafts((x) => ({ ...x, [id]: d })) }

  return (
    <article className="card overflow-hidden" aria-labelledby={`c-${item.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5">
        <div className="min-w-0">
          <h3 id={`c-${item.id}`} className="truncate text-[17px] font-medium tracking-tight">
            {showSupplier ? item.supplier_name : `Ronda ${String(item.round)}`}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted">
            Ronda {item.round} · {CHANNEL_LABEL[item.channel]} · enviada {ago(item.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={open ? 'indigo' : item.status === 'answered' ? 'lime' : 'hatch'} dot>
            {open ? 'Abierta' : item.status === 'answered' ? 'Respondida' : item.status === 'expired' ? 'Vencida' : 'Rechazada'}
          </Chip>
          <Link to="/solicitudes/$id" params={{ id: item.application_id }} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] font-medium hover:bg-sunken">
            Solicitud <Icon name="arrow" size={13} />
          </Link>
        </div>
      </header>

      {open && item.channel === 'manual' ? (
        <p className="mx-6 mt-4 flex items-start gap-2.5 rounded-2xl bg-sunken px-4 py-3 text-[13px] text-ink-2">
          <Icon name="chat" size={16} className="mt-0.5 shrink-0" />
          Esta aclaración no salió por WhatsApp ni por correo (el proveedor no tiene un contacto verificado). Responde tú a nombre del proveedor: quedará registrado con tu usuario.
        </p>
      ) : null}

      <ol className="space-y-3 px-6 pb-6 pt-4">
        {item.questions.map((q, i) => {
          const d = drafts[q.id]
          const given = item.answers.find((a) => a.question_id === q.id)
          return (
            <li key={q.id} className="rounded-[22px] border border-line p-5">
              <div className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-semibold text-lime">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{TOPIC[q.topic] ?? q.topic}</p>
                  <p className="mt-1 text-[14.5px] leading-relaxed">{q.text}</p>
                  {q.facts.length > 0 ? (
                    <dl className="mt-3 flex flex-wrap gap-1.5">
                      {q.facts.map((f) => (
                        <div key={f.name} className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-[12px]">
                          <dt className="text-muted">{f.name.replace(/_/g, ' ')}</dt>
                          <dd className="tnum font-medium">{factText(f.name, f.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {!open ? (
                    <Given a={given} />
                  ) : q.kind === 'deposit' ? (
                    <div className="mt-4 space-y-3">
                      <div role="radiogroup" aria-label="Qué fue este abono" className="flex flex-wrap gap-1.5">
                        {(q.options.length > 0 ? q.options.map((o) => o.value) : [...DEPOSIT_OPTIONS]).map((v) => {
                          const on = d?.kind === 'deposit' && d.category === v
                          return (
                            <button key={v} type="button" role="radio" aria-checked={on} onClick={() => { set(q.id, { kind: 'deposit', category: v, counterparty: d?.kind === 'deposit' ? d.counterparty : '' }) }} className={clsx('h-9 rounded-full px-4 text-[13px] font-medium transition-colors', on ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
                              {q.options.find((o) => o.value === v)?.label ?? CATEGORY_LABEL[v] ?? v}
                            </button>
                          )
                        })}
                      </div>
                      {d?.kind === 'deposit' ? (
                        <Field label="¿Quién lo depositó? (opcional)">
                          <input value={d.counterparty} onChange={(e) => { set(q.id, { ...d, counterparty: e.target.value }) }} className="input" autoComplete="off" />
                        </Field>
                      ) : null}
                    </div>
                  ) : q.kind === 'identity' ? (
                    <IdentityFields d={d?.kind === 'identity' ? d : { kind: 'identity', legal_name: '', rfc: '', clabe: '' }} onChange={(next) => { set(q.id, next) }} />
                  ) : (
                    <p className="mt-3 flex items-start gap-2 rounded-2xl bg-sunken p-3 text-[12.5px] text-ink-2">
                      <Icon name="file" size={15} className="mt-0.5 shrink-0" /> El estado de cuenta nuevo lo manda el proveedor por la API. Si no lo hay, declina para que la evaluación siga sin él.
                    </p>
                  )}

                  {open ? (
                    <button
                      type="button"
                      className={clsx('mt-3 inline-flex h-8 items-center rounded-full px-3 text-[12.5px] font-medium transition-colors', d?.kind === 'decline' ? 'bg-ink text-white' : 'text-muted hover:bg-sunken hover:text-ink')}
                      aria-pressed={d?.kind === 'decline'}
                      onClick={() => { if (d?.kind === 'decline') setDrafts((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== q.id))); else set(q.id, { kind: 'decline', note: '' }) }}
                    >
                      Sin respuesta / no disponible
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {open ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sunken/60 px-6 py-4">
          <p className="text-[12.5px] text-muted">{ready ? 'Todo listo para enviar.' : 'Contesta cada pregunta o márcala sin respuesta.'}</p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={send.isPending}
              onClick={() => { send.mutate(item.questions.map((q) => ({ question_id: q.id, kind: 'decline', note: null }))) }}
            >
              Declinar todo y seguir
            </Button>
            <Button variant="lime" size="sm" disabled={!ready || send.isPending} onClick={() => { send.mutate(answers.filter((a): a is OwnerAnswer => a !== null)) }}>
              {send.isPending ? 'Enviando…' : 'Responder a nombre del proveedor'}
            </Button>
          </div>
        </footer>
      ) : item.answered_at ? (
        <footer className="border-t border-line px-6 py-3 text-[12.5px] text-muted">
          Respondida {dateTime(item.answered_at)} {item.answered_by ? `por ${item.answered_by} (analista)` : 'por el proveedor'}
        </footer>
      ) : null}
    </article>
  )
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-[12px] text-coral-ink">{error}</span> : hint ? <span className="mt-1 block text-[12px] text-muted">{hint}</span> : null}
    </label>
  )
}

function IdentityFields({ d, onChange }: { d: Extract<Draft, { kind: 'identity' }>; onChange: (d: Draft) => void }) {
  const rfc = d.rfc.trim() ? checkRfc(d.rfc.trim()).result : null
  const clabe = d.clabe.trim() ? checkClabe(d.clabe) : null
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Razón social o nombre del titular">
          <input value={d.legal_name} onChange={(e) => { onChange({ ...d, legal_name: e.target.value }) }} className="input" autoComplete="off" />
        </Field>
      </div>
      <Field label="RFC" error={rfc === 'invalid' ? 'El RFC no tiene un formato válido' : null}>
        <input value={d.rfc} onChange={(e) => { onChange({ ...d, rfc: e.target.value.toUpperCase() }) }} className="input font-mono uppercase" autoComplete="off" maxLength={13} aria-invalid={rfc === 'invalid'} />
      </Field>
      <Field label="CLABE" error={clabe === 'invalid' ? 'La CLABE no pasa el dígito verificador' : null}>
        <input value={d.clabe} onChange={(e) => { onChange({ ...d, clabe: e.target.value.replace(/[^\d\s]/g, '') }) }} className="input font-mono" inputMode="numeric" autoComplete="off" maxLength={22} aria-invalid={clabe === 'invalid'} />
      </Field>
    </div>
  )
}

function Given({ a }: { a: OwnerAnswer | undefined }) {
  if (!a) return <p className="mt-3 text-[13px] text-muted">Sin respuesta todavía.</p>
  const text =
    a.kind === 'deposit' ? `${CATEGORY_LABEL[a.category] ?? a.category}${a.counterparty ? ` · ${a.counterparty}` : ''}` : a.kind === 'identity' ? [a.legal_name, a.rfc, a.clabe].filter(Boolean).join(' · ') || 'Sin datos' : a.kind === 'decline' ? `Sin respuesta${a.note ? `: ${a.note}` : ''}` : 'Documentos enviados'
  return (
    <p className="mt-3 inline-flex max-w-full items-center gap-2 rounded-2xl bg-lime-soft px-3.5 py-2 text-[13.5px] font-medium text-lime-ink">
      <Icon name="check" size={15} className="shrink-0" />
      <span className="truncate">{text}</span>
    </p>
  )
}
