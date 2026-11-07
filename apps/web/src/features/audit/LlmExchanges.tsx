import clsx from 'clsx'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { LlmExchangeDetail, LlmExchangeRow } from '@gow/contracts'
import { dateTime, number } from '../../lib/format'
import { useLlmExchange, useLlmExchanges } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, Chip, EmptyState, ErrorState, Modal, Skeleton, TableSkeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

/** Para qué se llamó al modelo (ADR 0064); lo que no esté aquí se muestra tal cual. */
const PURPOSE: Record<string, string> = {
  classify: 'Clasificar el documento',
  classify_transactions: 'Clasificar movimientos',
  double_read: 'Doble lectura',
  interpret_reply: 'Leer una respuesta del proveedor',
}

function purposeLabel(p: string): string {
  if (PURPOSE[p]) return PURPOSE[p]
  if (p.startsWith('extraction.')) return `Extracción · ${p.slice('extraction.'.length).replace(/_/g, ' ')}`
  return p.replace(/_/g, ' ')
}

const usd = (n: number) => (n === 0 ? '—' : `$${n.toFixed(n < 0.01 ? 4 : 3)}`)
const seconds = (ms: number) => (ms === 0 ? '—' : `${(ms / 1000).toFixed(1)} s`)

function tokens(x: LlmExchangeRow): string {
  if (!x.usage) return '—'
  const input = x.usage.input_tokens + x.usage.cache_read_input_tokens + x.usage.cache_creation_input_tokens
  return `${number(input)} → ${number(x.usage.output_tokens)}`
}

function Outcome({ x }: { x: LlmExchangeRow }) {
  if (x.outcome === 'error') return <Chip tone="coral" dot>{x.error_code ?? 'error'}</Chip>
  if (x.response_cache_hit) return <Chip tone="plain" dot>De caché</Chip>
  return <Chip tone="lime" dot>Bien</Chip>
}

type Search = { tab?: string; solicitud?: string; resultado?: string; ver?: string }

export function LlmExchanges() {
  const search = useSearch({ from: '/shell/bitacora' })
  const navigate = useNavigate({ from: '/bitacora' })
  const set = (patch: Partial<Search>) => void navigate({ search: (s: Search) => ({ ...s, ...patch }), replace: true })
  const onlyErrors = search.resultado === 'error'
  const { data, isPending, isError, error, refetch } = useLlmExchanges({ ...(search.solicitud ? { application_id: search.solicitud } : {}), ...(onlyErrors ? { outcome: 'error' as const } : {}) })

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Resultado" className="flex gap-1.5">
          {[
            { key: undefined, label: 'Todas' },
            { key: 'error', label: 'Con error' },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={search.resultado === o.key}
              onClick={() => { set({ resultado: o.key }) }}
              className={clsx('h-9 rounded-full px-4 text-[13.5px] font-medium transition-colors', search.resultado === o.key ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
            >
              {o.label}
            </button>
          ))}
        </div>
        {search.solicitud ? (
          <span className="inline-flex h-9 items-center gap-2 rounded-full bg-indigo-soft pl-4 pr-1.5 text-[13px] text-indigo-ink">
            <Link to="/solicitudes/$id" params={{ id: search.solicitud }} className="font-medium underline-offset-2 hover:underline">
              Solicitud <span className="font-mono">{search.solicitud.slice(0, 8)}</span>
            </Link>
            <button type="button" aria-label="Quitar filtro de solicitud" onClick={() => { set({ solicitud: undefined }) }} className="grid size-6 place-items-center rounded-full hover:bg-white/60">
              <Icon name="x" size={13} />
            </button>
          </span>
        ) : null}
      </div>

      <Card rise={0} className="overflow-hidden pb-2">
        {isError ? (
          <ErrorState message={error.message} onRetry={() => void refetch()} />
        ) : isPending ? (
          <TableSkeleton />
        ) : data.length === 0 ? (
          <EmptyState icon="bolt" title={onlyErrors ? 'Sin llamadas con error' : 'Sin llamadas al modelo'}>
            Cada prompt y cada respuesta del modelo queda aquí tal cual, para revisar un caso.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13.5px]">
              <caption className="sr-only">Últimas llamadas al modelo del tenant</caption>
              <thead>
                <tr className="text-[12px] uppercase tracking-wide text-muted">
                  <th scope="col" className="px-7 py-4 font-medium">Cuándo</th>
                  <th scope="col" className="px-3 py-4 font-medium">Para qué</th>
                  <th scope="col" className="px-3 py-4 font-medium">Modelo</th>
                  <th scope="col" className="px-3 py-4 font-medium">Resultado</th>
                  <th scope="col" className="px-3 py-4 text-right font-medium">Tokens</th>
                  <th scope="col" className="px-3 py-4 text-right font-medium">Costo</th>
                  <th scope="col" className="px-3 py-4 text-right font-medium">Tiempo</th>
                  <th scope="col" className="px-7 py-4 font-medium">Sobre</th>
                </tr>
              </thead>
              <tbody>
                {data.map((x) => (
                  <tr key={x.id} className="cursor-pointer border-t border-line/70 transition-colors hover:bg-sunken/60" onClick={() => { set({ ver: x.id }) }}>
                    <td className="tnum whitespace-nowrap px-7 py-3 text-muted">
                      <button type="button" className="text-left underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); set({ ver: x.id }) }}>
                        {dateTime(x.at)}
                      </button>
                    </td>
                    <td className="px-3 py-3 font-medium">{purposeLabel(x.purpose)}</td>
                    <td className="px-3 py-3 font-mono text-[12px] text-ink-2">{x.model}</td>
                    <td className="px-3 py-3"><Outcome x={x} /></td>
                    <td className="tnum whitespace-nowrap px-3 py-3 text-right text-ink-2">{tokens(x)}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-2">{usd(x.cost_usd)}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-2">{seconds(x.latency_ms)}</td>
                    <td className="px-7 py-3 font-mono text-[12px] text-muted">
                      {x.application_id ? (
                        <button type="button" className="underline-offset-2 hover:underline" title="Ver solo las llamadas de esta solicitud" onClick={(e) => { e.stopPropagation(); set({ solicitud: x.application_id ?? undefined }) }}>
                          {x.application_id.slice(0, 8)}
                        </button>
                      ) : x.inbound_message_id ? (
                        <span title="Mensaje entrante">msj {x.inbound_message_id.slice(0, 8)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ExchangeModal id={search.ver} onClose={() => { set({ ver: undefined }) }} />
    </>
  )
}

function pretty(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function CopyButton({ value, label = 'Copiar' }: { value: string; label?: string }) {
  const toast = useToast()
  return (
    <Button
      size="sm"
      variant="quiet"
      onClick={(e) => {
        // Dentro del encabezado de un <details>: copiar no lo pliega.
        e.preventDefault()
        e.stopPropagation()
        void navigator.clipboard.writeText(value).then(
          () => { toast.ok('Copiado') },
          () => { toast.error('No se pudo copiar; selecciónalo a mano') },
        )
      }}
    >
      <Icon name="copy" size={14} /> {label}
    </Button>
  )
}

function Block({ title, value, open = false, tone }: { title: string; value: string; open?: boolean; tone?: 'coral' }) {
  return (
    <details open={open} className={clsx('group rounded-2xl', tone === 'coral' ? 'bg-coral-soft' : 'bg-sunken')}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[14px] font-medium">
        <span className="flex items-center gap-2">
          <Icon name="right" size={15} className="transition-transform group-open:rotate-90" />
          {title}
          <span className="tnum text-[12px] font-normal text-muted">{number(value.length)} caracteres</span>
        </span>
        <CopyButton value={value} />
      </summary>
      <pre className="scroll-thin max-h-[48dvh] overflow-auto whitespace-pre-wrap break-words px-4 pb-4 font-mono text-[12px] leading-relaxed text-ink-2">{value}</pre>
    </details>
  )
}

function download(x: LlmExchangeDetail) {
  const blob = new Blob([`${JSON.stringify(x, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `llm-${x.purpose}-${x.id.slice(0, 8)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function ExchangeModal({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const { data: x, isPending, isError, error } = useLlmExchange(id)
  return (
    <Modal open={Boolean(id)} onClose={onClose} title={x ? purposeLabel(x.purpose) : 'Llamada al modelo'} wide>
      {isError ? (
        <ErrorState message={error.message} />
      ) : isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : (
        <ExchangeBody x={x} onClose={onClose} />
      )}
    </Modal>
  )
}

function ExchangeBody({ x, onClose }: { x: LlmExchangeDetail; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <div className="hatch-amber rounded-2xl px-4 py-3 text-[13px] leading-relaxed text-amber-ink">
        Prompt y respuesta tal cual: llevan datos del documento. Abrir este detalle queda en la bitácora.
      </div>
      <Meta x={x} />
      <div className="space-y-2">
        {x.error_message ? <Block title="Error" value={x.error_message} open tone="coral" /> : null}
        {x.response !== null && x.response !== undefined ? <Block title="Respuesta" value={pretty(x.response)} open /> : null}
        {x.raw_output ? <Block title="Salida cruda del modelo" value={x.raw_output} open={x.outcome === 'error'} /> : null}
        <Block title="Instrucción" value={x.instruction} />
        <Block title="System prompt" value={x.system} />
      </div>
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <CopyButton value={JSON.stringify(x, null, 2)} label="Copiar todo (JSON)" />
        <Button size="sm" variant="ghost" onClick={() => { download(x) }}>
          <Icon name="down" size={14} /> Descargar .json
        </Button>
        <Button size="sm" onClick={onClose}>Listo</Button>
      </div>
    </div>
  )
}

const mono = (text: string) => <span className="font-mono text-[12px]">{text}</span>

function Subject({ x }: { x: LlmExchangeDetail }) {
  if (x.application_id) {
    return (
      <Link to="/solicitudes/$id" params={{ id: x.application_id }} className="font-mono text-[12px] text-indigo-ink underline-offset-2 hover:underline">
        Solicitud {x.application_id.slice(0, 8)}
      </Link>
    )
  }
  return x.inbound_message_id ? mono(`Mensaje ${x.inbound_message_id.slice(0, 8)}`) : <>—</>
}

function Meta({ x }: { x: LlmExchangeDetail }) {
  const providerCache = x.usage ? `${number(x.usage.cache_read_input_tokens)} leídos · ${number(x.usage.cache_creation_input_tokens)} escritos` : '—'
  const items: [string, ReactNode][] = [
    ['Cuándo', dateTime(x.at)],
    ['Resultado', <Outcome key="o" x={x} />],
    ['Modelo', mono(x.model)],
    ['Esquema', mono(x.schema_name)],
    ['Prompt', mono(x.prompt_version)],
    ['Effort · tope', `${x.effort} · ${number(x.max_output_tokens)} tokens`],
    ['Fin', x.finish_reason ?? '—'],
    ['Tokens (entrada → salida)', tokens(x)],
    ['Caché del proveedor', providerCache],
    ['Costo', usd(x.cost_usd)],
    ['Tiempo', seconds(x.latency_ms)],
    ['Fallback del servidor', x.server_fallback ? 'Sí' : 'No'],
    ['PDF (sha256)', <span key="d" className="font-mono text-[11.5px]" title={x.document_sha256 ?? undefined}>{x.document_sha256 ? `${x.document_sha256.slice(0, 16)}…` : 'Sin documento'}</span>],
    ['Sobre', <Subject key="s" x={x} />],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[12px] text-muted">{k}</dt>
          <dd className="mt-0.5 truncate">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
