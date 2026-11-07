import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LlmExchangeListQuery } from '@gow/contracts'
import { api } from './api'

/** No Supabase Realtime yet: the inbox refreshes itself while the tab is visible. */
const LIVE = { refetchInterval: 6000, refetchIntervalInBackground: false } as const

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 5 * 60_000 })
export const useApplications = () => useQuery({ queryKey: ['applications'], queryFn: api.applications, ...LIVE })
export const useApplication = (id: string) => useQuery({ queryKey: ['application', id], queryFn: () => api.application(id), refetchInterval: 6000 })
/** Refreshes every 6 s only until the request reaches a final status. */
const FINAL: readonly string[] = ['qualified', 'qualified_with_limit', 'not_qualified', 'failed']
export const useApplicationTimeline = (id: string) =>
  useQuery({
    queryKey: ['timeline', id],
    queryFn: () => api.applicationTimeline(id),
    refetchInterval: (q) => (q.state.data && FINAL.includes(q.state.data.status) ? false : 6000),
    refetchIntervalInBackground: false,
  })
export const useClarifications = () => useQuery({ queryKey: ['clarifications'], queryFn: api.clarifications, ...LIVE })
export const usePolicyVersions = () => useQuery({ queryKey: ['policies'], queryFn: api.policyVersions })
export const usePrompts = () => useQuery({ queryKey: ['prompts'], queryFn: api.prompts })
export const usePrompt = (name: string | undefined) => useQuery({ queryKey: ['prompt', name], queryFn: () => api.prompt(name ?? ''), enabled: Boolean(name) })
export const usePromptDiff = (name: string, from: string | undefined, to: string | undefined) =>
  useQuery({ queryKey: ['prompt-diff', name, from, to], queryFn: () => api.promptDiff(name, from ?? '', to ?? ''), enabled: Boolean(from && to), staleTime: Infinity })
export const useAudit = () => useQuery({ queryKey: ['audit'], queryFn: api.audit })
export const useLlmExchanges = (q: LlmExchangeListQuery) => useQuery({ queryKey: ['llm-exchanges', q], queryFn: () => api.llmExchanges(q) })
/** Viewing the detail is audited: only on open, no background refreshes. */
export const useLlmExchange = (id: string | undefined) =>
  useQuery({ queryKey: ['llm-exchange', id], queryFn: () => api.llmExchange(id ?? ''), enabled: Boolean(id), staleTime: Infinity, refetchOnWindowFocus: false })
export const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: api.suppliers })
export const useSupplier = (id: string) => useQuery({ queryKey: ['supplier', id], queryFn: () => api.supplier(id) })
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings })
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: api.users })
/**
 * WhatsApp linking: every 2 s while waiting for the QR or a change, every 5 s with the process
 * stopped and every 15 s with the session open. Never in the background: viewing the QR is audited.
 */
export const useWhatsApp = () =>
  useQuery({
    queryKey: ['whatsapp'],
    queryFn: api.whatsapp,
    refetchIntervalInBackground: false,
    refetchInterval: (q) => {
      const s = q.state.data
      if (!s) return 5000
      if (!s.process_running) return 5000
      return s.status === 'open' && !s.unlink_pending ? 15_000 : 2000
    },
  })

export function useRefresh() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries()
}
