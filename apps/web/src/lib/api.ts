/**
 * Backoffice API client (`/bo/v1`). Every request carries the session cookie (same origin) and
 * the anti-CSRF header. Errors keep what the API says (field path and message, never the value).
 */
import type { JobItem, JobListQuery, ApplicationDetail, ApplicationRow, ApplicationTimeline, AuditEntry, BackofficeMe, LlmExchangeDetail, LlmExchangeListQuery, LlmExchangeRow, ClarificationItem, CorrectionInput, DiscardReason, MagicLinkAccepted, OwnerAnswer, PolicyVersionItem, PromptActivated, PromptCatalogResponse, PromptDetail, PromptDiff, PromptVersionCreateBody, PromptVersionItem, SessionConfig, SessionCreateBody, SetupBody, SimulationReport, SupplierCreateBody, SupplierDeleted, SupplierDetail, SupplierRow, SupplierStatementStatus, SupplierStatementUploaded, SupplierUpdateBody, TenantSettings, TenantSettingsUpdateBody, TenantUserCreated, TenantUserItem, WhatsAppLinkState, WhatsAppUnlinkRequested } from '@gow/contracts'

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
  return readResponse<T>(res)
}

/** The JSON body or, on error, an `ApiError` with what the API said. `fallback`: message when it says nothing. */
async function readResponse<T>(res: Response, fallback = `error ${String(res.status)}`): Promise<T> {
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
    throw new ApiError(res.status, e.error ?? fallback, e.issues ?? [])
  }
  return json as T
}

/** Sends the PDF as is (`application/pdf`), not as JSON: up to 40 MB. */
async function uploadPdf<T>(path: string, file: File): Promise<T> {
  const res = await fetch(`/bo/v1${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-gow-backoffice': '1', 'content-type': 'application/pdf' }, body: file })
  return readResponse<T>(res, res.status === 413 ? 'el PDF pasa del tamaño máximo (40 MB)' : `error ${String(res.status)}`)
}

function queryString(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  signIn: (token: string, refreshToken: string | null) => request<BackofficeMe>('POST', '/session', { token, ...(refreshToken ? { refresh_token: refreshToken } : {}) } satisfies SessionCreateBody),
  sessionConfig: () => request<SessionConfig>('GET', '/session/config'),
  setup: (body: SetupBody) => request<BackofficeMe>('POST', '/setup', body),
  /** Exchanges the emailed link's code for the session; only on an explicit click. */
  signInWithEmailLink: (tokenHash: string) => request<BackofficeMe>('POST', '/session/email-link', { token_hash: tokenHash }),
  requestMagicLink: (email: string) => request<MagicLinkAccepted>('POST', '/session/magic-link', { email }),
  signOut: () => request<undefined>('DELETE', '/session'),
  me: () => request<BackofficeMe>('GET', '/me'),
  applications: () => request<ApplicationRow[]>('GET', '/applications'),
  application: (id: string) => request<ApplicationDetail>('GET', `/applications/${id}`),
  /** The request's journey: rebuilt on every request. */
  applicationTimeline: (id: string) => request<ApplicationTimeline>('GET', `/applications/${id}/timeline`),
  correct: (id: string, corrections: CorrectionInput[], documentId?: string) => request<{ batch: string; corrections: number }>('POST', `/applications/${id}/corrections`, { corrections, ...(documentId ? { document_id: documentId } : {}) }),
  discard: (id: string, reason: DiscardReason) => request<{ id: string; status: 'not_qualified' }>('POST', `/applications/${id}/discard`, { reason }),
  clarifications: () => request<ClarificationItem[]>('GET', '/clarifications'),
  answer: (id: string, answers: OwnerAnswer[]) => request<{ id: string; complete: boolean }>('POST', `/clarifications/${id}/answers`, { answers }),
  policyVersions: () => request<PolicyVersionItem[]>('GET', '/policies/versions'),
  createDraft: (document: unknown) => request<{ id: string; version: number; status: string }>('POST', '/policies/versions', { document }),
  simulate: (id: string) => request<SimulationReport>('POST', `/policies/versions/${id}/simulate`),
  shadow: (id: string) => request<{ id: string; status: string }>('POST', `/policies/versions/${id}/shadow`),
  activate: (id: string) => request<{ id: string; status: string }>('POST', `/policies/versions/${id}/activate`),
  prompts: () => request<PromptCatalogResponse>('GET', '/prompts'),
  prompt: (name: string) => request<PromptDetail>('GET', `/prompts/${name}`),
  promptDiff: (name: string, from: string, to: string) => request<PromptDiff>('GET', `/prompts/${name}/diff${queryString({ from, to })}`),
  createPromptVersion: (name: string, body: PromptVersionCreateBody) => request<PromptVersionItem>('POST', `/prompts/${name}/versions`, body),
  activatePromptVersion: (name: string, id: string) => request<PromptActivated>('POST', `/prompts/${name}/versions/${id}/activate`),
  recordOutcome: (body: { application_id: string; outcome: 'paid' | 'late' | 'default' | 'fraud'; observed_at: string }) => request<{ ok: true }>('POST', '/outcomes', body),
  audit: () => request<AuditEntry[]>('GET', '/audit'),
  /** The lender's queue jobs, newest first (`Trabajos` tab). */
  jobs: (q: JobListQuery) => request<JobItem[]>('GET', `/jobs${queryString(q)}`),
  llmExchanges: (q: LlmExchangeListQuery) => request<LlmExchangeRow[]>('GET', `/llm-exchanges${queryString(q)}`),
  llmExchange: (id: string) => request<LlmExchangeDetail>('GET', `/llm-exchanges/${id}`),
  suppliers: () => request<SupplierRow[]>('GET', '/suppliers'),
  supplier: (id: string) => request<SupplierDetail>('GET', `/suppliers/${id}`),
  /** Opens a request with the statement and, if given, the amount; processing starts right away. */
  uploadStatement: (supplierId: string, file: File, amount: number | null) => uploadPdf<SupplierStatementUploaded>(`/suppliers/${supplierId}/statements${queryString({ amount: amount === null ? undefined : String(amount) })}`, file),
  statementStatus: (supplierId: string, applicationId: string) => request<SupplierStatementStatus>('GET', `/suppliers/${supplierId}/statements/${applicationId}`),
  createSupplier: (body: SupplierCreateBody) => request<{ id: string }>('POST', '/suppliers', body),
  updateSupplier: (id: string, body: SupplierUpdateBody) => request<{ id: string; fields: string[] }>('PATCH', `/suppliers/${id}`, body),
  deleteSupplier: (id: string) => request<SupplierDeleted>('DELETE', `/suppliers/${id}`),
  settings: () => request<TenantSettings>('GET', '/settings'),
  updateSettings: (body: TenantSettingsUpdateBody) => request<TenantSettings>('PATCH', '/settings', body),
  users: () => request<TenantUserItem[]>('GET', '/users'),
  addUser: (email: string) => request<TenantUserCreated>('POST', '/users', { email }),
  removeUser: (id: string) => request<undefined>('DELETE', `/users/${id}`),
  whatsapp: () => request<WhatsAppLinkState>('GET', '/whatsapp'),
  unlinkWhatsapp: () => request<WhatsAppUnlinkRequested>('POST', '/whatsapp/unlink'),
}

export const documentUrl = (documentId: string) => `/bo/v1/documents/${documentId}/file`
