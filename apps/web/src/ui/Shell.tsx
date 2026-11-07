import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, Outlet, useNavigate } from '@tanstack/react-router'
import clsx from 'clsx'
import { api, ApiError } from '../lib/api'
import { useApplications, useClarifications, useMe } from '../lib/queries'
import { Icon, Logo } from './icons'
import { Skeleton } from './primitives'

const NAV = [
  { to: '/', label: 'Solicitudes', badge: 'none' },
  { to: '/aclaraciones', label: 'Aclaraciones', badge: 'clarifications' },
  { to: '/revision', label: 'Revisión', badge: 'review' },
  { to: '/proveedores', label: 'Proveedores', badge: 'none' },
  { to: '/politicas', label: 'Políticas', badge: 'none' },
  { to: '/prompts', label: 'Prompts', badge: 'none' },
  { to: '/outcomes', label: 'Outcomes', badge: 'none' },
  { to: '/bitacora', label: 'Bitácora', badge: 'none' },
  { to: '/configuracion', label: 'Configuración', badge: 'none' },
] as const

export function Shell() {
  const me = useMe()
  const apps = useApplications()
  const clars = useClarifications()
  const qc = useQueryClient()
  const navigate = useNavigate()

  if (me.isError && me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/entrar" />

  const counts = {
    none: 0,
    clarifications: (clars.data ?? []).filter((c) => c.status === 'open').length,
    review: (apps.data ?? []).filter((a) => a.status === 'human_review').length,
  }

  return (
    <div className="min-h-dvh md:p-5">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        Saltar al contenido
      </a>
      <div className="mx-auto min-h-dvh max-w-[1560px] bg-frame px-4 pb-12 sm:px-8 md:min-h-[calc(100dvh-40px)] md:rounded-[44px]">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-3 py-5">
          <Link to="/" className="flex items-center gap-2.5 rounded-xl" aria-label="GOW Credit, inicio">
            <Logo />
            <span className="text-[19px] font-semibold tracking-[-0.03em]">
              GOW <span className="text-muted">Credit</span>
            </span>
          </Link>

          <nav aria-label="Principal" className="order-3 -mx-1 flex w-full gap-1.5 overflow-x-auto px-1 py-1 xl:order-none xl:mx-0 xl:w-auto xl:flex-1 xl:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.to === '/' }}
                className="group relative inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-sunken px-5 text-[14.5px] font-medium text-ink-2 transition-[background-color,color] duration-150 hover:bg-line data-[status=active]:bg-ink data-[status=active]:text-white"
              >
                {n.label}
                {counts[n.badge] > 0 ? (
                  <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-white">{counts[n.badge]}</span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2.5 xl:ml-0">
            {me.data ? (
              <details className="group relative">
                <summary className="flex h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-card py-1 pl-1 pr-3 shadow-[0_1px_2px_rgb(20_23_31/0.06)] [&::-webkit-details-marker]:hidden">
                  <span className="grid size-9 place-items-center rounded-full bg-accent text-[13px] font-semibold uppercase text-white">{me.data.user.email.slice(0, 2)}</span>
                  <Icon name="down" size={14} className="text-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="animate-fade absolute right-0 top-14 z-40 w-72 rounded-3xl bg-card p-2 shadow-pop">
                  <div className="px-4 py-3">
                    <p className="truncate text-[14px] font-medium">{me.data.user.email}</p>
                    <p className="mt-0.5 truncate text-[13px] text-muted">{me.data.tenant.name}</p>
                    <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
                      <span className={clsx('size-1.5 rounded-full', me.data.tenant.whatsapp_linked_number ? 'bg-accent-ink' : 'bg-amber')} />
                      {me.data.tenant.whatsapp_linked_number ? `WhatsApp ${me.data.tenant.whatsapp_linked_number}` : 'WhatsApp sin vincular: respondes tú'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-2xl px-4 py-3 text-left text-[14px] font-medium hover:bg-sunken"
                    onClick={() => {
                      void api.signOut().finally(() => {
                        qc.clear()
                        void navigate({ to: '/entrar' })
                      })
                    }}
                  >
                    <Icon name="logout" size={16} /> Salir
                  </button>
                </div>
              </details>
            ) : (
              <Skeleton className="h-11 w-20 rounded-full" />
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
