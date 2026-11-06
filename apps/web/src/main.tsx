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
 * La API renueva la sesión de Supabase Auth en cualquier petición (ADR 0036): las consultas que se
 * refrescan solas la mantienen viva sin hacer nada aquí. Una sesión terminada (límite absoluto,
 * inactividad, usuario quitado, salir) aparece como 401 en cualquier consulta: se vuelve a pedir
 * /me, y el Shell manda a /entrar cuando también responde 401.
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
