import { createRootRoute, createRoute, lazyRouteComponent, createRouter, Navigate, Outlet, useSearch } from '@tanstack/react-router'
import { AuditPage } from './features/audit/AuditPage'
import { Enter } from './features/auth/Enter'
import { Setup } from './features/auth/Setup'
import { ApplicationsPage } from './features/applications/ApplicationsPage'
import { ApplicationDetailPage } from './features/applications/ApplicationDetailPage'
import { ClarificationsPage } from './features/clarifications/ClarificationsPage'
import { OutcomesPage } from './features/outcomes/OutcomesPage'
import { PoliciesPage } from './features/policies/PoliciesPage'
import { PromptsPage } from './features/prompts/PromptsPage'
import { ReviewPage } from './features/review/ReviewPage'
import { SettingsLayout } from './features/settings/SettingsLayout'
import { SettingsPage } from './features/settings/SettingsPage'
import { SupplierDetailPage } from './features/suppliers/SupplierDetailPage'
import { SuppliersPage } from './features/suppliers/SuppliersPage'
import { Shell } from './ui/Shell'

const root = createRootRoute({ component: Outlet })
const enter = createRoute({ getParentRoute: () => root, path: '/entrar', component: Enter })
const setup = createRoute({ getParentRoute: () => root, path: '/configuracion-inicial', component: Setup })
const shell = createRoute({ getParentRoute: () => root, id: 'shell', component: Shell })

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const applications = createRoute({
  getParentRoute: () => shell,
  path: '/',
  component: ApplicationsPage,
  validateSearch: (s: Record<string, unknown>): { estado?: string; q?: string } => ({ estado: str(s.estado), q: str(s.q) }),
})
const detail = createRoute({
  getParentRoute: () => shell,
  path: '/solicitudes/$id',
  component: ApplicationDetailPage,
  validateSearch: (s: Record<string, unknown>): { tab?: string; pag?: number } => ({ tab: str(s.tab), pag: typeof s.pag === 'number' ? s.pag : Number(str(s.pag)) || undefined }),
})
// three.js pesa más que el resto de la app: el recorrido se descarga solo al abrirlo.
const timeline = createRoute({
  getParentRoute: () => shell,
  path: '/solicitudes/$id/recorrido',
  component: lazyRouteComponent(() => import('./features/timeline/TimelinePage'), 'TimelinePage'),
})
const clarifications = createRoute({
  getParentRoute: () => shell,
  path: '/aclaraciones',
  component: ClarificationsPage,
  validateSearch: (s: Record<string, unknown>): { id?: string; ver?: string } => ({ id: str(s.id), ver: str(s.ver) }),
})
const review = createRoute({ getParentRoute: () => shell, path: '/revision', component: ReviewPage })
// Configuración agrupa General, Políticas, Prompts y Bitácora con un submenú.
const settingsSection = createRoute({ getParentRoute: () => shell, path: '/configuracion', component: SettingsLayout })
const settings = createRoute({ getParentRoute: () => settingsSection, path: '/', component: SettingsPage })
const policies = createRoute({ getParentRoute: () => settingsSection, path: '/politicas', component: PoliciesPage, validateSearch: (s: Record<string, unknown>): { v?: string } => ({ v: str(s.v) }) })
const prompts = createRoute({
  getParentRoute: () => settingsSection,
  path: '/prompts',
  component: PromptsPage,
  validateSearch: (s: Record<string, unknown>): { p?: string; v?: string; cmp?: string } => ({ p: str(s.p), v: str(s.v), cmp: str(s.cmp) }),
})
const outcomes = createRoute({ getParentRoute: () => shell, path: '/outcomes', component: OutcomesPage })
const audit = createRoute({
  getParentRoute: () => settingsSection,
  path: '/bitacora',
  component: AuditPage,
  validateSearch: (s: Record<string, unknown>): { tab?: string; solicitud?: string; resultado?: string; ver?: string } => ({ tab: str(s.tab), solicitud: str(s.solicitud), resultado: str(s.resultado), ver: str(s.ver) }),
})
const suppliers = createRoute({ getParentRoute: () => shell, path: '/proveedores', component: SuppliersPage, validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: str(s.q) }) })
const supplier = createRoute({ getParentRoute: () => shell, path: '/proveedores/$id', component: SupplierDetailPage })
// Las rutas de antes siguen sirviendo (enlaces guardados): llevan a su lugar en Configuración.
const legacy = (from: '/politicas' | '/prompts' | '/bitacora', to: '/configuracion/politicas' | '/configuracion/prompts' | '/configuracion/bitacora') =>
  createRoute({
    getParentRoute: () => shell,
    path: from,
    component: function MovedToSettings() {
      const search = useSearch({ strict: false })
      return <Navigate to={to} search={search as never} replace />
    },
  })

const tree = root.addChildren([enter, setup, shell.addChildren([applications, detail, timeline, clarifications, review, suppliers, supplier, outcomes, settingsSection.addChildren([settings, policies, prompts, audit]), legacy('/politicas', '/configuracion/politicas'), legacy('/prompts', '/configuracion/prompts'), legacy('/bitacora', '/configuracion/bitacora')])])
export const router = createRouter({ routeTree: tree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
