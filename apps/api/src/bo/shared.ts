/**
 * Piezas que comparten los routers del backoffice (docs/08): dependencias, el usuario de la sesión,
 * la bitácora por actor y los errores de Postgres que se traducen a 409.
 */
import type { Db, Tx } from '@gow/db'
import { whatsappSessions } from '@gow/db'
import type { DocumentStorage, PgBoss } from '@gow/platform'
import { eq, sql } from 'drizzle-orm'
import type { Response } from 'express'
import type { AuthDirectory } from '../supabase-auth.ts'

export interface BackofficeDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  backofficeJwtSecret: string
  secureCookies?: boolean
  /** Origen del backoffice para el enlace de acceso de un usuario invitado (`BACKOFFICE_URL`). */
  backofficeUrl?: string | null
  /**
   * Supabase Auth (ADR 0035): con él, dar de alta a un usuario crea su cuenta de Auth y se entra con
   * un enlace que llega por correo. Sin él, el enlace con el JWT de desarrollo de siempre.
   */
  auth?: AuthDirectory | null
  /**
   * Con Supabase Auth la sesión se renueva sola (ADR 0036) hasta `sessionMaxHours` desde el login
   * (`BACKOFFICE_SESSION_MAX_HOURS`, 12 por defecto) o hasta `sessionIdleHours` sin renovarse
   * (`BACKOFFICE_SESSION_IDLE_HOURS`, 8 por defecto).
   */
  sessionMaxHours?: number
  sessionIdleHours?: number
  logger?: { error(message: string): void }
}

export interface Who {
  userId: string
  email: string
  tenantId: string
}

/** Nombre que se muestra de un proveedor que se registra por WhatsApp y aún no confirma sus datos (ADR 0047). */
export const PENDING_SUPPLIER_NAME = 'Por confirmar (registro por WhatsApp)'

export const SUPPLIER_NOT_FOUND = 'proveedor no encontrado'

export const SESSION_SECONDS = 8 * 60 * 60
/** Ruta del backoffice que termina el login: lee el token del fragmento y lo cambia por la cookie. */
export const ENTER_PATH = '/entrar'

export const who = (res: Response) => res.locals.who as Who
export const actorOf = (w: Who) => `user:${w.userId}`
export const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

/** Violación de unicidad de Postgres, venga directa o envuelta por Drizzle. */
export function uniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { code?: unknown }).code === '23505') return true
  }
  return false
}

/** Sin latido en este lapso, el proceso de WhatsApp se da por detenido (late cada ~10 s). */
export const WHATSAPP_STALE_SECONDS = 30

/**
 * Estado de la sesión de WhatsApp del tenant. Vigencia del latido y del QR con el reloj de la base,
 * el mismo con el que escribe el proceso: sin desfase entre máquinas.
 */
export async function whatsappSession(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({
      status: whatsappSessions.status,
      linkedNumber: whatsappSessions.linkedNumber,
      qr: whatsappSessions.qr,
      qrExpiresAt: whatsappSessions.qrExpiresAt,
      updatedAt: whatsappSessions.updatedAt,
      running: sql<boolean>`coalesce(${whatsappSessions.heartbeatAt} > now() - make_interval(secs => ${WHATSAPP_STALE_SECONDS}), false)`,
      qrFresh: sql<boolean>`coalesce(${whatsappSessions.qrExpiresAt} > now(), false)`,
      unlinkPending: sql<boolean>`coalesce(${whatsappSessions.unlinkRequestedAt} > coalesce(${whatsappSessions.unlinkHandledAt}, '-infinity'::timestamptz), false)`,
    })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.tenantId, tenantId))
  return row ?? null
}

/** Origen del backoffice sin barra final, para armar el enlace de acceso de un usuario invitado. */
export function backofficeBase(deps: BackofficeDeps): string {
  return (deps.backofficeUrl ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
}
