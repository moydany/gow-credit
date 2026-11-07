/**
 * WhatsApp session status published to `app.whatsapp_sessions`, so a tenant user can link the
 * number by scanning the QR in the backoffice settings.
 *
 * - Each transport connection event becomes a row: `waiting_qr` with the QR and its expiry, `open`
 *   with the linked number, `closed` or `logged_out`.
 * - A heartbeat every ~10 s shows the process is alive (database clock, not the process's).
 * - Every ~3 s it checks for an unlink request: logs out of WhatsApp, wipes local state and starts
 *   a fresh session that emits a new QR.
 *
 * None of this reaches the logs: neither the QR nor the number, only error codes.
 */
import { whatsappSessions, withTenant, type Db } from '@gow/db'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { WhatsAppTransport } from './relay.ts'

/** What the transport reports about its connection. */
export type LinkEvent = { type: 'connecting' } | { type: 'qr'; qr: string } | { type: 'open' } | { type: 'close'; loggedOut: boolean }

/** A transport linked by QR: Baileys in production, a fake in tests. */
export interface LinkableTransport extends WhatsAppTransport {
  onLinkEvent(listener: (e: LinkEvent) => void): void
  /** Linked account number (+52...) while the session is open; null otherwise. */
  linkedNumber(): string | null
  /** Logs out of WhatsApp, wipes local state and starts a fresh session that asks for a QR. */
  unlink(): Promise<void>
}

/** Baileys gives the first QR 60 s of life and later ones 20 s; a new QR replaces the row. */
export const QR_TTL_SECONDS = 60
export const HEARTBEAT_MS = 10_000
export const UNLINK_POLL_MS = 3_000

type SessionValues = Partial<Pick<typeof whatsappSessions.$inferInsert, 'status' | 'qr' | 'linkedNumber'>> & { qrExpiresAt?: SQL | null }

const errorName = (e: unknown) => (e instanceof Error ? ((e as { code?: unknown }).code as string | undefined) ?? e.name : 'error')

export class SessionPublisher {
  readonly #db: Db
  readonly #tenantId: string
  readonly #transport: LinkableTransport
  readonly #onError: (message: string) => void
  readonly #onStatus: (status: string) => void
  #chain: Promise<void> = Promise.resolve()
  #unlinkBusy = false
  #stopped = false

  constructor(opts: { db: Db; tenantId: string; transport: LinkableTransport; onError?: (message: string) => void; onStatus?: (status: string) => void }) {
    this.#db = opts.db
    this.#tenantId = opts.tenantId
    this.#transport = opts.transport
    this.#onError = opts.onError ?? (() => undefined)
    this.#onStatus = opts.onStatus ?? (() => undefined)
    opts.transport.onLinkEvent((e) => void this.handle(e))
  }

  /**
   * Writes are serialized: events arrive faster than they are written and order matters. An error
   * is reported by code and doesn't stop the process.
   */
  #enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.#chain.then(fn).catch((e: unknown) => {
      this.#onError(`sesión: ${errorName(e)}`)
      return undefined
    })
    this.#chain = run.then(() => undefined)
    return run
  }

  /** Upserts the tenant's row. */
  async #upsert(values: SessionValues, opts: { heartbeat: boolean; touch: boolean }): Promise<void> {
    const set = {
      ...values,
      ...(opts.heartbeat ? { heartbeatAt: sql`now()` } : {}),
      ...(opts.touch ? { updatedAt: sql`now()` } : {}),
    }
    await this.#enqueue(() =>
      withTenant(this.#db, this.#tenantId, (tx) =>
        tx
          .insert(whatsappSessions)
          .values({ tenantId: this.#tenantId, ...set })
          .onConflictDoUpdate({ target: whatsappSessions.tenantId, set }),
      ),
    )
  }

  #status(values: SessionValues): Promise<void> {
    if (values.status) this.#onStatus(values.status)
    return this.#upsert(values, { heartbeat: true, touch: true })
  }

  /** On startup (and after an unlink restart): no QR yet. */
  starting(): Promise<void> {
    return this.#status({ status: 'starting', qr: null, qrExpiresAt: null })
  }

  handle(e: LinkEvent): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    switch (e.type) {
      case 'connecting':
        return this.#status({ status: 'starting', qr: null, qrExpiresAt: null })
      case 'qr':
        return this.#status({ status: 'waiting_qr', qr: e.qr, qrExpiresAt: sql`now() + make_interval(secs => ${QR_TTL_SECONDS})` })
      case 'open':
        return this.#status({ status: 'open', qr: null, qrExpiresAt: null, linkedNumber: this.#transport.linkedNumber() })
      case 'close':
        return this.#status(e.loggedOut ? { status: 'logged_out', qr: null, qrExpiresAt: null, linkedNumber: null } : { status: 'closed', qr: null, qrExpiresAt: null })
    }
  }

  heartbeat(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    return this.#upsert({}, { heartbeat: true, touch: false })
  }

  /**
   * Handles an unlink request newer than the last one handled. It is marked handled in the same
   * statement that claims it, so a process restart doesn't close a freshly linked session.
   */
  async checkUnlink(): Promise<boolean> {
    if (this.#unlinkBusy || this.#stopped) return false
    this.#unlinkBusy = true
    try {
      const claimed = await this.#enqueue(() =>
        withTenant(this.#db, this.#tenantId, (tx) =>
          tx
            .update(whatsappSessions)
            .set({ unlinkHandledAt: sql`${whatsappSessions.unlinkRequestedAt}`, status: 'starting', qr: null, qrExpiresAt: null, linkedNumber: null, heartbeatAt: sql`now()`, updatedAt: sql`now()` })
            .where(and(eq(whatsappSessions.tenantId, this.#tenantId), sql`${whatsappSessions.unlinkRequestedAt} > coalesce(${whatsappSessions.unlinkHandledAt}, '-infinity'::timestamptz)`))
            .returning({ tenantId: whatsappSessions.tenantId }),
        ),
      )
      if (!claimed?.length) return false
      this.#onStatus('unlink_requested')
      try {
        await this.#transport.unlink()
      } catch (e) {
        this.#onError(`desvincular: ${errorName(e)}`)
      }
      return true
    } finally {
      this.#unlinkBusy = false
    }
  }

  /** Clean shutdown: with no heartbeat or QR, the backoffice shows at once that the process is down. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#onStatus('closed')
    await this.#enqueue(() =>
      withTenant(this.#db, this.#tenantId, (tx) => tx.update(whatsappSessions).set({ status: 'closed', qr: null, qrExpiresAt: null, heartbeatAt: null, updatedAt: sql`now()` }).where(eq(whatsappSessions.tenantId, this.#tenantId))),
    )
  }
}

/** Starts publishing status now, with the heartbeat and unlink check running in the background. */
export async function startSessionPublisher(opts: {
  db: Db
  tenantId: string
  transport: LinkableTransport
  heartbeatMs?: number
  unlinkPollMs?: number
  onError?: (message: string) => void
  onStatus?: (status: string) => void
}): Promise<{ publisher: SessionPublisher; stop(): Promise<void> }> {
  const publisher = new SessionPublisher(opts)
  await publisher.starting()
  const beat = setInterval(() => void publisher.heartbeat(), opts.heartbeatMs ?? HEARTBEAT_MS)
  const poll = setInterval(() => {
    publisher.checkUnlink().catch((e: unknown) => opts.onError?.(`desvincular: ${errorName(e)}`))
  }, opts.unlinkPollMs ?? UNLINK_POLL_MS)
  return {
    publisher,
    stop: async () => {
      clearInterval(beat)
      clearInterval(poll)
      await publisher.stop()
    },
  }
}
