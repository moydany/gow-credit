/**
 * The policy as a form: the same document as the JSON view, field by field, in words. It edits the
 * parsed JSON and hands back a new document; the page keeps the text in sync and validates it with
 * the engine's schema, so both views always show the same policy. Adding new gates or caps, or
 * other rules the form does not show, stays in the JSON view.
 */
import { FEATURE_CATALOG, type FeatureName } from '@gow/contracts'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { DECISION_LABEL } from '../../lib/format'
import { Icon } from '../../ui/icons'

/** The document as JSON: the form only touches the fields it shows and keeps the rest as is. */
export type PolicyDoc = Record<string, unknown>

interface Condition {
  feature: string
  op: string
  value?: unknown
}
interface Gate {
  id: string
  description?: string
  when: Condition
  onFail: { status: string; ask?: string }
}
interface Dimension {
  id: string
  weight: number
  feature: string
  zeroAt: number
  fullAt: number
  inverse?: boolean
}
interface Band {
  min: number
  status: string
  limit?: { pctOf: string; pct: number }
}
interface Cap {
  when: Condition
  maxStatus: string
}

/** Short names for the features policies use most; the rest use the catalog's description. */
const SHORT: Partial<Record<FeatureName, string>> = {
  document_age_days: 'Días desde el corte del estado de cuenta',
  document_pages_missing: 'Faltan páginas en el estado de cuenta',
  integrity_ok: 'El estado de cuenta cuadra',
  red_flags: 'Señales graves (sobregiro, embargo…)',
  document_tamper_signals: 'Señales de documento alterado',
  existing_exposure_days_past_due: 'Días de atraso con esta institución',
  operating_income_monthly: 'Ingreso operativo mensual',
  buyer_payments_count: 'Pagos del comprador',
  payment_capacity_pct: 'Capacidad de pago (flujo libre / ingreso)',
  debt_service_monthly: 'Pagos a créditos al mes',
  recurring_income_share: 'Ingreso recurrente',
  months_of_history: 'Meses seguidos de historia',
  identity_match: 'Identidad del titular',
  holder_address_present: 'Trae el domicilio del titular',
}

export function featureLabel(name: string): string {
  return SHORT[name as FeatureName] ?? (FEATURE_CATALOG as Record<string, { description: string } | undefined>)[name]?.description ?? name
}

const OP: Record<string, string> = { '<': 'menor a', '<=': 'a lo más', '>': 'mayor a', '>=': 'al menos', '==': 'igual a', '!=': 'distinto de', in: 'uno de', not_in: 'ninguno de', empty: 'vacío', not_empty: 'no vacío' }
const FAIL: Record<string, string> = { needs_clarification: 'Pide aclaración al proveedor', human_review: 'Pasa a revisión humana', not_qualified: 'No califica' }

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const numberOr = (text: string, fallback: number) => {
  const n = Number(text)
  return text.trim() === '' || !Number.isFinite(n) ? fallback : n
}

export function PolicyForm({ doc, onChange }: { doc: PolicyDoc; onChange: (next: PolicyDoc) => void }) {
  const set = (key: string, value: unknown) => { onChange({ ...doc, [key]: value }) }
  const score = asObject(doc.score)
  const decision = asObject(doc.decision)
  const clarification = asObject(doc.clarification)
  const gates = asArray<Gate>(doc.gates)
  const dims = asArray<Dimension>(score.dimensions)
  const bands = asArray<Band>(decision.bands)
  const caps = asArray<Cap>(decision.caps)
  const months = asObject(doc.history).months === 3 ? 3 : 1
  const weights = dims.reduce((s, d) => s + (Number.isFinite(d.weight) ? d.weight : 0), 0)

  return (
    <div className="space-y-4">
      <Section title="Meses que se evalúan" hint="Con tres, si faltan meses o hay un hueco se le piden al proveedor; por WhatsApp los manda juntos.">
        <div role="radiogroup" aria-label="Meses que se evalúan" className="flex flex-wrap gap-2">
          {([1, 3] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => { set('history', { months: m }) }} className={clsx('rounded-full border px-4 py-2 text-[13.5px] font-medium', months === m ? 'border-ink bg-ink text-white' : 'border-line bg-card hover:bg-sunken')}>
              {m === 1 ? 'Un mes, el más reciente' : 'Tres meses seguidos'}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Compuertas" hint="Se revisan antes del puntaje. Si una no se cumple, la solicitud se detiene como dice su efecto.">
        <ul className="space-y-2">
          {gates.map((g, i) => (
            <Row key={g.id} onRemove={() => { set('gates', gates.filter((_, j) => j !== i)) }} removeLabel={`Quitar la compuerta ${g.id}`}>
              <p className="text-[13.5px] font-medium">{g.description ?? featureLabel(g.when.feature)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                <span>{featureLabel(g.when.feature)} {OP[g.when.op] ?? g.when.op}</span>
                {typeof g.when.value === 'number' ? (
                  <NumberInput label={`Valor de ${g.id}`} value={g.when.value} onChange={(v) => { set('gates', gates.map((x, j) => (j === i ? { ...x, when: { ...x.when, value: v } } : x))) }} />
                ) : g.when.value !== undefined ? (
                  <span className="font-medium text-ink-2">{formatValue(g.when.value)}</span>
                ) : null}
                <span aria-hidden="true">→</span>
                <span className="font-medium text-ink-2">{FAIL[g.onFail.status] ?? g.onFail.status}</span>
              </p>
            </Row>
          ))}
        </ul>
      </Section>

      <Section title="Puntaje" hint={`Cada dimensión suma de 0 a su peso: cero puntos en un valor, completos en otro. Los pesos suman ${String(weights)}${weights === 100 ? '.' : ' y deben sumar 100.'}`} warn={weights !== 100}>
        <div className="inner overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5 font-medium">Dimensión</th>
                <th className="px-2 py-2.5 font-medium">Peso</th>
                <th className="px-2 py-2.5 font-medium">Cero en</th>
                <th className="px-2 py-2.5 font-medium">Completo en</th>
              </tr>
            </thead>
            <tbody>
              {dims.map((d, i) => {
                const edit = (patch: Partial<Dimension>) => { set('score', { ...score, dimensions: dims.map((x, j) => (j === i ? { ...x, ...patch } : x)) }) }
                return (
                  <tr key={d.id} className="border-t border-line/70">
                    <td className="px-3 py-2">
                      <span className="font-medium">{featureLabel(d.feature)}</span>
                      {d.inverse ? <span className="block text-[12px] text-muted">menos es mejor</span> : null}
                    </td>
                    <td className="px-2 py-2"><NumberInput label={`Peso de ${d.id}`} value={d.weight} onChange={(v) => { edit({ weight: v }) }} /></td>
                    <td className="px-2 py-2"><NumberInput label={`Cero puntos de ${d.id}`} value={d.zeroAt} onChange={(v) => { edit({ zeroAt: v }) }} /></td>
                    <td className="px-2 py-2"><NumberInput label={`Puntos completos de ${d.id}`} value={d.fullAt} onChange={(v) => { edit({ fullAt: v }) }} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
          Confianza mínima para que un dato cuente
          <NumberInput label="Confianza mínima" value={Number(score.minConfidence ?? 0.7)} step={0.05} onChange={(v) => { set('score', { ...score, minConfidence: v }) }} />
        </label>
      </Section>

      <Section title="Bandas y línea" hint="El puntaje decide el estado; la línea es un porcentaje del ingreso operativo mensual.">
        <ul className="space-y-2">
          {bands.map((b, i) => {
            const edit = (patch: Partial<Band>) => { set('decision', { ...decision, bands: bands.map((x, j) => (j === i ? { ...x, ...patch } : x)) }) }
            return (
              <li key={`${b.status}-${String(i)}`} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line px-3.5 py-2.5 text-[13px]">
                <span className="text-muted">Desde</span>
                <NumberInput label={`Puntaje mínimo de ${b.status}`} value={b.min} onChange={(v) => { edit({ min: v }) }} />
                <span className="text-muted">puntos:</span>
                <span className="font-medium">{statusLabel(b.status)}</span>
                {b.limit ? (
                  <>
                    <span className="text-muted">con línea del</span>
                    <NumberInput label={`Porcentaje de línea de ${b.status}`} value={b.limit.pct} onChange={(v) => { edit({ limit: { pctOf: b.limit?.pctOf ?? 'operating_income_monthly', pct: v } }) }} />
                    <span className="text-muted">% de {featureLabel(b.limit.pctOf).toLowerCase()}</span>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="Topes" hint="Limitan el mejor estado posible aunque el puntaje dé más.">
        {caps.length === 0 ? <p className="text-[13px] text-muted">Sin topes.</p> : null}
        <ul className="space-y-2">
          {caps.map((c, i) => (
            <Row key={`${c.when.feature}-${String(i)}`} onRemove={() => { set('decision', { ...decision, caps: caps.filter((_, j) => j !== i) }) }} removeLabel={`Quitar el tope de ${c.when.feature}`}>
              <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                <span>Si {featureLabel(c.when.feature).toLowerCase()} es {OP[c.when.op] ?? c.when.op}</span>
                {typeof c.when.value === 'number' ? (
                  <NumberInput label={`Valor del tope de ${c.when.feature}`} value={c.when.value} onChange={(v) => { set('decision', { ...decision, caps: caps.map((x, j) => (j === i ? { ...x, when: { ...x.when, value: v } } : x)) }) }} />
                ) : c.when.value !== undefined ? <span className="font-medium">{formatValue(c.when.value)}</span> : null}
                <span>, a lo más</span>
                <span className="font-medium">{statusLabel(c.maxStatus)}</span>
              </p>
            </Row>
          ))}
        </ul>
      </Section>

      <Section title="Aclaraciones" hint="Cuántas rondas de preguntas al proveedor y desde qué tamaño se pregunta por un abono o cargo dudoso.">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-ink-2">
          <label className="flex items-center gap-2">
            Rondas
            <NumberInput label="Rondas de aclaración" value={Number(clarification.maxRounds ?? 2)} onChange={(v) => { set('clarification', { ...clarification, maxRounds: Math.round(v) }) }} />
          </label>
          <label className="flex items-center gap-2">
            Preguntar desde el
            <NumberInput label="Porcentaje del ingreso para preguntar" value={Number(clarification.askWhenAmountAbovePctOfIncome ?? 30)} onChange={(v) => { set('clarification', { ...clarification, askWhenAmountAbovePctOfIncome: v }) }} />
            % del ingreso del periodo
          </label>
        </div>
      </Section>
      <p className="text-[12.5px] text-muted">Para agregar compuertas o topes nuevos, o cambiar a qué dato miran, usa la vista JSON.</p>
    </div>
  )
}

/** The status in words; one the form does not know is shown as written. */
function statusLabel(status: string): string {
  return (DECISION_LABEL as Record<string, string | undefined>)[status] ?? status
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

function Section({ title, hint, warn, children }: { title: string; hint: string; warn?: boolean; children: ReactNode }) {
  return (
    <section className="rounded-[22px] border border-line px-5 py-4">
      <h3 className="text-[14.5px] font-medium">{title}</h3>
      <p className={clsx('mb-3 mt-0.5 text-[12.5px] leading-snug', warn ? 'text-coral-ink' : 'text-muted')}>{hint}</p>
      {children}
    </section>
  )
}

function Row({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel: string }) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-line px-3.5 py-2.5">
      <div className="min-w-0 flex-1">{children}</div>
      <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-sunken hover:text-ink">
        <Icon name="x" size={14} />
      </button>
    </li>
  )
}

function NumberInput({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <input
      type="number"
      aria-label={label}
      step={step ?? 'any'}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => { onChange(numberOr(e.target.value, value)) }}
      className="input tnum h-8 w-24 px-2.5 py-1 text-[13px]"
    />
  )
}
