import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { AuditPage } from './features/audit/AuditPage'
import { Enter } from './features/auth/Enter'
import { ApplicationsPage } from './features/applications/ApplicationsPage'
import { ApplicationDetailPage } from './features/applications/ApplicationDetailPage'
import { ClarificationsPage } from './features/clarifications/ClarificationsPage'
import { OutcomesPage } from './features/outcomes/OutcomesPage'
import { PoliciesPage } from './features/policies/PoliciesPage'
import { ReviewPage } from './features/review/ReviewPage'
import { Shell } from './ui/Shell'

const root = createRootRoute({ component: Outlet })
const enter = createRoute({ getParentRoute: () => root, path: '/entrar', component: Enter })
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
const outcomes = createRoute({ getParentRoute: () => shell, path: '/outcomes', component: OutcomesPage })
const audit = createRoute({ getParentRoute: () => shell, path: '/bitacora', component: AuditPage })

const tree = root.addChildren([enter, shell.addChildren([applications, detail, clarifications, review, policies, outcomes, audit])])
export const router = createRouter({ routeTree: tree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
