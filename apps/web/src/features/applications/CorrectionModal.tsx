/**
 * Formulario de corrección de un valor (docs/08 §2). El PDF queda al lado en la página donde se leyó
 * el valor; aquí solo se arma la corrección: se guarda junto con las demás al reevaluar. Un
 * movimiento se corrige completo (monto, sentido y fecha) porque un cuadre roto suele ser uno de los tres.
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

export function CorrectionModal({ spec, onClose, onAdd }: { spec: EditSpec | null; onClose: () => void; onAdd: (fixes: PendingFix[]) => void }) {
  const [value, setValue] = useState('')
  const [amount, setAmount] = useState('')
  const [type, setType] = useState<'credit' | 'debit'>('credit')
  const [day, setDay] = useState('')

  useEffect(() => {
    if (!spec) return
    setValue(spec.current === null ? '' : String(spec.current))
    if (spec.tx) {
      setAmount(String(spec.tx.amount))
      setType(spec.tx.type)
      setDay(spec.tx.date)
    }
  }, [spec])

  if (!spec) return <Modal open={false} onClose={onClose} title="Corregir valor">{null}</Modal>

  const single = spec.target
  const kind = correctionValueKind(single)
  const tx = spec.tx

  // Lo que se va a agregar y su error, si lo hay.
  const all: Candidate[] = tx
    ? [
        { target: { kind: 'transaction', transaction_id: tx.id, field: 'amount' }, value: amount.trim(), read: tx.amount, label: `${spec.label}: monto` },
        { target: { kind: 'transaction', transaction_id: tx.id, field: 'type' }, value: type, read: tx.type, label: `${spec.label}: sentido` },
        { target: { kind: 'transaction', transaction_id: tx.id, field: 'date' }, value: day, read: tx.date, label: `${spec.label}: fecha` },
      ]
    : [{ target: single, value: value.trim(), read: spec.current, label: spec.label }]
  const candidates = all.filter((c) => String(c.value) !== String(c.read ?? ''))
  const errors = candidates.map((c) => (String(c.value).length === 0 ? 'No puede ir vacío' : checkCorrectionValue(c.target, c.value)))
  const error = errors.find((e) => e !== null) ?? null
  const ready = candidates.length > 0 && error === null

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
        {!tx ? (
          <div className="mt-4 space-y-4">
            <div className="inner px-4 py-3 text-[13.5px]">
              <span className="text-muted">Se leyó: </span>
              <strong className="tnum font-medium">{show(spec.current, kind)}</strong>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Valor correcto</span>
              {kind === 'holder_type' ? (
                <select className="input" value={value} onChange={(e) => { setValue(e.target.value) }}>
                  {HOLDER_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <input className={clsx('input', (kind === 'text' || kind === 'date') && 'font-mono')} type={kind === 'date' ? 'date' : 'text'} inputMode={kind === 'money' || kind === 'signed_money' ? 'decimal' : kind === 'count' ? 'numeric' : undefined} value={value} onChange={(e) => { setValue(e.target.value) }} autoComplete="off" aria-invalid={error !== null && value.trim() !== ''} autoFocus />
              )}
            </label>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Monto (se leyó {money(tx.amount)})</span>
              <input className="input tnum" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value) }} autoComplete="off" autoFocus />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Fecha</span>
              <input className="input font-mono" type="date" value={day} onChange={(e) => { setDay(e.target.value) }} />
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-[12.5px] font-medium text-ink-2">Sentido</legend>
              <div role="radiogroup" className="flex gap-1.5">
                {(['credit', 'debit'] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => { setType(t) }} className={clsx('h-10 rounded-full px-5 text-[13.5px] font-medium transition-colors', type === t ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}>
                    {t === 'credit' ? 'Abono (entra)' : 'Cargo (sale)'}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
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
