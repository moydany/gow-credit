/**
 * A clarification with its questions. Open: the analyst answers on the supplier's behalf (the API
 * logs `user:<id>`, the name shows here). Answered: read-only. Questions for new documents can't
 * be answered by hand (the PDF arrives through the API); they can be declined so the evaluation
 * goes on without them. Deposits, charges and account use are answered by picking an option; the
 * main customer by typing a name.
 */
import { checkClabe, checkRfc, type ClarificationItem, type OwnerAnswer, type Question } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { api, ApiError } from '../../lib/api'
import { ago, CATEGORY_LABEL, CHANNEL_LABEL, dateTime, money } from '../../lib/format'
import { Icon } from '../../ui/icons'
import { Button, Chip } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

type Draft =
  | { kind: 'deposit'; category: string; counterparty: string }
  | { kind: 'charge'; category: string; counterparty: string }
  | { kind: 'account_use'; use: string }
  | { kind: 'buyer'; name: string }
  | { kind: 'identity'; legal_name: string; rfc: string; clabe: string }
  | { kind: 'decline'; note: string }

/** Fallback options for a stored question that has none; the question's own options win. */
const FALLBACK_OPTIONS: Record<'deposit' | 'charge' | 'account_use', readonly string[]> = {
  deposit: ['customer_payment', 'loan_disbursement', 'own_transfer', 'interest', 'other'],
  charge: ['loan_payment', 'supplier_payment', 'own_transfer', 'personal_expense', 'other'],
  account_use: ['business_only', 'mixed'],
}

const OPTION_LABEL: Record<string, string> = { personal_expense: 'Gasto personal', business_only: 'Solo negocio', mixed: 'Negocio y gastos personales' }

/** The chosen option in an options draft, or null. */
/** Document questions the supplier answers by sending the PDF over WhatsApp (`isDocumentRequest`). */
const PDF_BY_CHAT: ReadonlySet<string> = new Set(['missing_pages', 'statement_with_address', 'additional_months'])

function selected(d: Draft | undefined): string | null {
  if (!d) return null
  if (d.kind === 'account_use') return d.use
  return d.kind === 'deposit' || d.kind === 'charge' ? d.category : null
}

const OPTIONS_ARIA: Record<'deposit' | 'charge' | 'account_use', string> = { deposit: 'Qué fue este abono', charge: 'Qué fue este cargo', account_use: 'Uso de la cuenta' }

function factText(name: string, value: string | number | boolean | null): string {
  if (typeof value === 'number' && /monto|amount|total/i.test(name)) return money(value)
  return value === null ? '—' : String(value)
}

const TOPIC: Record<string, string> = {
  recent_statement: 'Estado de cuenta reciente',
  identity_fields: 'Identidad del titular',
  deposit_classification: 'Abono por clasificar',
  charge_classification: 'Cargo por clasificar',
  main_buyer: 'Cliente principal',
  account_use: 'Uso de la cuenta',
  reconciliation_gap: 'Diferencia en el cuadre',
  additional_months: 'Más meses',
  missing_pages: 'Páginas faltantes',
  statement_with_address: 'Estado de cuenta con domicilio',
}

function toIdentityAnswer(q: Question, d: Extract<Draft, { kind: 'identity' }>): OwnerAnswer | null {
  const legal = d.legal_name.trim()
  const rfc = d.rfc.trim().toUpperCase()
  const clabe = d.clabe.replace(/\s/g, '')
  if (!legal && !rfc && !clabe) return null
  if (rfc && checkRfc(rfc).result === 'invalid') return null
  if (clabe && checkClabe(clabe) === 'invalid') return null
  return { question_id: q.id, kind: 'identity', legal_name: legal || null, rfc: rfc || null, clabe: clabe || null }
}

function toAnswer(q: Question, d: Draft | undefined): OwnerAnswer | null {
  if (!d) return null
  if (d.kind === 'decline') return { question_id: q.id, kind: 'decline', note: d.note.trim() || null }
  if (d.kind === 'deposit' || d.kind === 'charge') {
    if (!d.category) return null
    return { question_id: q.id, kind: d.kind, category: d.category as never, counterparty: d.counterparty.trim() || null }
  }
  if (d.kind === 'account_use') return d.use ? { question_id: q.id, kind: 'account_use', use: d.use as never } : null
  if (d.kind === 'buyer') {
    const name = d.name.replace(/\s+/g, ' ').trim()
    return name.length >= 3 && name.length <= 200 ? { question_id: q.id, kind: 'buyer', name } : null
  }
  return toIdentityAnswer(q, d)
}

function OptionsEditor({
  q,
  kind,
  draft: d,
  onSetDraft,
}: {
  q: Question
  kind: 'deposit' | 'charge' | 'account_use'
  draft: Draft | undefined
  onSetDraft: (id: string, d: Draft) => void
}) {
  const options = q.options.length > 0 ? q.options.map((o) => o.value) : [...FALLBACK_OPTIONS[kind]]
  return (
    <div className="mt-4 space-y-3">
      <div role="radiogroup" aria-label={OPTIONS_ARIA[kind]} className="flex flex-wrap gap-1.5">
        {options.map((v) => {
          const on = d?.kind === kind && selected(d) === v
          const counterparty = d && (d.kind === 'deposit' || d.kind === 'charge') ? d.counterparty : ''
          const pick = () => {
            onSetDraft(q.id, kind === 'account_use' ? { kind, use: v } : { kind, category: v, counterparty })
          }
          return (
            <button key={v} type="button" role="radio" aria-checked={on} onClick={pick} className={clsx('h-9 rounded-full px-4 text-[13px] font-medium transition-colors', on ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
              {q.options.find((o) => o.value === v)?.label ?? CATEGORY_LABEL[v] ?? OPTION_LABEL[v] ?? v}
            </button>
          )
        })}
      </div>
      {d && (d.kind === 'deposit' || d.kind === 'charge') ? (
        <Field label={d.kind === 'deposit' ? '¿Quién lo depositó? (opcional)' : '¿A quién se le pagó? (opcional)'}>
          <input value={d.counterparty} onChange={(e) => { onSetDraft(q.id, { ...d, counterparty: e.target.value }) }} className="input" autoComplete="off" />
        </Field>
      ) : null}
    </div>
  )
}

interface QuestionEditorProps {
  q: Question
  draft: Draft | undefined
  channel: string
  onSetDraft: (id: string, d: Draft) => void
}

function QuestionEditor({ q, draft: d, channel, onSetDraft }: QuestionEditorProps) {
  if (q.kind === 'deposit' || q.kind === 'charge' || q.kind === 'account_use') {
    return <OptionsEditor q={q} kind={q.kind} draft={d} onSetDraft={onSetDraft} />
  }
  if (q.kind === 'buyer') {
    return (
      <div className="mt-4">
        <Field label="Cliente principal (razón social o nombre comercial)" hint="Se buscan sus pagos en el estado de cuenta por este nombre.">
          <input value={d?.kind === 'buyer' ? d.name : ''} onChange={(e) => { onSetDraft(q.id, { kind: 'buyer', name: e.target.value }) }} className="input" autoComplete="off" maxLength={200} />
        </Field>
      </div>
    )
  }
  if (q.kind === 'identity') {
    return (
      <IdentityFields d={d?.kind === 'identity' ? d : { kind: 'identity', legal_name: '', rfc: '', clabe: '' }} ask={askedFields(q.facts)} onChange={(next) => { onSetDraft(q.id, next) }} />
    )
  }
  return (
    <p className="mt-3 flex items-start gap-2 rounded-2xl bg-sunken p-3 text-[12.5px] text-ink-2">
      <Icon name="file" size={15} className="mt-0.5 shrink-0" />
      {channel === 'whatsapp' && PDF_BY_CHAT.has(q.topic)
        ? 'Se le pidió el PDF por WhatsApp. Cuando lo mande por ese chat, se agrega a la solicitud y la evaluación sigue sola. Si no lo va a mandar, declina para que siga sin él.'
        : 'El estado de cuenta nuevo lo manda el proveedor por la API. Si no lo hay, declina para que la evaluación siga sin él.'}
    </p>
  )
}

interface QuestionItemProps {
  q: Question
  index: number
  draft: Draft | undefined
  given: OwnerAnswer | undefined
  open: boolean
  channel: string
  onSetDraft: (id: string, d: Draft) => void
  onClearDraft: (id: string) => void
}

function QuestionItem({ q, index, draft: d, given, open, channel, onSetDraft, onClearDraft }: QuestionItemProps) {
  return (
    <li className="rounded-[22px] border border-line p-5">
      <div className="flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[12px] font-semibold text-white">{index + 1}</span>
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
          ) : (
            <QuestionEditor q={q} draft={d} channel={channel} onSetDraft={onSetDraft} />
          )}

          {open ? (
            <button
              type="button"
              className={clsx('mt-3 inline-flex h-8 items-center rounded-full px-3 text-[12.5px] font-medium transition-colors', d?.kind === 'decline' ? 'bg-ink text-white' : 'text-muted hover:bg-sunken hover:text-ink')}
              aria-pressed={d?.kind === 'decline'}
              onClick={() => {
                if (d?.kind === 'decline') onClearDraft(q.id)
                else onSetDraft(q.id, { kind: 'decline', note: '' })
              }}
            >
              Sin respuesta / no disponible
            </button>
          ) : null}
        </div>
      </div>
    </li>
  )
}

interface ClarificationCardHeaderProps {
  item: ClarificationItem
  open: boolean
  showSupplier: boolean
}

function ClarificationCardHeader({ item, open, showSupplier }: ClarificationCardHeaderProps) {
  return (
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
        <Chip tone={open ? 'indigo' : item.status === 'answered' ? 'accent' : 'hatch'} dot>
          {open ? 'Abierta' : item.status === 'answered' ? 'Respondida' : item.status === 'expired' ? 'Vencida' : 'Rechazada'}
        </Chip>
        <Link to="/solicitudes/$id" params={{ id: item.application_id }} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] font-medium hover:bg-sunken">
          Solicitud <Icon name="arrow" size={13} />
        </Link>
      </div>
    </header>
  )
}

interface ClarificationCardFooterProps {
  open: boolean
  ready: boolean
  isPending: boolean
  answeredAt?: string | null
  answeredBy?: string | null
  onDeclineAll: () => void
  onSend: () => void
}

function ClarificationCardFooter({ open, ready, isPending, answeredAt, answeredBy, onDeclineAll, onSend }: ClarificationCardFooterProps) {
  if (open) {
    return (
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sunken/60 px-6 py-4">
        <p className="text-[12.5px] text-muted">{ready ? 'Todo listo para enviar.' : 'Contesta cada pregunta o márcala sin respuesta.'}</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={isPending} onClick={onDeclineAll}>
            Declinar todo y seguir
          </Button>
          <Button variant="accent" size="sm" disabled={!ready || isPending} onClick={onSend}>
            {isPending ? 'Enviando…' : 'Responder a nombre del proveedor'}
          </Button>
        </div>
      </footer>
    )
  }
  if (!answeredAt) return null
  return (
    <footer className="border-t border-line px-6 py-3 text-[12.5px] text-muted">
      Respondida {dateTime(answeredAt)} {answeredBy ? `por ${answeredBy} (analista)` : 'por el proveedor'}
    </footer>
  )
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
  const clear = (id: string) => { setDrafts((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== id))) }

  return (
    <article className="card overflow-hidden" aria-labelledby={`c-${item.id}`}>
      <ClarificationCardHeader item={item} open={open} showSupplier={showSupplier} />

      {open && item.channel === 'manual' ? (
        <p className="mx-6 mt-4 flex items-start gap-2.5 rounded-2xl bg-sunken px-4 py-3 text-[13px] text-ink-2">
          <Icon name="chat" size={16} className="mt-0.5 shrink-0" />
          {manualReason(item.questions)} Responde tú a nombre del proveedor: quedará registrado con tu usuario.
        </p>
      ) : null}

      <ol className="space-y-3 px-6 pb-6 pt-4">
        {item.questions.map((q, i) => (
          <QuestionItem
            key={q.id}
            q={q}
            index={i}
            draft={drafts[q.id]}
            given={item.answers.find((a) => a.question_id === q.id)}
            open={open}
            channel={item.channel}
            onSetDraft={set}
            onClearDraft={clear}
          />
        ))}
      </ol>

      <ClarificationCardFooter
        open={open}
        ready={ready}
        isPending={send.isPending}
        answeredAt={item.answered_at}
        answeredBy={item.answered_by}
        onDeclineAll={() => { send.mutate(item.questions.map((q) => ({ question_id: q.id, kind: 'decline', note: null }))) }}
        onSend={() => { send.mutate(answers.filter((a): a is OwnerAnswer => a !== null)) }}
      />
    </article>
  )
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-[12px] text-coral-ink">{error}</span> : hint ? <span className="mt-1 block text-[12px] text-muted">{hint}</span> : null}
    </label>
  )
}

/**
 * Why a clarification was left to answer by hand. The worker sends it over WhatsApp or email only
 * if some questions are answerable by chat (deposits, charges, main customer, account use) and the
 * supplier has a verified contact (`DbClarificationChannel`); without those, the reason is the
 * question type, not the contact.
 */
const CHAT_KINDS: ReadonlySet<Question['kind']> = new Set(['deposit', 'charge', 'buyer', 'account_use'])

function manualReason(questions: readonly Question[]): string {
  if (!questions.some((q) => CHAT_KINDS.has(q.kind))) {
    const kinds = new Set(questions.map((q) => q.kind))
    const what = kinds.has('identity') && kinds.has('documents') ? 'de identidad y de documentos' : kinds.has('identity') ? 'de identidad' : 'de documentos'
    return `Esta aclaración no se manda por WhatsApp ni por correo: las preguntas ${what} no se le hacen al proveedor por chat y las revisa un analista.`
  }
  return 'Esta aclaración no salió por WhatsApp ni por correo porque el proveedor no tiene un contacto verificado.'
}

/** Fields an identity question asks for (`pedir` data); without it, name and RFC. */
function askedFields(facts: readonly { name: string; value: unknown }[]): ReadonlySet<string> {
  const fact = facts.find((f) => f.name === 'pedir')
  return new Set(typeof fact?.value === 'string' && fact.value ? fact.value.split(',') : ['name', 'rfc'])
}

function IdentityFields({ d, ask, onChange }: { d: Extract<Draft, { kind: 'identity' }>; ask: ReadonlySet<string>; onChange: (d: Draft) => void }) {
  const rfc = d.rfc.trim() ? checkRfc(d.rfc.trim()).result : null
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {ask.has('name') ? (
        <div className="sm:col-span-2">
          <Field label="Razón social o nombre del titular">
            <input value={d.legal_name} onChange={(e) => { onChange({ ...d, legal_name: e.target.value }) }} className="input" autoComplete="off" />
          </Field>
        </div>
      ) : null}
      {ask.has('rfc') ? (
        <Field label="RFC" error={rfc === 'invalid' ? 'El RFC no tiene un formato válido' : null}>
          <input value={d.rfc} onChange={(e) => { onChange({ ...d, rfc: e.target.value.toUpperCase() }) }} className="input font-mono uppercase" autoComplete="off" maxLength={13} aria-invalid={rfc === 'invalid'} />
        </Field>
      ) : null}
    </div>
  )
}

function formatGivenAnswerText(a: OwnerAnswer): string {
  if (a.kind === 'deposit' || a.kind === 'charge') {
    const cat = CATEGORY_LABEL[a.category] ?? OPTION_LABEL[a.category] ?? a.category
    return a.counterparty ? `${cat} · ${a.counterparty}` : cat
  }
  if (a.kind === 'account_use') return OPTION_LABEL[a.use] ?? a.use
  if (a.kind === 'buyer') return a.name
  if (a.kind === 'identity') return [a.legal_name, a.rfc, a.clabe].filter(Boolean).join(' · ') || 'Sin datos'
  if (a.kind === 'decline') return `Sin respuesta${a.note ? `: ${a.note}` : ''}`
  return 'Documentos enviados'
}

function Given({ a }: { a: OwnerAnswer | undefined }) {
  if (!a) return <p className="mt-3 text-[13px] text-muted">Sin respuesta todavía.</p>
  return (
    <p className="mt-3 inline-flex max-w-full items-center gap-2 rounded-2xl bg-accent-soft px-3.5 py-2 text-[13.5px] font-medium text-accent-ink">
      <Icon name="check" size={15} className="shrink-0" />
      <span className="truncate">{formatGivenAnswerText(a)}</span>
    </p>
  )
}
