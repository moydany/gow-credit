import clsx from 'clsx'
import { useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import type { ApplicationStatus, DecisionStatus } from '@gow/contracts'
import { APPLICATION_STATUS_LABEL, DECISION_LABEL } from '../lib/format'
import { Icon, type IconName } from './icons'

export function Card({ className, rise, children, ...rest }: HTMLAttributes<HTMLElement> & { rise?: number }) {
  return (
    <section className={clsx('card', rise !== undefined && 'rise', className)} style={rise === undefined ? undefined : ({ '--i': rise } as React.CSSProperties)} {...rest}>
      {children}
    </section>
  )
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 px-6 pt-5">
      <div className="min-w-0">
        <h2 className="text-[17px] font-medium leading-tight tracking-tight">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  )
}

type Tone = 'lime' | 'indigo' | 'amber' | 'coral' | 'ink' | 'hatch' | 'plain'
const TONE: Record<Tone, string> = {
  lime: 'bg-lime text-ink',
  indigo: 'bg-indigo-soft text-indigo-ink',
  amber: 'bg-amber-soft text-amber-ink',
  coral: 'bg-coral-soft text-coral-ink',
  ink: 'bg-ink text-white',
  hatch: 'hatch text-ink-2',
  plain: 'bg-sunken text-ink-2',
}
const DOT: Record<Tone, string> = { lime: 'bg-lime-ink', indigo: 'bg-indigo', amber: 'bg-amber', coral: 'bg-coral', ink: 'bg-lime', hatch: 'bg-muted', plain: 'bg-muted' }

export function Chip({ tone = 'plain', dot, icon, children, className }: { tone?: Tone; dot?: boolean; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-none', TONE[tone], className)}>
      {dot ? <span className={clsx('size-1.5 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" /> : null}
      {icon ? <Icon name={icon} size={13} /> : null}
      <span className="truncate">{children}</span>
    </span>
  )
}

const STATUS_TONE: Record<ApplicationStatus | DecisionStatus, Tone> = {
  received: 'hatch',
  extracting: 'hatch',
  extracted: 'hatch',
  deciding: 'hatch',
  needs_clarification: 'indigo',
  human_review: 'amber',
  qualified: 'lime',
  qualified_with_limit: 'lime',
  not_qualified: 'coral',
  failed: 'ink',
}

/** El estado siempre lleva punto y texto: el color nunca es la única señal. */
export function StatusChip({ status, decision }: { status: ApplicationStatus | DecisionStatus; decision?: boolean }) {
  const label = decision ? DECISION_LABEL[status as DecisionStatus] : APPLICATION_STATUS_LABEL[status]
  const tone = STATUS_TONE[status]
  const busy = status === 'received' || status === 'extracting' || status === 'extracted' || status === 'deciding'
  return (
    <Chip tone={tone} dot className={clsx(busy && '[&>span:first-child]:animate-pulse-soft')}>
      {label}
    </Chip>
  )
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'lime' | 'ghost' | 'quiet' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium transition-[transform,background-color,box-shadow] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
        size === 'md' ? 'h-11 px-5 text-[14px]' : 'h-9 px-4 text-[13px]',
        variant === 'primary' && 'bg-ink text-white hover:bg-ink-2',
        variant === 'lime' && 'bg-lime text-ink hover:brightness-95',
        variant === 'ghost' && 'border border-line bg-card text-ink hover:bg-sunken',
        variant === 'quiet' && 'text-ink-2 hover:bg-sunken',
        variant === 'danger' && 'bg-coral-soft text-coral-ink hover:brightness-95',
        className,
      )}
    />
  )
}

/** Botón redondo de ícono (flechas, cerrar): objetivo táctil de 40 px. */
export function IconButton({ icon, label, className, ...rest }: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={clsx('inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink transition-[transform,background-color] duration-150 hover:bg-sunken active:scale-95 disabled:opacity-40', className)}>
      <Icon name={icon} />
    </button>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden="true" />
}

export function EmptyState({ icon = 'file', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="hatch grid size-14 place-items-center rounded-2xl text-ink-2">
        <Icon name={icon} size={22} />
      </div>
      <p className="text-[15px] font-medium">{title}</p>
      {children ? <p className="max-w-sm text-[13.5px] text-muted">{children}</p> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-coral-soft text-coral-ink">
        <Icon name="alert" size={22} />
      </div>
      <p className="text-[15px] font-medium">No se pudo cargar</p>
      <p className="max-w-sm text-[13.5px] text-muted">{message}</p>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      ) : null}
    </div>
  )
}

/** Barra segmentada como la de la referencia: lo hecho en color y lo pendiente rayado. */
export function SegmentBar({ segments, className }: { segments: { value: number; className: string; label: string }[]; className?: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  return (
    <div className={clsx('flex h-3.5 w-full gap-1 overflow-hidden rounded-full bg-sunken p-0.5', className)} role="img" aria-label={segments.map((s) => `${s.label}: ${String(s.value)}`).join(', ')}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div key={s.label} className={clsx('h-full rounded-full', s.className)} style={{ flexGrow: total ? s.value : 1, flexBasis: 0, minWidth: 8 }} />
        ))}
    </div>
  )
}

export function Meter({ value, max = 100, tone = 'lime', hatch = false }: { value: number; max?: number; tone?: 'lime' | 'indigo'; hatch?: boolean }) {
  const w = Math.max(0, Math.min(1, max === 0 ? 0 : value / max))
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-sunken" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={clsx('h-full rounded-full', hatch ? 'hatch' : tone === 'lime' ? 'bg-lime' : 'bg-indigo')} style={{ width: `${String(w * 100)}%` }} />
    </div>
  )
}

export function Stat({ label, value, hint, children }: { label: string; value: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col justify-between gap-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[17px] font-medium tracking-tight">{label}</h2>
      </div>
      <div>
        <p className="display tnum text-[44px] sm:text-[52px]">{value}</p>
        {hint ? <p className="mt-2 text-[13px] text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  )
}

/** Diálogo modal nativo: trampa de foco y Esc gratis. Se cierra con clic en el fondo. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      // El contenido se pinta al abrir: el foco inicial va al primer campo, no al botón de cerrar.
      d.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea')?.focus()
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      className={clsx('animate-rise m-auto max-h-[92dvh] w-[calc(100%-2rem)] overflow-hidden rounded-[32px] bg-frame p-0 text-ink shadow-pop backdrop:bg-ink/40 backdrop:backdrop-blur-[3px]', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      {open ? (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-center justify-between gap-4 px-6 pb-2 pt-5">
            <h2 className="text-[19px] font-medium tracking-tight">{title}</h2>
            <IconButton icon="x" label="Cerrar" onClick={onClose} />
          </div>
          <div className="scroll-thin overflow-y-auto px-6 pb-6">{children}</div>
        </div>
      ) : null}
    </dialog>
  )
}
