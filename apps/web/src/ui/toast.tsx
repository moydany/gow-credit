import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Icon } from './icons'

interface Toast {
  id: number
  kind: 'ok' | 'error'
  text: string
}
const Ctx = createContext<{ ok(text: string): void; error(text: string): void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, kind, text }])
    setTimeout(() => {
      setItems((x) => x.filter((t) => t.id !== id))
    }, kind === 'error' ? 7000 : 4000)
  }, [])
  const api = useMemo(() => ({ ok: (t: string) => { push('ok', t) }, error: (t: string) => { push('error', t) } }), [push])
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('animate-rise pointer-events-auto flex max-w-md items-center gap-3 rounded-full py-2.5 pl-3 pr-5 text-[14px] font-medium shadow-pop', t.kind === 'ok' ? 'bg-ink text-white' : 'bg-coral-soft text-coral-ink')}>
            <span className={clsx('grid size-6 place-items-center rounded-full', t.kind === 'ok' ? 'bg-lime text-ink' : 'bg-coral text-white')}>
              <Icon name={t.kind === 'ok' ? 'check' : 'alert'} size={14} />
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  const c = useContext(Ctx)
  if (!c) throw new Error('falta ToastProvider')
  return c
}
