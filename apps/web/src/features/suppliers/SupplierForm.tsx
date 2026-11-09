/**
 * Create and edit a supplier. Validated with the same contracts as the API (`SupplierCreateBody`,
 * `SupplierUpdateBody`, with the RFC and CLABE validators from `@gow/contracts`): the error shows
 * while typing and the API checks again. On edit only the changed fields are sent.
 */
import { SupplierCreateBody, SupplierUpdateBody, type SupplierDetail } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Button, Modal } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

type Field = 'legal_name' | 'rfc' | 'clabes'

const splitClabes = (text: string): string[] => text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)

/** One message per field; for CLABEs it names the row, never the value. */
function issuesByField(issues: { path: string; message: string }[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {}
  for (const i of issues) {
    const [field, index] = i.path.split('.') as [string, string | undefined]
    const key = (['legal_name', 'rfc', 'clabes'] as const).find((f) => f === field)
    if (!key || out[key]) continue
    out[key] = key === 'clabes' && index !== undefined ? `Renglón ${String(Number(index) + 1)}: ${i.message}` : i.message
  }
  return out
}

function computeSupplierChanges(supplier: SupplierDetail, data: { legal_name?: string; rfc?: string | null; clabes?: string[] }) {
  const changes: { legal_name?: string; rfc?: string | null; clabes?: string[] } = {}
  if (data.legal_name !== undefined && data.legal_name !== supplier.legal_name) changes.legal_name = data.legal_name
  if (data.rfc !== undefined && data.rfc !== supplier.rfc) changes.rfc = data.rfc
  if (data.clabes !== undefined && data.clabes.join() !== supplier.clabes.join()) changes.clabes = data.clabes
  return changes
}

function resolveFieldErrors(
  server: Partial<Record<Field, string>>,
  local: Partial<Record<Field, string>>,
  tried: boolean,
  name: string,
  rfc: string,
  clabes: string,
  supplier?: SupplierDetail,
) {
  const show = (f: Field, dirty: boolean): string | undefined => server[f] ?? (tried || dirty ? local[f] : undefined)
  const errName = show('legal_name', name !== (supplier?.legal_name ?? ''))
  const errRfc = show('rfc', rfc.trim() !== '' && rfc !== (supplier?.rfc ?? ''))
  const errClabes = show('clabes', clabes.trim() !== '' && clabes !== (supplier?.clabes ?? []).join('\n'))
  return { errName, errRfc, errClabes }
}

export function SupplierFormModal({ open, onClose, supplier, onCreated }: { open: boolean; onClose: () => void; supplier?: SupplierDetail; onCreated?: (id: string) => void }) {
  const editing = supplier !== undefined
  const [name, setName] = useState('')
  const [rfc, setRfc] = useState('')
  const [clabes, setClabes] = useState('')
  const [tried, setTried] = useState(false)
  const [server, setServer] = useState<Partial<Record<Field, string>>>({})
  const toast = useToast()
  const qc = useQueryClient()

  useEffect(() => {
    if (!open) return
    setName(supplier?.legal_name ?? '')
    setRfc(supplier?.rfc ?? '')
    setClabes((supplier?.clabes ?? []).join('\n'))
    setTried(false)
    setServer({})
  }, [open, supplier])

  const input = { legal_name: name, rfc: rfc.trim() ? rfc : null, clabes: splitClabes(clabes) }
  const parsed = editing ? SupplierUpdateBody.safeParse(input) : SupplierCreateBody.safeParse(input)
  const local = parsed.success ? {} : issuesByField(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))

  const changes = editing && parsed.success ? computeSupplierChanges(supplier, parsed.data) : {}
  const nothing = editing && Object.keys(changes).length === 0

  const save = useMutation({
    mutationFn: async () => {
      if (supplier) {
        await api.updateSupplier(supplier.id, changes)
        return supplier.id
      }
      return (await api.createSupplier(parsed.data as SupplierCreateBody)).id
    },
    onSuccess: (id) => {
      toast.ok(editing ? 'Proveedor actualizado' : 'Proveedor dado de alta')
      void qc.invalidateQueries({ queryKey: ['suppliers'] })
      void qc.invalidateQueries({ queryKey: ['supplier', id] })
      onClose()
      if (!editing) onCreated?.(id)
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.issues.length) setServer(issuesByField(e.issues))
      toast.error(e instanceof ApiError ? e.message : 'No se pudo guardar')
    },
  })

  const { errName, errRfc, errClabes } = resolveFieldErrors(server, local, tried, name, rfc, clabes, supplier)

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Editar proveedor' : 'Dar de alta un proveedor'}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          setServer({})
          if (parsed.success && !nothing) save.mutate()
        }}
        className="space-y-4"
      >
        {!editing ? <p className="text-[13.5px] leading-relaxed text-muted">Los contactos de WhatsApp y correo verificados entran por la API de integración, con el KYC de la institución crediticia.</p> : null}
        <TextField label="Razón social" value={name} onChange={(v) => { setName(v); setServer((s) => ({ ...s, legal_name: undefined })) }} error={errName} autoComplete="organization" />
        <TextField label="RFC" hint="Opcional. 12 posiciones persona moral, 13 persona física." value={rfc} onChange={(v) => { setRfc(v); setServer((s) => ({ ...s, rfc: undefined })) }} error={errRfc} mono />
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">CLABEs</span>
          <textarea className="input min-h-24 py-2.5 font-mono" rows={3} value={clabes} onChange={(e) => { setClabes(e.target.value); setServer((s) => ({ ...s, clabes: undefined })) }} aria-invalid={errClabes !== undefined} aria-describedby="clabes-hint" spellCheck={false} autoComplete="off" />
          <span id="clabes-hint" className="mt-1.5 block text-[12px] text-muted">
            Una por renglón, 18 dígitos con dígito verificador.
          </span>
          {errClabes ? <FieldError text={errClabes} /> : null}
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="accent" disabled={save.isPending || nothing}>
            {editing ? 'Guardar cambios' : 'Dar de alta'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function TextField({ label, hint, value, onChange, error, mono, autoComplete = 'off' }: { label: string; hint?: string; value: string; onChange: (v: string) => void; error: string | undefined; mono?: boolean; autoComplete?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      <input className={mono ? 'input font-mono' : 'input'} value={value} onChange={(e) => { onChange(e.target.value) }} aria-invalid={error !== undefined} autoComplete={autoComplete} spellCheck={false} />
      {hint ? <span className="mt-1.5 block text-[12px] text-muted">{hint}</span> : null}
      {error ? <FieldError text={error} /> : null}
    </label>
  )
}

function FieldError({ text }: { text: string }) {
  return (
    <span role="alert" className="mt-1.5 block rounded-2xl bg-coral-soft px-3 py-1.5 text-[12.5px] text-coral-ink">
      {text}
    </span>
  )
}
