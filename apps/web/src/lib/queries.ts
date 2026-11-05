import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

/** Sin Supabase Realtime todavía (docs/08 §2): la bandeja se refresca sola mientras la pestaña está visible. */
const LIVE = { refetchInterval: 6000, refetchIntervalInBackground: false } as const

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 5 * 60_000 })
export const useApplications = () => useQuery({ queryKey: ['applications'], queryFn: api.applications, ...LIVE })
export const useApplication = (id: string) => useQuery({ queryKey: ['application', id], queryFn: () => api.application(id), refetchInterval: 6000 })
export const useClarifications = () => useQuery({ queryKey: ['clarifications'], queryFn: api.clarifications, ...LIVE })
export const usePolicyVersions = () => useQuery({ queryKey: ['policies'], queryFn: api.policyVersions })
export const useAudit = () => useQuery({ queryKey: ['audit'], queryFn: api.audit })

export function useRefresh() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries()
}
