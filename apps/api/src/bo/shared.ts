/**
 * Shared by the backoffice routers: dependencies, the session user, the per-actor audit log and
 * the Postgres errors translated to 409.
 */
import type { Db, Tx } from '@gow/db'
import { whatsappSessions } from '@gow/db'
import type { DocumentStorage, PgBoss } from '@gow/platform'
import { eq, sql } from 'drizzle-orm'
import type { Response } from 'express'
import type { AuthDirectory } from '../supabase-auth.ts'
import type { PromptEditors } from './prompts.ts'

export interface BackofficeDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  backofficeJwtSecret: string
  secureCookies?: boolean
  /** Backoffice origin for an invited user's access link (`BACKOFFICE_URL`). */
  backofficeUrl?: string | null
  /**
   * Supabase Auth: with it, adding a user creates their Auth account and they sign in with an
   * emailed link. Without it, the usual dev JWT link.
   */
  auth?: AuthDirectory | null
  /**
   * With Supabase Auth the session renews itself until `sessionMaxHours` after login
   * (`BACKOFFICE_SESSION_MAX_HOURS`, default 12) or `sessionIdleHours` without renewing
   * (`BACKOFFICE_SESSION_IDLE_HOURS`, default 8).
   */
  sessionMaxHours?: number
  sessionIdleHours?: number
  /** Who creates and activates prompt versions (`BACKOFFICE_PROMPT_EDITORS`). */
  promptEditors?: PromptEditors
  logger?: { error(message: string): void }
}

export interface Who {
  userId: string
  email: string
  tenantId: string
}

/** Display name for a supplier that registered over WhatsApp and has not yet confirmed its data. */
export const PENDING_SUPPLIER_NAME = 'Por confirmar (registro por WhatsApp)'

export const SUPPLIER_NOT_FOUND = 'proveedor no encontrado'

export const SESSION_SECONDS = 8 * 60 * 60
/** Backoffice route that finishes login: reads the token from the fragment and swaps it for the cookie. */
export const ENTER_PATH = '/entrar'

export const who = (res: Response) => res.locals.who as Who
export const actorOf = (w: Who) => `user:${w.userId}`
export const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

/** Postgres unique violation, direct or wrapped by Drizzle. */
export function uniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { code?: unknown }).code === '23505') return true
  }
  return false
}

/** With no heartbeat in this window the WhatsApp process is considered stopped (beats every ~10 s). */
export const WHATSAPP_STALE_SECONDS = 30

/**
 * WhatsApp session state for the tenant. Heartbeat and QR freshness use the database clock, the
 * same one the process writes with, so there is no skew between machines.
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

/** Backoffice origin without a trailing slash, to build an invited user's access link. */
export function backofficeBase(deps: BackofficeDeps): string {
  return (deps.backofficeUrl ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
}
