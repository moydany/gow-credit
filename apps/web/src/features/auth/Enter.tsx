import { MagicLinkBody } from '@gow/contracts'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { Icon, Logo } from '../../ui/icons'
import { Button } from '../../ui/primitives'

/**
 * What the URL carries when coming back from a sign-in link, always in the fragment (it never
 * reaches the server or the logs): `#token=` from the dev link, `#access_token=` from Supabase Auth
 * (implicit flow) or `#error=` if GoTrue rejected the link. With Supabase there is also a
 * `refresh_token`: it goes once to the API, which stores it encrypted in an HttpOnly cookie and
 * renews the session on its own. None of this is kept in the browser.
 */
function readReturn(): { token: string | null; refreshToken: string | null; failed: boolean } {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const query = new URLSearchParams(window.location.search)
  const supabase = hash.get('access_token')
  const token = supabase ?? hash.get('token')
  const refreshToken = supabase ? hash.get('refresh_token') : null
  const failed = hash.has('error') || hash.has('error_code') || query.has('error')
  return { token, refreshToken, failed }
}

type State = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string } | { kind: 'sent'; email: string }

export function Enter() {
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const config = useQuery({ queryKey: ['session-config'], queryFn: api.sessionConfig, retry: false, staleTime: 30_000 })
  const magicLink = config.data?.magic_link === true

  useEffect(() => {
    const back = readReturn()
    if (!back.token && !back.failed) return
    // Out of the address bar and history before anything else.
    window.history.replaceState(null, '', window.location.pathname)
    if (!back.token) {
      setState({ kind: 'error', message: 'El enlace ya venció o ya se usó' })
      return
    }
    setState({ kind: 'working' })
    api
      .signIn(back.token, back.refreshToken)
      .then(() => navigate({ to: '/' }))
      .catch((e: unknown) => {
        setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'No se pudo iniciar sesión' })
      })
  }, [navigate])

  // Empty system (first run): nobody to send a link to, so set up first.
  if (config.data?.setup_required) return <Navigate to="/configuracion-inicial" />

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="card rise w-full max-w-md p-8">
        <Logo size={44} />
        <h1 className="display mt-8 text-[34px]">
          Entrar al <span className="text-muted">backoffice</span>
        </h1>
        {state.kind === 'working' ? (
          <p className="mt-4 text-[15px] text-muted" role="status">
            Verificando tu enlace…
          </p>
        ) : state.kind === 'sent' ? (
          <Sent email={state.email} onAgain={() => { setState({ kind: 'idle' }) }} />
        ) : magicLink ? (
          <EmailForm error={state.kind === 'error' ? state.message : null} onSent={(email) => { setState({ kind: 'sent', email }) }} />
        ) : config.isPending ? (
          <p className="mt-4 text-[15px] text-muted" role="status">
            Cargando…
          </p>
        ) : (
          <DevLink error={state.kind === 'error' ? state.message : null} />
        )}
      </div>
    </div>
  )
}

/** With Supabase Auth: the email gets the link. The response is the same whether or not an account exists. */
function EmailForm({ error, onSent }: { error: string | null; onSent: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [tried, setTried] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const parsed = MagicLinkBody.safeParse({ email })
  const invalid = tried && !parsed.success

  return (
    <form
      noValidate
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (!parsed.success || pending) return
        setPending(true)
        setFailure(null)
        api
          .requestMagicLink(parsed.data.email)
          .then(() => { onSent(parsed.data.email) })
          .catch((err: unknown) => { setFailure(err instanceof ApiError ? err.message : 'No se pudo pedir el enlace') })
          .finally(() => { setPending(false) })
      }}
    >
      <p className="text-[15px] leading-relaxed text-muted">
        {error ? `${error}. ` : ''}Te mandamos un enlace de acceso a tu correo.
      </p>
      <label className="mt-6 block">
        <span className="text-[13px] font-medium text-ink-2">Correo</span>
        <input type="email" className="input mt-1.5 h-11" placeholder="tu@institucion.mx" value={email} onChange={(e) => { setEmail(e.target.value) }} aria-invalid={invalid} autoComplete="email" autoFocus />
        {invalid ? (
          <span role="alert" className="mt-1.5 block text-[12.5px] text-coral-ink">
            Escribe un correo válido
          </span>
        ) : null}
      </label>
      {failure ? (
        <p role="alert" className="mt-3 text-[13px] text-coral-ink">
          {failure}
        </p>
      ) : null}
      <Button type="submit" className="mt-6 w-full" disabled={pending}>
        <Icon name="mail" size={16} /> {pending ? 'Mandando…' : 'Mandar enlace'}
      </Button>
    </form>
  )
}

function Sent({ email, onAgain }: { email: string; onAgain: () => void }) {
  return (
    <>
      <p className="mt-4 text-[15px] leading-relaxed text-muted" role="status">
        Si <span className="font-medium text-ink">{email}</span> tiene acceso, te llegó un enlace. Ábrelo en este navegador: vence pronto y sirve una sola vez.
      </p>
      <Button variant="ghost" className="mt-6 w-full" onClick={onAgain}>
        Usar otro correo
      </Button>
    </>
  )
}

/** Without Supabase Auth: the link with the JWT printed by the CLI or given by whoever invites. */
function DevLink({ error }: { error: string | null }) {
  return (
    <>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        {error ? `${error}. ` : ''}Abre el enlace de acceso que te dieron. Vence a las pocas horas; si ya venció, pide otro a quien administra tu cuenta.
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
  )
}
