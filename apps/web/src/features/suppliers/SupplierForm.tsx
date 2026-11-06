/**
 * Alta y edición de un proveedor. Se valida con los mismos contratos que la API (`SupplierCreateBody`,
 * `SupplierUpdateBody`, con los validadores de RFC y CLABE de `@gow/contracts`): el error aparece al
 * escribir y la API lo vuelve a revisar. En la edición solo se mandan los campos que cambiaron.
 */
import { SupplierCreateBody, SupplierUpdateBody, type SupplierDetail } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Button, Modal } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

type Field = 'legal_name' | 'rfc' | 'external_ref' | 'clabes'

const splitClabes = (text: string): string[] => text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)

/** Mensaje por campo; en las CLABEs dice el renglón, nunca el valor. */
function issuesByField(issues: { path: string; message: string }[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {}
  for (const i of issues) {
    const [field, index] = i.path.split('.') as [string, string | undefined]
    const key = (['legal_name', 'rfc', 'external_ref', 'clabes'] as const).find((f) => f === field)
    if (!key || out[key]) continue
    out[key] = key === 'clabes' && index !== undefined ? `Renglón ${String(Number(index) + 1)}: ${i.message}` : i.message
  }
  return out
}

export function SupplierFormModal({ open, onClose, supplier, onCreated }: { open: boolean; onClose: () => void; supplier?: SupplierDetail; onCreated?: (id: string) => void }) {
  const editing = supplier !== undefined
  const [name, setName] = useState('')
  const [rfc, setRfc] = useState('')
  const [ref, setRef] = useState('')
  const [clabes, setClabes] = useState('')
  const [tried, setTried] = useState(false)
  const [server, setServer] = useState<Partial<Record<Field, string>>>({})
  const toast = useToast()
  const qc = useQueryClient()

  useEffect(() => {
    if (!open) return
    setName(supplier?.legal_name ?? '')
    setRfc(supplier?.rfc ?? '')
    setRef(supplier?.external_ref ?? '')
    setClabes((supplier?.clabes ?? []).join('\n'))
    setTried(false)
    setServer({})
  }, [open, supplier])

  const input = { legal_name: name, rfc: rfc.trim() ? rfc : null, clabes: splitClabes(clabes) }
  const parsed = editing ? SupplierUpdateBody.safeParse(input) : SupplierCreateBody.safeParse({ ...input, external_ref: ref.trim() ? ref : null })
  const local = parsed.success ? {} : issuesByField(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))

  // En la edición, lo que de verdad cambió respecto a lo guardado (ya normalizado).
  const changes: { legal_name?: string; rfc?: string | null; clabes?: string[] } = {}
  if (editing && parsed.success) {
    const p = parsed.data
    if (p.legal_name !== undefined && p.legal_name !== supplier.legal_name) changes.legal_name = p.legal_name
    if (p.rfc !== undefined && p.rfc !== supplier.rfc) changes.rfc = p.rfc
    if (p.clabes !== undefined && p.clabes.join() !== supplier.clabes.join()) changes.clabes = p.clabes
  }
  const nothing = editing && Object.keys(changes).length === 0

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
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

  const show = (f: Field, dirty: boolean): string | undefined => server[f] ?? (tried || dirty ? local[f] : undefined)
  const errName = show('legal_name', name !== (supplier?.legal_name ?? ''))
  const errRfc = show('rfc', rfc.trim() !== '' && rfc !== (supplier?.rfc ?? ''))
  const errRef = show('external_ref', false)
  const errClabes = show('clabes', clabes.trim() !== '' && clabes !== (supplier?.clabes ?? []).join('\n'))

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
        {!editing ? <p className="text-[13.5px] leading-relaxed text-muted">Los contactos de WhatsApp y correo verificados entran por la API de integración, con el KYC del prestamista.</p> : null}
        <TextField label="Razón social" value={name} onChange={(v) => { setName(v); setServer((s) => ({ ...s, legal_name: undefined })) }} error={errName} autoComplete="organization" />
        <TextField label="RFC" hint="Opcional. 12 posiciones persona moral, 13 persona física." value={rfc} onChange={(v) => { setRfc(v); setServer((s) => ({ ...s, rfc: undefined })) }} error={errRfc} mono />
        {!editing ? <TextField label="Referencia externa" hint="Opcional. El id del proveedor en tu sistema; no se repite." value={ref} onChange={(v) => { setRef(v); setServer((s) => ({ ...s, external_ref: undefined })) }} error={errRef} mono /> : null}
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
          <Button type="submit" variant="lime" disabled={save.isPending || nothing}>
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
