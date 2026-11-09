/**
 * Form to correct one value. The PDF stays alongside on the page where the value was read; this
 * only builds the correction, which is saved with the others on re-evaluation. A movement is
 * corrected whole (amount, direction, date) because a broken balance is usually one of the three.
 */
import { checkCorrectionValue, correctionValueKind, type CorrectionTarget } from '@gow/contracts'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { money } from '../../lib/format'
import { Button, Modal } from '../../ui/primitives'
import type { EditSpec, PendingFix } from './focus'

const HOLDER_TYPES = [
  ['legal_entity', 'Persona moral'],
  ['individual_with_business_activity', 'Persona física con actividad empresarial'],
  ['individual', 'Persona física'],
] as const

interface Candidate {
  target: CorrectionTarget
  value: string | number
  read: string | number | null
  label: string
}

function show(v: string | number | null, kind: ReturnType<typeof correctionValueKind>): string {
  if (v === null) return 'sin dato'
  return kind === 'money' || kind === 'signed_money' ? money(Number(v)) : String(v)
}

function buildCandidates(
  spec: EditSpec,
  value: string,
  amount: string,
  type: 'credit' | 'debit',
  day: string,
): Candidate[] {
  const tx = spec.tx
  if (tx) {
    return [
      { target: { kind: 'transaction', transaction_id: tx.id, field: 'amount' }, value: amount.trim(), read: tx.amount, label: `${spec.label}: monto` },
      { target: { kind: 'transaction', transaction_id: tx.id, field: 'type' }, value: type, read: tx.type, label: `${spec.label}: sentido` },
      { target: { kind: 'transaction', transaction_id: tx.id, field: 'date' }, value: day, read: tx.date, label: `${spec.label}: fecha` },
    ]
  }
  return [{ target: spec.target, value: value.trim(), read: spec.current, label: spec.label }]
}

function evaluateCandidates(candidates: Candidate[]) {
  const filtered = candidates.filter((c) => String(c.value) !== String(c.read ?? ''))
  const errors = filtered.map((c) => (String(c.value).length === 0 ? 'No puede ir vacío' : checkCorrectionValue(c.target, c.value)))
  const error = errors.find((e) => e !== null) ?? null
  const ready = filtered.length > 0 && error === null
  return { candidates: filtered, error, ready }
}

interface SingleFieldEditorProps {
  current: string | number | null
  kind: ReturnType<typeof correctionValueKind>
  value: string
  error: string | null
  onChange: (v: string) => void
}

function SingleFieldEditor({ current, kind, value, error, onChange }: SingleFieldEditorProps) {
  return (
    <div className="mt-4 space-y-4">
      <div className="inner px-4 py-3 text-[13.5px]">
        <span className="text-muted">Se leyó: </span>
        <strong className="tnum font-medium">{show(current, kind)}</strong>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Valor correcto</span>
        {kind === 'holder_type' ? (
          <select className="input" value={value} onChange={(e) => { onChange(e.target.value) }}>
            {HOLDER_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={clsx('input', (kind === 'text' || kind === 'date') && 'font-mono')}
            type={kind === 'date' ? 'date' : 'text'}
            inputMode={kind === 'money' || kind === 'signed_money' ? 'decimal' : kind === 'count' ? 'numeric' : undefined}
            value={value}
            onChange={(e) => { onChange(e.target.value) }}
            autoComplete="off"
            aria-invalid={error !== null && value.trim() !== ''}
            autoFocus
          />
        )}
      </label>
    </div>
  )
}

interface TransactionFieldsEditorProps {
  tx: NonNullable<EditSpec['tx']>
  amount: string
  type: 'credit' | 'debit'
  day: string
  onChangeAmount: (v: string) => void
  onChangeType: (v: 'credit' | 'debit') => void
  onChangeDay: (v: string) => void
}

function TransactionFieldsEditor({
  tx,
  amount,
  type,
  day,
  onChangeAmount,
  onChangeType,
  onChangeDay,
}: TransactionFieldsEditorProps) {
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Monto (se leyó {money(tx.amount)})</span>
        <input className="input tnum" inputMode="decimal" value={amount} onChange={(e) => { onChangeAmount(e.target.value) }} autoComplete="off" autoFocus />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Fecha</span>
        <input className="input font-mono" type="date" value={day} onChange={(e) => { onChangeDay(e.target.value) }} />
      </label>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1.5 text-[12.5px] font-medium text-ink-2">Sentido</legend>
        <div role="radiogroup" className="flex gap-1.5">
          {(['credit', 'debit'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => { onChangeType(t) }} className={clsx('h-10 rounded-full px-5 text-[13.5px] font-medium transition-colors', type === t ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
              {t === 'credit' ? 'Abono (entra)' : 'Cargo (sale)'}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

export function CorrectionModal({ spec, onClose, onAdd }: { spec: EditSpec | null; onClose: () => void; onAdd: (fixes: PendingFix[]) => void }) {
  const [value, setValue] = useState('')
  const [amount, setAmount] = useState('')
  const [type, setType] = useState<'credit' | 'debit'>('credit')
  const [day, setDay] = useState('')

  useEffect(() => {
    if (!spec) return
    setValue(spec.current === null ? '' : String(spec.current))
    if (spec.tx) {
      setAmount(String(spec.suggestedAmount ?? spec.tx.amount))
      setType(spec.tx.type)
      setDay(spec.tx.date)
    }
  }, [spec])

  if (!spec) return <Modal open={false} onClose={onClose} title="Corregir valor">{null}</Modal>

  const kind = correctionValueKind(spec.target)
  const tx = spec.tx
  const all = buildCandidates(spec, value, amount, type, day)
  const { candidates, error, ready } = evaluateCandidates(all)

  const submit = () => {
    if (!ready) return
    onAdd(candidates.map((c) => ({ target: c.target, value: correctionValueKind(c.target) === 'money' || correctionValueKind(c.target) === 'signed_money' || correctionValueKind(c.target) === 'count' ? Number(String(c.value).replace(/[$,\s]/g, '')) : String(c.value), page: spec.page, read: c.read, label: c.label })))
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={`Corregir ${spec.label}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <p className="text-[13.5px] leading-relaxed text-muted">
          {spec.page ? `El PDF está en la página ${String(spec.page)}. ` : ''}Compáralo con lo que dice la extracción y escribe lo correcto.
        </p>
        {spec.hint ? (
          <p className="mt-3 rounded-2xl bg-amber-soft px-3.5 py-2.5 text-[13px] leading-snug text-amber-ink">
            {spec.hint}
            {tx && spec.suggestedAmount != null ? ` El monto ya trae ${money(spec.suggestedAmount)}, el que lo hace cuadrar; confírmalo en el PDF antes de agregarlo.` : ''}
          </p>
        ) : null}
        {!tx ? (
          <SingleFieldEditor current={spec.current} kind={kind} value={value} error={error} onChange={setValue} />
        ) : (
          <TransactionFieldsEditor
            tx={tx}
            amount={amount}
            type={type}
            day={day}
            onChangeAmount={setAmount}
            onChangeType={setType}
            onChangeDay={setDay}
          />
        )}
        {error && candidates.length > 0 ? (
          <p role="alert" className="mt-3 rounded-2xl bg-coral-soft px-3.5 py-2 text-[12.5px] text-coral-ink">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="accent" disabled={!ready}>
            Agregar a las correcciones
          </Button>
        </div>
      </form>
    </Modal>
  )
}
