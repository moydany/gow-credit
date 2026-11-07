import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
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
const clarifications = createRoute({
  getParentRoute: () => shell,
  path: '/aclaraciones',
  component: ClarificationsPage,
  validateSearch: (s: Record<string, unknown>): { id?: string; ver?: string } => ({ id: str(s.id), ver: str(s.ver) }),
})
const review = createRoute({ getParentRoute: () => shell, path: '/revision', component: ReviewPage })
const policies = createRoute({ getParentRoute: () => shell, path: '/politicas', component: PoliciesPage, validateSearch: (s: Record<string, unknown>): { v?: string } => ({ v: str(s.v) }) })
const prompts = createRoute({
  getParentRoute: () => shell,
  path: '/prompts',
  component: PromptsPage,
  validateSearch: (s: Record<string, unknown>): { p?: string; v?: string; cmp?: string } => ({ p: str(s.p), v: str(s.v), cmp: str(s.cmp) }),
})
const outcomes = createRoute({ getParentRoute: () => shell, path: '/outcomes', component: OutcomesPage })
const audit = createRoute({
  getParentRoute: () => shell,
  path: '/bitacora',
  component: AuditPage,
  validateSearch: (s: Record<string, unknown>): { tab?: string; solicitud?: string; resultado?: string; ver?: string } => ({ tab: str(s.tab), solicitud: str(s.solicitud), resultado: str(s.resultado), ver: str(s.ver) }),
})
const suppliers = createRoute({ getParentRoute: () => shell, path: '/proveedores', component: SuppliersPage, validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: str(s.q) }) })
const supplier = createRoute({ getParentRoute: () => shell, path: '/proveedores/$id', component: SupplierDetailPage })
const settings = createRoute({ getParentRoute: () => shell, path: '/configuracion', component: SettingsPage })

const tree = root.addChildren([enter, setup, shell.addChildren([applications, detail, clarifications, review, suppliers, supplier, policies, prompts, outcomes, audit, settings])])
export const router = createRouter({ routeTree: tree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
