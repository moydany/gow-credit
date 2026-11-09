/**
 * Link the tenant's WhatsApp by scanning the QR from Settings. The WhatsApp process publishes its
 * session state; this card reads it and shows, as the case may be, how to start the process, the
 * QR, the linked number with "Desvincular", or what to do after a logout.
 *
 * The QR is drawn on a canvas in the browser (no third-party services or `data:` URLs) and is not
 * stored anywhere: whoever scans it links their account to the lender's bot.
 */
import type { TenantSettings, WhatsAppLinkState } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { useWhatsApp } from '../../lib/queries'
import { Icon } from '../../ui/icons'
import { Button, Chip, ErrorState, Modal, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'

function Command({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-card px-1.5 py-0.5 font-mono text-[12px] text-ink">{children}</code>
}

function QrCanvas({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    setFailed(false)
    QRCode.toCanvas(ref.current, value, { width: 232, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#14171f', light: '#ffffff' } }).catch(() => {
      setFailed(true)
    })
  }, [value])
  return (
    <div className="grid size-[248px] shrink-0 place-items-center rounded-3xl bg-white p-2 shadow-[0_1px_2px_rgb(20_23_31/0.08)]">
      {failed ? <p className="px-6 text-center text-[13px] text-coral-ink">No se pudo dibujar el código. Recarga la página.</p> : <canvas ref={ref} role="img" aria-label="Código QR para vincular WhatsApp" className="size-[232px]" />}
    </div>
  )
}

const STEPS = ['Abre WhatsApp en el teléfono del número de la institución crediticia.', 'Ve a Ajustes (o Configuración) → Dispositivos vinculados.', 'Toca Vincular un dispositivo y apunta la cámara a este código.']

function StatusChip({ s }: { s: WhatsAppLinkState }) {
  if (!s.process_running) return <Chip tone="amber" dot>Proceso detenido</Chip>
  if (s.unlink_pending) return <Chip tone="indigo" dot>Desvinculando…</Chip>
  switch (s.status) {
    case 'open':
      return <Chip tone="accent" dot>{s.linked_number ?? 'Vinculado'}</Chip>
    case 'waiting_qr':
      return <Chip tone="indigo" dot>Esperando escaneo</Chip>
    case 'closed':
      return <Chip tone="amber" dot>Reconectando</Chip>
    case 'logged_out':
      return <Chip tone="coral" dot>Sesión cerrada</Chip>
    default:
      return <Chip tone="plain" dot>Conectando</Chip>
  }
}

function ProcessStoppedView({ data, tenantId }: { data: WhatsAppLinkState; tenantId: string }) {
  return (
    <div className="mt-2.5 space-y-2 text-[13px] leading-relaxed text-muted">
      <p>
        Para vincular el número, el proceso de WhatsApp de esta institución crediticia tiene que estar corriendo. En desarrollo: <Command>pnpm whatsapp</Command>; la encuentra por sí solo. Si hay varias, agrega <Command>WHATSAPP_TENANT_ID={tenantId}</Command>, que también fija el tenant en producción (servicio <Command>whatsapp</Command> de Cloud Run, con una instancia fija).
      </p>
      <p>
        {data.status === null ? 'Nunca ha corrido para esta institución crediticia.' : `Su último estado fue a las ${dateTime(data.updated_at ?? '')}.`} Esta tarjeta se actualiza sola en cuanto arranque; mientras tanto, las aclaraciones sin WhatsApp las respondes desde Aclaraciones.
      </p>
    </div>
  )
}

function WaitingQrView({ data }: { data: WhatsAppLinkState }) {
  return (
    <div className="mt-3 flex flex-wrap items-start gap-5">
      {data.qr ? (
        <QrCanvas value={data.qr} />
      ) : (
        <div className="grid size-[248px] shrink-0 place-items-center rounded-3xl bg-card text-center text-[13px] text-muted">
          <span className="animate-pulse-soft px-6">Esperando un código nuevo…</span>
        </div>
      )}
      <div className="min-w-0 flex-1 basis-56 text-[13px] leading-relaxed">
        <ol className="list-decimal space-y-1.5 pl-4 text-ink-2">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="mt-3 flex items-center gap-1.5 text-muted">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-indigo" /> El código cambia cada 20 a 60 segundos y esta pantalla lo actualiza sola.
        </p>
        <p className="hatch-amber mt-3 rounded-2xl px-3.5 py-2.5 text-amber-ink">
          Quien escanee este código vincula <strong>su</strong> WhatsApp al bot de esta institución crediticia: escanéalo solo con el teléfono del número dedicado. Ver el código queda en la bitácora.
        </p>
      </div>
    </div>
  )
}

function LinkedOpenView({ data, registered, onUnlink }: { data: WhatsAppLinkState; registered?: string | null; onUnlink: () => void }) {
  return (
    <div className="mt-2.5 space-y-3 text-[13px] leading-relaxed text-muted">
      <p>
        Vinculado con <span className="font-medium text-ink">{data.linked_number ?? 'un número'}</span>. Las aclaraciones salen por este número a los contactos verificados de cada proveedor.
      </p>
      {registered && data.linked_number && registered !== data.linked_number ? (
        <p className="hatch-amber rounded-2xl px-3.5 py-2.5 text-amber-ink">
          El número registrado de la institución crediticia es {registered}, distinto del vinculado. Los proveedores reciben los mensajes del vinculado.
        </p>
      ) : null}
      <Button size="sm" variant="quiet" onClick={onUnlink}>
        Desvincular
      </Button>
    </div>
  )
}

interface WhatsAppLinkBodyProps {
  data: WhatsAppLinkState
  settings: TenantSettings
  onUnlink: () => void
  onNewCode: () => void
  isUnlinking: boolean
}

function WhatsAppLinkBody({ data, settings, onUnlink, onNewCode, isUnlinking }: WhatsAppLinkBodyProps) {
  if (!data.process_running) {
    return <ProcessStoppedView data={data} tenantId={settings.tenant.id} />
  }
  if (data.unlink_pending) {
    return <p className="mt-2.5 text-[13px] leading-relaxed text-muted">Cerrando la sesión en WhatsApp. En unos segundos aparece aquí un código nuevo para vincular este u otro número.</p>
  }
  if (data.status === 'waiting_qr') {
    return <WaitingQrView data={data} />
  }
  if (data.status === 'open') {
    return <LinkedOpenView data={data} registered={settings.whatsapp.number} onUnlink={onUnlink} />
  }
  if (data.status === 'logged_out') {
    return (
      <div className="mt-2.5 space-y-3 text-[13px] leading-relaxed text-muted">
        <p>La sesión se cerró desde el teléfono o WhatsApp la dio de baja. Genera un código nuevo para vincular este u otro número; los mensajes pendientes esperan en el buzón.</p>
        <Button size="sm" variant="accent" disabled={isUnlinking} onClick={onNewCode}>
          Generar código nuevo
        </Button>
      </div>
    )
  }
  if (data.status === 'closed') {
    return <p className="mt-2.5 text-[13px] leading-relaxed text-muted">La conexión con WhatsApp se cortó y el proceso está reintentando solo. Si no vuelve en un par de minutos, revisa los registros del proceso.</p>
  }
  return (
    <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
      <span className="animate-pulse-soft">Conectando con WhatsApp…</span> En unos segundos aparece el número vinculado o un código para vincular.
    </p>
  )
}

interface UnlinkModalProps {
  open: boolean
  linkedNumber?: string | null
  isPending: boolean
  onClose: () => void
  onConfirm: () => void
}

function UnlinkModal({ open, linkedNumber, isPending, onClose, onConfirm }: UnlinkModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Desvincular WhatsApp">
      <p className="text-[14px] leading-relaxed text-ink-2">
        Se cierra la sesión de {linkedNumber ?? 'este número'} en WhatsApp (el teléfono deja de listar este dispositivo) y aquí aparece un código nuevo para vincular este u otro número. Mientras no se vincule, los mensajes a proveedores esperan en el buzón.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="danger" disabled={isPending} onClick={onConfirm}>
          Desvincular
        </Button>
      </div>
    </Modal>
  )
}

export function WhatsAppLink({ settings }: { settings: TenantSettings }) {
  const { data, isPending, isError, error, refetch } = useWhatsApp()
  const [confirming, setConfirming] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()
  const unlink = useMutation({
    mutationFn: api.unlinkWhatsapp,
    onSuccess: () => {
      setConfirming(false)
      void qc.invalidateQueries({ queryKey: ['whatsapp'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo pedir el cambio')
    },
  })

  return (
    <div className="inner p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[14.5px] font-medium">
          <Icon name="phone" size={16} /> WhatsApp
        </p>
        {data ? <StatusChip s={data} /> : null}
      </div>

      {isError && <ErrorState message={error.message} onRetry={() => void refetch()} />}
      {isPending && <Skeleton className="mt-3 h-16 rounded-2xl" />}
      {!isError && !isPending && (
        <WhatsAppLinkBody
          data={data}
          settings={settings}
          onUnlink={() => { setConfirming(true) }}
          onNewCode={() => { unlink.mutate() }}
          isUnlinking={unlink.isPending}
        />
      )}

      <UnlinkModal
        open={confirming}
        linkedNumber={data?.linked_number}
        isPending={unlink.isPending}
        onClose={() => { setConfirming(false) }}
        onConfirm={() => { unlink.mutate() }}
      />
    </div>
  )
}
