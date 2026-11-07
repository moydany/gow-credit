/**
 * Configuración del tenant (docs/08 §2): usuarios y canales. El enlace de acceso de un invitado se
 * muestra una sola vez, en un diálogo, y no se guarda en el navegador. WhatsApp se vincula escaneando
 * el QR aquí mismo (ADR 0033); la antigüedad máxima del estado de cuenta se ajusta aquí (ADR 0049).
 * Las llaves de API, el remitente de correo y la retención no se muestran aquí.
 */
import { DAYS_PER_MONTH, monthsText, STATEMENT_MAX_AGE_OPTIONS, TenantUserCreateBody, type TenantSettings, type TenantUserItem } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { date, dateTime } from '../../lib/format'
import { useSettings, useUsers } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Card, CardHeader, Chip, ErrorState, Modal, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { PageTitle } from '../applications/ApplicationsPage'
import { WhatsAppLink } from './WhatsAppLink'

export function SettingsPage() {
  return (
    <div>
      <PageTitle title="Configuración" />
      <div className="grid gap-4 xl:grid-cols-2">
        <UsersCard />
        <ChannelsCard />
        <AnalysisCard />
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
      // Con Supabase Auth no hay enlace que compartir: la persona entra con su correo (ADR 0035).
      if (r.access_link && r.expires_at) setLink({ email: r.user.email, url: r.access_link, expires: r.expires_at })
      else toast.ok(r.email_sent ? `Listo: le mandamos a ${r.user.email} un enlace de acceso` : `Listo: ${r.user.email} ya puede entrar con su correo`)
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
        Compártelo solo con esa persona: quien lo abra entra a su nombre. No se vuelve a mostrar y vence el {link ? dateTime(link.expires) : ''}. Con Supabase Auth no hay enlace: la persona entra con su correo.
      </ShowOnce>
      <Confirm open={removing !== null} onClose={() => { setRemoving(null) }} title="Quitar usuario" action="Quitar" pending={remove.isPending} onConfirm={() => { if (removing) remove.mutate(removing.id) }}>
        {removing?.email} deja de tener acceso de inmediato, aunque tenga una sesión abierta. Lo que hizo sigue en la bitácora.
      </Confirm>
    </Card>
  )
}

// ---------- Canales (WhatsApp se vincula aquí)

function ChannelsCard() {
  const { data, isPending, isError, error, refetch } = useSettings()
  return (
    <Card rise={1} className="pb-6">
      <CardHeader title="Canales" subtitle="Por dónde se pregunta al proveedor" />
      {isError ? (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ListSkeleton />
      ) : (
        <div className="mt-4 space-y-3 px-6">
          <WhatsAppLink settings={data} />
        </div>
      )}
    </Card>
  )
}

// ---------- Análisis: antigüedad máxima del estado de cuenta (ADR 0049)

function AnalysisCard() {
  const { data, isPending, isError, error, refetch } = useSettings()
  const toast = useToast()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (months: number | null) => api.updateSettings({ statement_max_age_months: months }),
    onSuccess: (r) => {
      qc.setQueryData<TenantSettings>(['settings'], r)
      const m = r.analysis.statement_max_age_months
      toast.ok(m === null ? 'Listo: sin límite de antigüedad' : `Listo: advertencia con más de ${monthsText(m)}`)
    },
    onError: (e: unknown) => { toast.error(errorText(e, 'No se pudo guardar')) },
  })
  const current = data?.analysis.statement_max_age_months
  // Un valor fijado por la API fuera de las opciones también se muestra.
  const options: (number | null)[] = [...new Set([...STATEMENT_MAX_AGE_OPTIONS, ...(typeof current === 'number' ? [current] : [])])].sort((a, b) => a - b)
  options.push(null)
  return (
    <Card rise={2} className="pb-6">
      <CardHeader title="Análisis" subtitle="Antigüedad máxima del estado de cuenta" />
      {isError ? (
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ListSkeleton />
      ) : (
        <div className="mt-4 space-y-3 px-6">
          <fieldset className="flex flex-wrap gap-1.5" disabled={save.isPending}>
            <legend className="sr-only">Antigüedad máxima del estado de cuenta</legend>
            {options.map((m) => {
              const on = m === current
              return (
                <button
                  key={m ?? 'none'}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => { if (!on) save.mutate(m) }}
                  className={clsx('inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium transition-colors disabled:opacity-60', on ? 'bg-ink text-white' : 'bg-sunken text-ink-2 hover:bg-line')}
                >
                  {on ? <Icon name="check" size={14} /> : null}
                  {m === null ? 'Sin límite' : monthsText(m)}
                </button>
              )
            })}
          </fieldset>
          <p className="text-[13px] leading-relaxed text-muted">
            {current === null || current === undefined
              ? 'Cualquier estado de cuenta se analiza sin advertencia de antigüedad.'
              : `Un estado de cuenta con más de ${monthsText(current)} (${String(current * DAYS_PER_MONTH)} días) desde su corte se analiza igual, sin pedir otro, y la decisión lo marca con una advertencia.`}{' '}
            Aplica a las solicitudes que se analicen desde ahora y a las reevaluaciones.
          </p>
        </div>
      )}
    </Card>
  )
}
