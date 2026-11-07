/**
 * El tenant de este proceso de WhatsApp. Con `WHATSAPP_TENANT_ID` se usa ese (varios prestamistas, o
 * Cloud Run). Sin él, el proceso lo descubre: si existe exactamente un tenant, es ese; si todavía no
 * existe ninguno (primer inicio: el wizard del backoffice aún no lo crea), espera a que aparezca. Con
 * más de uno no adivina: se detiene y pide la variable. El rol de WhatsApp no lee `tenants`; pregunta
 * a `app.sole_tenant()` (ADR 0060).
 */
import type { Db } from '@gow/db'
import { sql } from 'drizzle-orm'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ResolveTenantOptions {
  db: Db
  /** `WHATSAPP_TENANT_ID`, si está definida. */
  configured?: string | undefined
  /** Cada cuánto vuelve a preguntar mientras no exista el tenant. */
  pollMs?: number
  /** Avisos de estado (sin datos): "esperando", "descubierto". */
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
