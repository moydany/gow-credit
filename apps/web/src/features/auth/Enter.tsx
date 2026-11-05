import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Icon, Logo } from '../../ui/icons'
import { Button } from '../../ui/primitives'

/** El enlace de acceso trae el JWT en el fragmento (`#token=`), que nunca viaja al servidor ni a los registros. */
export function Enter() {
  const navigate = useNavigate()
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    if (!token) return
    window.history.replaceState(null, '', window.location.pathname)
    setState('working')
    api
      .signIn(token)
      .then(() => navigate({ to: '/' }))
      .catch((e: unknown) => {
        setState('error')
        setMessage(e instanceof ApiError ? e.message : 'No se pudo iniciar sesión')
      })
  }, [navigate])

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="card rise w-full max-w-md p-8">
        <Logo size={44} />
        <h1 className="display mt-8 text-[34px]">
          Entrar al <span className="text-muted">backoffice</span>
        </h1>
        {state === 'working' ? (
          <p className="mt-4 text-[15px] text-muted" role="status">
            Verificando tu enlace…
          </p>
        ) : (
          <>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              {state === 'error' ? message + '. ' : ''}Abre el enlace de acceso que te llegó por correo. Vence a las pocas horas; si ya venció, pide otro a quien administra tu cuenta.
            </p>
            <div className="hatch mt-6 rounded-2xl p-4 text-[13px] text-ink-2">
              <p className="flex items-center gap-2 font-medium">
                <Icon name="bolt" size={15} /> En desarrollo
              </p>
              <code className="mt-2 block break-words font-mono text-[12px]">pnpm tenant user add --tenant &lt;id&gt; --email tu@correo.mx</code>
            </div>
            <Button className="mt-6 w-full" onClick={() => { window.location.reload() }}>
              Ya abrí el enlace
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
