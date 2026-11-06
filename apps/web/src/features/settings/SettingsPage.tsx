/**
 * Configuración del tenant (docs/08 §2): usuarios, llaves de API y canales. El enlace de acceso de un
 * invitado y la llave completa se muestran una sola vez, en un diálogo, y no se guardan en el
 * navegador. WhatsApp, retención y aviso de privacidad son de solo lectura en esta versión.
 */
import { ApiKeyScope, TenantUserCreateBody, type ApiKeyItem, type TenantUserItem } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { date, dateTime } from '../../lib/format'
import { useApiKeys, useSettings, useUsers } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, Modal, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { PageTitle } from '../applications/ApplicationsPage'

const SCOPE_LABEL: Record<ApiKeyScope, { label: string; hint: string }> = {
  ingest: { label: 'Ingesta', hint: 'Proveedores, documentos, solicitudes, respuestas y outcomes' },
  read: { label: 'Lectura', hint: 'Resultado de cada solicitud y sus aclaraciones' },
  policies: { label: 'Políticas', hint: 'Crear, simular, poner en sombra y activar' },
}

export function SettingsPage() {
  return (
    <div>
      <PageTitle title="Configuración" />
      <div className="grid gap-4 xl:grid-cols-2">
        <UsersCard />
        <ApiKeysCard />
        <ChannelsCard />
        <PrivacyCard />
      </div>
    </div>
  )
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback
}

/** Diálogo para lo que se muestra una sola vez: el valor, un botón de copiar y la advertencia. */
function ShowOnce({ open, onClose, title, value, children }: { open: boolean; onClose: () => void; title: string; value: string; children: React.ReactNode }) {
  const toast = useToast()
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="hatch-amber rounded-2xl px-4 py-3 text-[13px] leading-relaxed text-amber-ink">{children}</div>
        <div className="inner flex items-start gap-2 p-2 pl-4">
          <code className="min-w-0 flex-1 break-all py-2 font-mono text-[12.5px] leading-relaxed">{value}</code>
          <Button
            size="sm"
            variant="lime"
            onClick={() => {
              void navigator.clipboard.writeText(value).then(
                () => { toast.ok('Copiado') },
                () => { toast.error('No se pudo copiar; selecciónalo a mano') },
              )
            }}
          >
            <Icon name="copy" size={15} /> Copiar
          </Button>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>Listo</Button>
        </div>
      </div>
    </Modal>
  )
}

function Confirm({ open, onClose, title, children, action, pending, onConfirm }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; action: string; pending: boolean; onConfirm: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-[14px] leading-relaxed text-ink-2">{children}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    </Modal>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 rounded-3xl" />
      ))}
    </div>
  )
}

// ---------- Usuarios

function UsersCard() {
  const { data, isPending, isError, error, refetch } = useUsers()
  const [email, setEmail] = useState('')
  const [tried, setTried] = useState(false)
  const [link, setLink] = useState<{ email: string; url: string; expires: string } | null>(null)
  const [removing, setRemoving] = useState<TenantUserItem | null>(null)
  const toast = useToast()
  const qc = useQueryClient()
  const parsed = TenantUserCreateBody.safeParse({ email })
  const invalid = tried && !parsed.success

  const invite = useMutation({
    mutationFn: () => api.addUser(email.trim()),
    onSuccess: (r) => {
      setLink({ email: r.user.email, url: r.access_link, expires: r.expires_at })
      setEmail('')
      setTried(false)
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: unknown) => { toast.error(errorText(e, 'No se pudo invitar')) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.removeUser(id),
    onSuccess: () => {
      toast.ok('Usuario quitado; su sesión se cierra en su siguiente acción')
      setRemoving(null)
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: unknown) => { toast.error(errorText(e, 'No se pudo quitar')) },
  })

  return (
    <Card rise={0} className="pb-4">
      <CardHeader title="Usuarios" subtitle="Todos ven y operan las solicitudes del prestamista" />
      <form
        noValidate
        className="mt-4 flex flex-wrap items-start gap-2 px-6"
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (parsed.success) invite.mutate()
        }}
      >
        <label className="min-w-0 flex-1 basis-56">
          <span className="sr-only">Correo de la persona a invitar</span>
          <input type="email" className="input h-11" placeholder="persona@prestamista.mx" value={email} onChange={(e) => { setEmail(e.target.value) }} aria-invalid={invalid} autoComplete="off" />
          {invalid ? (
            <span role="alert" className="mt-1.5 block text-[12.5px] text-coral-ink">
              Escribe un correo válido
            </span>
          ) : null}
        </label>
        <Button type="submit" variant="lime" disabled={invite.isPending}>
          <Icon name="plus" size={16} /> Invitar
        </Button>
      </form>
      {isError ? (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ListSkeleton />
      ) : (
        <ul className="mt-3 px-3" aria-label="Usuarios del tenant">
          {data.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line/70 px-3 py-3.5 first:border-0">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-semibold uppercase text-lime">{u.email.slice(0, 2)}</span>
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-[14.5px] font-medium">
                  {u.email} {u.is_me ? <Chip className="ml-1.5 align-middle">Tú</Chip> : null}
                </p>
                <p className="mt-0.5 truncate text-[12.5px] text-muted">
                  Desde {date(u.created_at)}
                  {u.invited_by ? ` · invitado por ${u.invited_by}` : ''}
                </p>
              </div>
              {u.is_me ? null : (
                <Button size="sm" variant="quiet" onClick={() => { setRemoving(u) }} aria-label={`Quitar a ${u.email}`}>
                  <Icon name="trash" size={15} /> Quitar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ShowOnce open={link !== null} onClose={() => { setLink(null) }} title={`Enlace de acceso para ${link?.email ?? ''}`} value={link?.url ?? ''}>
        Compártelo solo con esa persona: quien lo abra entra a su nombre. No se vuelve a mostrar y vence el {link ? dateTime(link.expires) : ''}. En producción la invitación llega por correo.
      </ShowOnce>
      <Confirm open={removing !== null} onClose={() => { setRemoving(null) }} title="Quitar usuario" action="Quitar" pending={remove.isPending} onConfirm={() => { if (removing) remove.mutate(removing.id) }}>
        {removing?.email} deja de tener acceso de inmediato, aunque tenga una sesión abierta. Lo que hizo sigue en la bitácora.
      </Confirm>
    </Card>
  )
}

// ---------- Llaves de API

function ApiKeysCard() {
  const { data, isPending, isError, error, refetch } = useApiKeys()
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...ApiKeyScope.options])
  const [shown, setShown] = useState<{ prefix: string; key: string } | null>(null)
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null)
  const toast = useToast()
  const qc = useQueryClient()

  const create = useMutation({
    mutationFn: () => api.createApiKey(scopes),
    onSuccess: (r) => {
      setShown({ prefix: r.key.prefix, key: r.secret_key })
      void qc.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (e: unknown) => { toast.error(errorText(e, 'No se pudo crear la llave')) },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      toast.ok('Llave revocada')
      setRevoking(null)
      void qc.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (e: unknown) => { toast.error(errorText(e, 'No se pudo revocar')) },
  })
  const active = (data ?? []).filter((k) => !k.revoked_at).length

  return (
    <Card rise={1} className="pb-4">
      <CardHeader title="Llaves de API" subtitle={data ? `${String(active)} activa${active === 1 ? '' : 's'} · se guardan como hash` : 'Para la API de integración (/v1)'} />
      <form
        className="mt-4 flex flex-wrap items-center gap-2 px-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (scopes.length) create.mutate()
        }}
      >
        <fieldset className="flex min-w-0 flex-1 basis-64 flex-wrap gap-1.5">
          <legend className="sr-only">Alcances de la llave nueva</legend>
          {ApiKeyScope.options.map((s) => {
            const on = scopes.includes(s)
            return (
              <button
                key={s}
                type="button"
                role="checkbox"
                aria-checked={on}
                title={SCOPE_LABEL[s].hint}
                onClick={() => { setScopes((xs) => (on ? xs.filter((x) => x !== s) : ApiKeyScope.options.filter((x) => x === s || xs.includes(x)))) }}
                className={clsx('inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium transition-colors', on ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
              >
                {on ? <Icon name="check" size={14} /> : null}
                {SCOPE_LABEL[s].label}
              </button>
            )
          })}
        </fieldset>
        <Button type="submit" variant="lime" disabled={create.isPending || scopes.length === 0}>
          <Icon name="key" size={16} /> Crear llave
        </Button>
      </form>
      {scopes.length === 0 ? <p className="mt-2 px-6 text-[12.5px] text-coral-ink">Elige al menos un alcance</p> : null}
      {isError ? (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ListSkeleton />
      ) : data.length === 0 ? (
        <EmptyState icon="key" title="Sin llaves">Crea una para que tu sistema mande solicitudes por la API.</EmptyState>
      ) : (
        <ul className="mt-3 px-3" aria-label="Llaves de API">
          {data.map((k) => (
            <li key={k.id} className={clsx('flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line/70 px-3 py-3.5 first:border-0', k.revoked_at && 'opacity-60')}>
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate font-mono text-[13.5px] font-medium">{k.prefix}.••••••</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Chip key={s}>{SCOPE_LABEL[s].label}</Chip>
                  ))}
                </p>
              </div>
              <div className="text-right text-[12.5px] text-muted">
                <p>Creada {date(k.created_at)}</p>
                {k.revoked_at ? <p className="text-coral-ink">Revocada {date(k.revoked_at)}</p> : null}
              </div>
              {k.revoked_at ? null : (
                <Button size="sm" variant="quiet" onClick={() => { setRevoking(k) }} aria-label={`Revocar ${k.prefix}`}>
                  Revocar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ShowOnce open={shown !== null} onClose={() => { setShown(null) }} title={`Llave ${shown?.prefix ?? ''}`} value={shown?.key ?? ''}>
        Guárdala ahora en tu gestor de secretos: es la única vez que se muestra completa. Aquí solo queda su hash; si se pierde, crea otra y revoca esta.
      </ShowOnce>
      <Confirm open={revoking !== null} onClose={() => { setRevoking(null) }} title={`Revocar ${revoking?.prefix ?? ''}`} action="Revocar" pending={revoke.isPending} onConfirm={() => { if (revoking) revoke.mutate(revoking.id) }}>
        Toda petición con esta llave se rechaza desde este momento. No se puede deshacer.
      </Confirm>
    </Card>
  )
}

// ---------- Canales y privacidad (solo lectura)

function ChannelsCard() {
  const { data, isPending, isError, error, refetch } = useSettings()
  return (
    <Card rise={2} className="pb-6">
      <CardHeader title="Canales" subtitle="Por dónde se pregunta al proveedor" />
      {isError ? (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ListSkeleton />
      ) : (
        <div className="mt-4 space-y-3 px-6">
          <div className="inner p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[14.5px] font-medium">
                <Icon name="phone" size={16} /> WhatsApp
              </p>
              {data.whatsapp.number ? (
                <Chip tone="lime" dot>
                  {data.whatsapp.number}
                </Chip>
              ) : (
                <Chip tone="amber" dot>
                  Sin vincular
                </Chip>
              )}
            </div>
            <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
              {data.whatsapp.number ? 'Las aclaraciones salen por este número a los contactos verificados.' : 'Mientras no haya número, las aclaraciones quedan como manuales y las respondes desde Aclaraciones.'} Para vincular el número se corre{' '}
              <code className="rounded-md bg-card px-1.5 py-0.5 font-mono text-[12px] text-ink">WHATSAPP_TENANT_ID={data.tenant.id} pnpm whatsapp</code> y se escanea el QR. La vinculación desde esta pantalla aún no existe.
            </p>
          </div>
          <div className="inner p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[14.5px] font-medium">
                <Icon name="mail" size={16} /> Correo
              </p>
              {data.email.from ? <Chip tone="lime" dot>{data.email.from}</Chip> : <Chip tone="hatch" dot>Sin remitente</Chip>}
            </div>
            <p className="mt-2.5 text-[13px] leading-relaxed text-muted">El remitente se define al dar de alta el tenant.</p>
          </div>
        </div>
      )}
    </Card>
  )
}

function PrivacyCard() {
  return (
    <Card rise={3} className="pb-6">
      <CardHeader title="Retención y privacidad" subtitle="Aún no se configuran desde aquí" />
      <div className="mt-4 space-y-3 px-6 text-[13.5px] leading-relaxed text-ink-2">
        <div className="hatch rounded-2xl p-4">
          <p className="font-medium text-ink">Retención de documentos</p>
          <p className="mt-1">El plan: el PDF original se borra a los N días (90 por defecto, configurable por prestamista) y se conservan la extracción y las decisiones. Hoy no se borra nada automáticamente.</p>
        </div>
        <div className="hatch rounded-2xl p-4">
          <p className="font-medium text-ink">Aviso de privacidad</p>
          <p className="mt-1">El plan: tu aviso de privacidad se referencia en el primer mensaje de WhatsApp o correo al proveedor, y el consentimiento expreso que recabas queda como evidencia junto a la solicitud.</p>
        </div>
      </div>
    </Card>
  )
}
