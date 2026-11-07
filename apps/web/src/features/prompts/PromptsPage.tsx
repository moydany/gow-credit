/**
 * Prompts de los modelos (ADR 0065). Globales: los mismos para todas las instituciones crediticias.
 * Lista, versiones de un prompt, editor que guarda una versión nueva (nunca cambia una existente),
 * activación con confirmación y comparación entre dos versiones. Mismo patrón que Políticas.
 */
import { PROMPT_CATALOG, promptPlaceholders, unknownPlaceholders, type PromptDetail, type PromptName, type PromptSummary, type PromptVersionItem } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { usePrompt, usePromptDiff, usePrompts } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, Modal, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { PageTitle } from '../applications/ApplicationsPage'

const NO_EVALS = 'Sin evals'

/** Chip de la versión activa en la lista: del código, otra de archivo o editada en el backoffice. */
function ActiveChip({ active }: { active: PromptSummary['active'] }) {
  if (!active) return <Chip tone="hatch">Sin sembrar</Chip>
  if (active.is_code_default) return <Chip tone="plain">v{active.version} · del código</Chip>
  if (active.source === 'backoffice') return <Chip tone="amber" dot>v{active.version} · editada</Chip>
  return <Chip tone="indigo" dot>v{active.version} · otro archivo</Chip>
}

function SourceChips({ v }: { v: PromptVersionItem }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {v.active ? <Chip tone="accent" dot>Activa</Chip> : null}
      {v.source === 'file' ? <Chip tone="plain">prompts/ v{v.file_version}</Chip> : <Chip tone="amber">Backoffice</Chip>}
      {v.is_code_default ? <Chip tone="indigo">Del código</Chip> : null}
      {v.source === 'backoffice' ? <Chip tone="coral">{NO_EVALS}</Chip> : null}
    </span>
  )
}

export function PromptsPage() {
  const list = usePrompts()
  const search = useSearch({ from: '/shell/configuracion/prompts' })
  const navigate = useNavigate({ from: '/configuracion/prompts' })
  const name: PromptName | undefined = search.p && search.p in PROMPT_CATALOG ? (search.p as PromptName) : list.data?.prompts[0]?.name
  const select = (s: { p?: string; v?: string; cmp?: string }) => { void navigate({ search: s }) }

  return (
    <div>
      <PageTitle title="Prompts" muted={name ? PROMPT_CATALOG[name].title : undefined} />
      {list.isError ? (
        <Card>
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        </Card>
      ) : list.isPending ? (
        <Skeleton className="h-96 rounded-[28px]" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
          <PromptList prompts={list.data.prompts} current={name} canEdit={list.data.can_edit} onSelect={(p) => { select({ p }) }} />
          {name ? <PromptPanel name={name} v={search.v} cmp={search.cmp} onSelect={select} /> : null}
        </div>
      )}
    </div>
  )
}

/** Detalle de un prompt: encabezado, versiones, editor de la versión elegida y comparación. */
function PromptPanel({ name, v, cmp, onSelect }: { name: PromptName; v: string | undefined; cmp: string | undefined; onSelect: (s: { p?: string; v?: string; cmp?: string }) => void }) {
  const detail = usePrompt(name)
  if (detail.isError) {
    return (
      <Card>
        <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
      </Card>
    )
  }
  if (!detail.data) return <Skeleton className="h-96 rounded-[28px]" />
  const d = detail.data
  const selected = d.items.find((x) => x.id === v) ?? d.items.find((x) => x.active) ?? d.items[0]
  return (
    <div className="min-w-0 space-y-4">
      <PromptHeader d={d} />
      <Versions d={d} selected={selected} onSelect={(id) => { onSelect({ p: name, v: id }) }} />
      {selected ? <Editor key={selected.id} d={d} v={selected} onCreated={(id) => { onSelect({ p: name, v: id }) }} /> : null}
      <Compare d={d} selected={selected} cmp={cmp} onPick={(c) => { onSelect({ p: name, ...(selected ? { v: selected.id } : {}), cmp: c }) }} />
    </div>
  )
}

function PromptList({ prompts, current, canEdit, onSelect }: { prompts: PromptSummary[]; current: string | undefined; canEdit: boolean; onSelect: (name: string) => void }) {
  return (
    <Card rise={0} className="self-start pb-3">
      <CardHeader title="Prompts" subtitle="Globales: los mismos para todas las instituciones crediticias" />
      <ul className="mt-3 px-3">
        {prompts.map((p) => (
          <li key={p.name}>
            <button type="button" aria-current={current === p.name} onClick={() => { onSelect(p.name) }} className={clsx('flex w-full items-center justify-between gap-3 rounded-3xl px-4 py-3 text-left transition-colors', current === p.name ? 'bg-sunken' : 'hover:bg-sunken/60')}>
              <span className="min-w-0">
                <span className="block text-[14.5px] font-medium leading-snug">{p.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted">{p.name}</span>
              </span>
              <ActiveChip active={p.active} />
            </button>
          </li>
        ))}
      </ul>
      {!canEdit ? (
        <p className="mx-6 mt-3 flex gap-2 rounded-2xl bg-sunken p-3 text-[12.5px] leading-snug text-ink-2">
          <Icon name="shield" size={15} className="mt-0.5 shrink-0" />
          Solo lectura. Crear y activar versiones lo pueden los editores de prompts (BACKOFFICE_PROMPT_EDITORS), porque un cambio afecta a todas las instituciones.
        </p>
      ) : null}
    </Card>
  )
}

function PromptHeader({ d }: { d: PromptDetail }) {
  return (
    <Card rise={1} className="pb-5">
      <CardHeader title={d.title} subtitle={d.description} action={<ActiveChip active={d.active} />} />
      <dl className="mt-4 grid gap-x-6 gap-y-3 px-6 text-[13px] sm:grid-cols-3">
        <div>
          <dt className="text-muted">Modelo</dt>
          <dd className="mt-0.5 font-medium">{d.model}</dd>
        </div>
        <div>
          <dt className="text-muted">Variables que pasa el código</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">{d.variables.length ? d.variables.map((v) => <code key={v} className="rounded-lg bg-sunken px-1.5 py-0.5 font-mono text-[12px]">{`{{${v}}}`}</code>) : <span className="text-ink-2">ninguna</span>}</dd>
        </div>
        <div>
          <dt className="text-muted">Activa</dt>
          <dd className="mt-0.5">
            {d.active ? (
              <>
                <span className="font-medium">v{d.active.version}</span> <span className="font-mono text-[11.5px] text-muted">{d.active.prompt_id}</span>
                <span className="block text-[12px] text-muted">{d.active.activated_at ? `${dateTime(d.active.activated_at)} · ${d.active.activated_by ?? 'siembra desde prompts/'}` : ''}</span>
              </>
            ) : (
              'sin sembrar: corre pnpm db:migrate'
            )}
          </dd>
        </div>
      </dl>
      <p className="mx-6 mt-4 text-[12px] text-muted">El modo standalone y las evals usan siempre prompts/{d.name}.v{d.code_default_file_version}.md, sin base.</p>
    </Card>
  )
}

function Versions({ d, selected, onSelect }: { d: PromptDetail; selected: PromptVersionItem | undefined; onSelect: (id: string) => void }) {
  return (
    <Card rise={2} className="pb-3">
      <CardHeader title="Versiones" subtitle="Inmutables: editar crea una versión nueva; activar es otro paso" />
      <ul className="mt-3 px-3">
        {d.items.map((v) => (
          <li key={v.id}>
            <button type="button" aria-current={selected?.id === v.id} onClick={() => { onSelect(v.id) }} className={clsx('flex w-full flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-3xl px-4 py-3 text-left transition-colors', selected?.id === v.id ? 'bg-sunken' : 'hover:bg-sunken/60')}>
              <span className="min-w-0 flex-1 basis-60">
                <span className="block text-[14.5px] font-medium">Versión {v.version}</span>
                <span className="mt-0.5 block text-[13px] text-ink-2">{v.note}</span>
                <span className="mt-0.5 block text-[12px] text-muted">
                  {dateTime(v.created_at)} · {v.created_by ?? 'siembra desde prompts/'}
                </span>
              </span>
              <SourceChips v={v} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function useFail() {
  const toast = useToast()
  return (e: unknown) => { toast.error(e instanceof ApiError ? (e.issues[0] ? e.issues[0].message : e.message) : 'No se pudo completar') }
}

function Editor({ d, v, onCreated }: { d: PromptDetail; v: PromptVersionItem; onCreated: (id: string) => void }) {
  const toast = useToast()
  const fail = useFail()
  const qc = useQueryClient()
  const [text, setText] = useState(v.text)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setText(v.text) }, [v.id, v.text])
  const dirty = text.trim() !== v.text
  const unknown = unknownPlaceholders(d.name, text)
  const missing = d.variables.filter((x) => !promptPlaceholders(text).includes(x))
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['prompts'] }), qc.invalidateQueries({ queryKey: ['prompt', d.name] })])
  const create = useMutation({
    mutationFn: () => api.createPromptVersion(d.name, { text, note }),
    onSuccess: async (r) => {
      toast.ok(`Versión ${String(r.version)} guardada; no está activa todavía`)
      setNote('')
      await refresh()
      onCreated(r.id)
    },
    onError: fail,
  })
  const activate = useMutation({
    mutationFn: () => api.activatePromptVersion(d.name, v.id),
    onSuccess: async () => {
      setConfirm(false)
      toast.ok(`v${String(v.version)} activa: el worker la usa en unos segundos`)
      await refresh()
    },
    onError: fail,
  })

  return (
    <Card rise={3}>
      <CardHeader
        title={`Versión ${String(v.version)}`}
        subtitle={<span className="font-mono text-[12px]">{v.prompt_id}</span>}
        action={
          <Button size="sm" variant="accent" disabled={!d.can_edit || v.active || activate.isPending} onClick={() => { setConfirm(true) }}>
            {v.active ? 'Activa' : 'Activar esta versión'}
          </Button>
        }
      />
      {v.source === 'backoffice' ? (
        <p className="mx-6 mt-4 flex gap-2 rounded-2xl bg-amber-soft p-3 text-[12.5px] leading-snug text-amber-ink">
          <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
          Creada en el backoffice: no pasó por las evals del repositorio. Para medirla, llévala a prompts/{d.name}.v{d.code_default_file_version + 1}.md y corre pnpm eval.
        </p>
      ) : null}
      <div className="px-6 pb-2 pt-4">
        <label className="sr-only" htmlFor="prompt-text">
          Texto del prompt
        </label>
        <textarea id="prompt-text" spellCheck={false} readOnly={!d.can_edit} value={text} onChange={(e) => { setText(e.target.value) }} className="input scroll-thin h-96 resize-y font-mono text-[12.5px] leading-relaxed" aria-invalid={unknown.length > 0} aria-describedby="prompt-status" />
        <div id="prompt-status" className="mt-3 space-y-1.5" role="status">
          {unknown.length ? (
            <p className="rounded-2xl bg-coral-soft px-3.5 py-2 text-[12.5px] text-coral-ink">El código no pasa {unknown.map((u) => `{{${u}}}`).join(', ')}: quítalas o usa {d.variables.map((x) => `{{${x}}}`).join(', ') || 'ninguna'}.</p>
          ) : null}
          {missing.length ? <p className="rounded-2xl bg-sunken px-3.5 py-2 text-[12.5px] text-ink-2">No usa {missing.map((u) => `{{${u}}}`).join(', ')}: el modelo no recibirá ese dato.</p> : null}
          {!unknown.length && dirty ? <p className="flex items-center gap-2 text-[13px] font-medium text-accent-ink"><Icon name="check" size={15} /> Con cambios sin guardar</p> : null}
        </div>
      </div>
      {d.can_edit ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-4">
          <label className="sr-only" htmlFor="prompt-note">
            Qué cambió
          </label>
          <input id="prompt-note" className="input h-10 min-w-0 flex-1 basis-64" placeholder="Qué cambió y por qué" value={note} maxLength={500} onChange={(e) => { setNote(e.target.value) }} />
          <Button size="sm" variant="primary" disabled={!dirty || unknown.length > 0 || note.trim().length < 3 || create.isPending} onClick={() => { create.mutate() }}>
            <Icon name="plus" size={15} /> {create.isPending ? 'Guardando…' : 'Guardar como nueva versión'}
          </Button>
        </div>
      ) : null}
      <ActivateModal open={confirm} d={d} v={v} pending={activate.isPending} onClose={() => { setConfirm(false) }} onConfirm={() => { activate.mutate() }} />
    </Card>
  )
}

function ActivateModal({ open, d, v, pending, onClose, onConfirm }: { open: boolean; d: PromptDetail; v: PromptVersionItem; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Activar v${String(v.version)} de ${d.title}`}>
      <p className="text-[14.5px] leading-relaxed text-ink-2">
        Las llamadas al modelo de <strong className="font-medium text-ink">todas las instituciones crediticias</strong> usarán esta versión en cuanto el worker la recoja (unos 15 segundos). Lo ya procesado no cambia y las respuestas en caché de otra versión no se reutilizan. Queda en la bitácora con tu usuario.
      </p>
      {v.source === 'backoffice' ? (
        <p className="mt-4 flex gap-2 rounded-2xl bg-amber-soft p-3 text-[13px] leading-snug text-amber-ink">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          {NO_EVALS}: nadie midió esta versión contra el ground truth. Si baja la precisión, vuelve a activar la v{d.items.find((x) => x.is_code_default)?.version ?? d.code_default_file_version} del código.
        </p>
      ) : !v.is_code_default ? (
        <p className="mt-4 rounded-2xl bg-indigo-soft p-3 text-[13px] leading-snug text-indigo-ink">Es un archivo distinto del que usa el código (v{d.code_default_file_version}): el modo standalone y las evals siguen con ese.</p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="accent" disabled={pending} onClick={onConfirm}>
          {pending ? 'Activando…' : 'Activar'}
        </Button>
      </div>
    </Modal>
  )
}

/** Comparación: por defecto la versión elegida contra la activa (o contra la anterior si es la activa). */
function Compare({ d, selected, cmp, onPick }: { d: PromptDetail; selected: PromptVersionItem | undefined; cmp: string | undefined; onPick: (id: string) => void }) {
  const others = d.items.filter((x) => x.id !== selected?.id)
  const fallback = selected?.active ? d.items.find((x) => x.version < selected.version) : d.items.find((x) => x.active)
  const from = others.find((x) => x.id === cmp) ?? fallback ?? others[0]
  const diff = usePromptDiff(d.name, from?.id, selected?.id)
  if (!selected || !from) {
    return (
      <Card rise={4}>
        <EmptyState icon="list" title="Una sola versión">
          Cuando haya otra versión podrás compararlas línea por línea.
        </EmptyState>
      </Card>
    )
  }
  return (
    <Card rise={4} className="pb-5">
      <CardHeader
        title="Comparar"
        subtitle={diff.data ? `${String(diff.data.added)} líneas agregadas · ${String(diff.data.removed)} quitadas` : `v${String(from.version)} → v${String(selected.version)}`}
        action={
          <label className="flex items-center gap-2 text-[13px] text-muted">
            contra
            <select className="input h-9 w-auto pr-8 text-[13px]" value={from.id} onChange={(e) => { onPick(e.target.value) }}>
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  v{x.version}
                  {x.active ? ' (activa)' : ''}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <div className="px-6 pt-4">{diff.isError ? <ErrorState message={diff.error.message} /> : diff.data ? <DiffView lines={diff.data.lines} /> : <Skeleton className="h-40 rounded-2xl" />}</div>
    </Card>
  )
}

const CONTEXT = 2

function DiffView({ lines }: { lines: { op: 'same' | 'add' | 'del'; text: string }[] }) {
  if (!lines.some((l) => l.op !== 'same')) return <p className="rounded-2xl bg-sunken p-4 text-[13px] text-ink-2">Mismo texto.</p>
  // Solo los cambios con dos líneas de contexto; lo demás se resume.
  const keep = lines.map((_, i) => lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.op !== 'same'))
  const out: ({ kind: 'line'; op: 'same' | 'add' | 'del'; text: string; key: number } | { kind: 'gap'; count: number; key: number })[] = []
  lines.forEach((l, i) => {
    if (keep[i]) out.push({ kind: 'line', ...l, key: i })
    else {
      const last = out.at(-1)
      if (last?.kind === 'gap') last.count++
      else out.push({ kind: 'gap', count: 1, key: i })
    }
  })
  return (
    <pre className="scroll-thin max-h-[480px] overflow-auto rounded-2xl bg-sunken py-2 font-mono text-[12px] leading-relaxed">
      {out.map((x) =>
        x.kind === 'gap' ? (
          <div key={x.key} className="px-4 py-1 text-muted">
            ⋯ {x.count} {x.count === 1 ? 'línea igual' : 'líneas iguales'}
          </div>
        ) : (
          <div key={x.key} className={clsx('whitespace-pre-wrap px-4', x.op === 'add' && 'bg-accent-soft text-accent-ink', x.op === 'del' && 'bg-coral-soft text-coral-ink line-through decoration-coral-ink/40')}>
            <span aria-hidden="true" className="mr-2 select-none">{x.op === 'add' ? '+' : x.op === 'del' ? '−' : ' '}</span>
            <span className="sr-only">{x.op === 'add' ? 'agregada: ' : x.op === 'del' ? 'quitada: ' : ''}</span>
            {x.text || ' '}
          </div>
        ),
      )}
    </pre>
  )
}
