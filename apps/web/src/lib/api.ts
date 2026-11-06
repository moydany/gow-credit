/**
 * Cliente de la API del backoffice (`/bo/v1`). Toda petición va con la cookie de sesión (mismo
 * origen) y el encabezado anti-CSRF. Los errores conservan lo que la API dice (ruta y mensaje del
 * campo, nunca el valor).
 */
import type { ApplicationDetail, ApplicationRow, AuditEntry, BackofficeMe, ClarificationItem, CorrectionInput, DiscardReason, OwnerAnswer, PolicyVersionItem, SimulationReport } from '@gow/contracts'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/bo/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-gow-backoffice': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const json = ((): unknown => {
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  })()
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; issues?: { path: string; message: string }[] }
    throw new ApiError(res.status, e.error ?? `error ${String(res.status)}`, e.issues ?? [])
  }
  return json as T
}

export const api = {
  signIn: (token: string) => request<BackofficeMe>('POST', '/session', { token }),
  signOut: () => request<undefined>('DELETE', '/session'),
  me: () => request<BackofficeMe>('GET', '/me'),
  applications: () => request<ApplicationRow[]>('GET', '/applications'),
  application: (id: string) => request<ApplicationDetail>('GET', `/applications/${id}`),
  correct: (id: string, corrections: CorrectionInput[]) => request<{ batch: string; corrections: number }>('POST', `/applications/${id}/corrections`, { corrections }),
  discard: (id: string, reason: DiscardReason) => request<{ id: string; status: 'not_qualified' }>('POST', `/applications/${id}/discard`, { reason }),
  clarifications: () => request<ClarificationItem[]>('GET', '/clarifications'),
  answer: (id: string, answers: OwnerAnswer[]) => request<{ id: string; complete: boolean }>('POST', `/clarifications/${id}/answers`, { answers }),
  policyVersions: () => request<PolicyVersionItem[]>('GET', '/policies/versions'),
  createDraft: (document: unknown) => request<{ id: string; version: number; status: string }>('POST', '/policies/versions', { document }),
  simulate: (id: string) => request<SimulationReport>('POST', `/policies/versions/${id}/simulate`),
  shadow: (id: string) => request<{ id: string; status: string }>('POST', `/policies/versions/${id}/shadow`),
  activate: (id: string) => request<{ id: string; status: string }>('POST', `/policies/versions/${id}/activate`),
  recordOutcome: (body: { application_id: string; outcome: 'paid' | 'late' | 'default' | 'fraud'; observed_at: string }) => request<{ ok: true }>('POST', '/outcomes', body),
  audit: () => request<AuditEntry[]>('GET', '/audit'),
}

export const documentUrl = (documentId: string) => `/bo/v1/documents/${documentId}/file`
