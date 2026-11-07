import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './lib/api'
import { router } from './router'
import { ToastProvider } from './ui/toast'

/**
 * The API renews the Supabase Auth session on any request, so queries that refresh themselves keep
 * it alive without anything here. An ended session (absolute limit, inactivity, removed user,
 * sign-out) shows up as a 401 on any query: `/me` is requested again, and the Shell redirects to
 * /entrar when it also answers 401.
 */
const onUnauthorized = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401) void queryClient.invalidateQueries({ queryKey: ['me'] })
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => { if (query.queryKey[0] !== 'me') onUnauthorized(err) } }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 3000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('falta #root')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
