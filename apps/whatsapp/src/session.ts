/**
 * Estado de la sesión de WhatsApp publicado en `app.whatsapp_sessions` (ADR 0033), para que un
 * usuario del tenant vincule el número escaneando el QR desde Configuración en el backoffice.
 *
 * - Cada evento de conexión del transporte se vuelve una fila: `waiting_qr` con el QR y su
 *   caducidad, `open` con el número vinculado, `closed` o `logged_out`.
 * - Un latido cada ~10 s dice que el proceso está vivo (reloj de la base, no del proceso).
 * - Cada ~3 s se revisa si alguien pidió desvincular: se cierra la sesión en WhatsApp, se borra el
 *   estado local y arranca una sesión nueva que emite un QR nuevo.
 *
 * Nada de esto va a registros: ni el QR ni el número; solo códigos de error.
 */
import { whatsappSessions, withTenant, type Db } from '@gow/db'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { WhatsAppTransport } from './relay.ts'

/** Lo que el transporte reporta de su conexión. */
export type LinkEvent = { type: 'connecting' } | { type: 'qr'; qr: string } | { type: 'open' } | { type: 'close'; loggedOut: boolean }

/** Un transporte que se vincula por QR: Baileys hoy; un doble en las pruebas. */
export interface LinkableTransport extends WhatsAppTransport {
  onLinkEvent(listener: (e: LinkEvent) => void): void
  /** Número de la cuenta vinculada (+52...) con la sesión abierta; null si no hay. */
  linkedNumber(): string | null
  /** Cierra la sesión en WhatsApp, borra el estado local y arranca una sesión nueva que pide QR. */
  unlink(): Promise<void>
}

/** Baileys manda el primer QR con 60 s de vida y los siguientes con 20 s; uno nuevo reemplaza la fila. */
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
   * Escrituras en serie: los eventos llegan más rápido de lo que se escriben y el orden importa. Un
   * error se reporta por su código y no corta el proceso.
   */
  #enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.#chain.then(fn).catch((e: unknown) => {
      this.#onError(`sesión: ${errorName(e)}`)
      return undefined
    })
    this.#chain = run.then(() => undefined)
    return run
  }

  /** Upsert de la fila del tenant. */
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

  /** Al arrancar (y al volver a empezar tras desvincular): sin QR todavía. */
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
   * Atiende una petición de desvincular más nueva que la última atendida. Se marca como atendida en
   * la misma sentencia que la reclama (en la base, sin perder microsegundos en el camino), así que un
   * reinicio del proceso no vuelve a cerrar una sesión recién vinculada.
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

  /** Apagado limpio: sin latido ni QR, el backoffice muestra de inmediato que el proceso no corre. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#onStatus('closed')
    await this.#enqueue(() =>
      withTenant(this.#db, this.#tenantId, (tx) => tx.update(whatsappSessions).set({ status: 'closed', qr: null, qrExpiresAt: null, heartbeatAt: null, updatedAt: sql`now()` }).where(eq(whatsappSessions.tenantId, this.#tenantId))),
    )
  }
}

/** Publica el estado desde ya, con latido y revisión de desvincular en segundo plano. */
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
