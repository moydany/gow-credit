import { SetupBody } from '@gow/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, useNavigate } from '@tanstack/react-router'
import clsx from 'clsx'
import { useState } from 'react'
import { WhatsAppLink } from '../settings/WhatsAppLink'
import { api, ApiError } from '../../lib/api'
import { useMe, useSettings, useWhatsApp } from '../../lib/queries'
import { Icon, Logo } from '../../ui/icons'
import { Button, ErrorState, Skeleton } from '../../ui/primitives'

/**
 * Wizard del primer inicio (ADR 0060). Dos pasos:
 *  1. Prestamista y administrador: se crean el tenant, su política base y la cuenta, y la sesión
 *     queda abierta.
 *  2. WhatsApp: la misma tarjeta de Configuración (ADR 0033) para escanear el QR.
 *
 * El paso se deduce del estado, no se guarda en el navegador: con sesión, toca WhatsApp (también si se
 * recarga la página); sin sesión y con el sistema vacío, la cuenta; sin sesión y con un tenant ya
 * creado, el wizard no tiene nada que hacer y manda a `/entrar`.
 */
export function Setup() {
  const me = useMe()
  const config = useQuery({ queryKey: ['session-config'], queryFn: api.sessionConfig, retry: false })

  if (me.isPending || (me.isError && config.isPending)) return <Frame step={1}><Skeleton className="mt-8 h-40 rounded-2xl" /></Frame>
  if (me.data) return <WhatsAppStep />
  if (config.data?.setup_required) return <AccountStep />
  if (config.isError) return <Frame step={1}><ErrorState message={config.error.message} onRetry={() => void config.refetch()} /></Frame>
  return <Navigate to="/entrar" />
}

function Frame({ step, children }: { step: 1 | 2; children: React.ReactNode }) {
  const steps = ['Cuenta', 'WhatsApp'] as const
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className={clsx('card rise w-full p-8', step === 2 ? 'max-w-2xl' : 'max-w-md')}>
        <Logo size={44} />
        <ol className="mt-6 flex items-center gap-2 text-[12.5px] font-medium" aria-label="Pasos">
          {steps.map((label, i) => {
            const n = i + 1
            const done = n < step
            return (
              <li key={label} className="flex items-center gap-2" aria-current={n === step ? 'step' : undefined}>
                <span className={clsx('grid size-6 place-items-center rounded-full text-[11.5px]', n === step ? 'bg-ink text-white' : done ? 'bg-accent text-white' : 'bg-sunken text-muted')}>
                  {done ? <Icon name="check" size={13} /> : n}
                </span>
                <span className={n === step ? 'text-ink' : 'text-muted'}>{label}</span>
                {n < steps.length ? <span className="mx-1 h-px w-6 bg-line" aria-hidden="true" /> : null}
              </li>
            )
          })}
        </ol>
        {children}
      </div>
    </div>
  )
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="mt-5 block">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1.5 block text-[12.5px] text-coral-ink">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-[12.5px] text-muted">{hint}</span>
      ) : null}
    </label>
  )
}

function AccountStep() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [tried, setTried] = useState(false)
  const parsed = SetupBody.safeParse({ tenant_name: name, email })
  const issue = (path: string) => (tried && !parsed.success ? parsed.error.issues.find((i) => i.path[0] === path)?.message : undefined)
  const create = useMutation({
    mutationFn: api.setup,
    onSuccess: (data) => {
      qc.setQueryData(['me'], data)
      void qc.invalidateQueries({ queryKey: ['session-config'] })
    },
  })

  return (
    <Frame step={1}>
      <h1 className="display mt-6 text-[34px]">
        Bienvenido a <span className="text-muted">GOW Credit</span>
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">Es el primer inicio. Crea al prestamista y a su administrador; entras con esa cuenta al terminar.</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (!parsed.success || create.isPending) return
          create.mutate(parsed.data)
        }}
      >
        <Field label="Nombre del prestamista" error={issue('tenant_name')}>
          <input className="input mt-1.5 h-11" placeholder="Fintech Demo" value={name} onChange={(e) => { setName(e.target.value) }} aria-invalid={Boolean(issue('tenant_name'))} autoFocus />
        </Field>
        <Field label="Correo del administrador" error={issue('email')}>
          <input type="email" className="input mt-1.5 h-11" placeholder="tu@prestamista.mx" value={email} onChange={(e) => { setEmail(e.target.value) }} aria-invalid={Boolean(issue('email'))} autoComplete="email" />
        </Field>
        {create.isError ? (
          <p role="alert" className="mt-4 text-[13px] text-coral-ink">
            {create.error instanceof ApiError ? create.error.message : 'No se pudo crear la cuenta'}
          </p>
        ) : null}
        <Button type="submit" className="mt-6 w-full" disabled={create.isPending}>
          {create.isPending ? 'Creando…' : 'Crear cuenta'} <Icon name="right" size={16} />
        </Button>
      </form>
    </Frame>
  )
}

function WhatsAppStep() {
  const navigate = useNavigate()
  const settings = useSettings()
  const link = useWhatsApp()
  const linked = link.data?.status === 'open' && link.data.process_running

  return (
    <Frame step={2}>
      <h1 className="display mt-6 text-[34px]">
        Vincula <span className="text-muted">WhatsApp</span>
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        Las aclaraciones a los proveedores salen por el número que vincules aquí. Es opcional: sin él las respondes a mano desde Aclaraciones y puedes vincularlo después en Configuración.
      </p>
      <div className="mt-6">
        {settings.isError ? <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} /> : settings.isPending ? <Skeleton className="h-40 rounded-2xl" /> : <WhatsAppLink settings={settings.data} />}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Button variant={linked ? 'primary' : 'ghost'} onClick={() => void navigate({ to: '/' })}>
          {linked ? 'Entrar al backoffice' : 'Omitir por ahora'} <Icon name="right" size={16} />
        </Button>
      </div>
    </Frame>
  )
}
