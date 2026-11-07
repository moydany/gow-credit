/**
 * The tenant for this WhatsApp process. `WHATSAPP_TENANT_ID` wins (several lenders, or Cloud Run).
 * Without it the process discovers one: exactly one tenant means that one; none yet (first run,
 * before the backoffice wizard creates it) means wait for it to appear; more than one it won't
 * guess, so it stops and asks for the variable. The WhatsApp role can't read `tenants`; it calls
 * `app.sole_tenant()`.
 */
import type { Db } from '@gow/db'
import { sql } from 'drizzle-orm'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ResolveTenantOptions {
  db: Db
  /** `WHATSAPP_TENANT_ID`, if set. */
  configured?: string | undefined
  /** How often to ask again while no tenant exists. */
  pollMs?: number
  /** Status notices (no data): "waiting", "discovered". */
  onWaiting?: () => void
  signal?: AbortSignal
}

export async function resolveTenantId(opts: ResolveTenantOptions): Promise<string> {
  const configured = opts.configured?.trim()
  if (configured) {
    if (!UUID.test(configured)) throw new Error('WHATSAPP_TENANT_ID no es un UUID')
    return configured
  }
  let announced = false
  for (;;) {
    const found = await opts.db.execute<{ tenant: string | null }>(sql`select app.sole_tenant()::text as tenant`)
    const tenant = found.rows[0]?.tenant
    if (tenant) return tenant
    if (!announced) {
      announced = true
      opts.onWaiting?.()
    }
    if (opts.signal?.aborted) throw new Error('detenido antes de encontrar el tenant')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.pollMs ?? 3000)
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }
}
