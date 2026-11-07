/**
 * Settings groups what is rarely adjusted and affects everything: users, channels and analysis
 * (General), policies, prompts and the audit log. A submenu on top; each section keeps its page.
 */
import { Link, Outlet } from '@tanstack/react-router'

const SECTIONS = [
  { to: '/configuracion', label: 'General', exact: true },
  { to: '/configuracion/politicas', label: 'Políticas', exact: false },
  { to: '/configuracion/prompts', label: 'Prompts', exact: false },
  { to: '/configuracion/bitacora', label: 'Bitácora', exact: false },
] as const

export function SettingsLayout() {
  return (
    <div>
      <nav aria-label="Configuración" className="-mx-1 mt-2 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="inline-flex gap-1 rounded-full bg-sunken p-1">
          {SECTIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              activeOptions={{ exact: s.exact, includeSearch: false }}
              className="inline-flex h-9 shrink-0 items-center rounded-full px-4 text-[13.5px] font-medium text-ink-2 transition-[background-color,color,box-shadow] duration-150 hover:text-ink data-[status=active]:bg-card data-[status=active]:text-ink data-[status=active]:shadow-[0_1px_2px_rgb(20_23_31/0.08)]"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </nav>
      <Outlet />
    </div>
  )
}
