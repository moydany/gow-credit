/**
 * Conexión por rol (docs/05 §2): cada proceso usa el rol que le toca y nunca el de migraciones.
 * Toda consulta de negocio va dentro de `withTenant`, que fija `app.tenant_id` para la
 * transacción; sin él las políticas RLS no devuelven filas aunque el código tenga un bug.
 */
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type DbRole = 'admin' | 'api' | 'worker' | 'whatsapp' | 'readonly' | 'queue' | 'mastra'

/** Postgres local de docker compose (puerto 54330); en Supabase cada URL viene del entorno. */
export const LOCAL_DATABASE = 'postgres://127.0.0.1:54330/gow'

const LOCAL_CREDENTIALS: Record<DbRole, string> = {
  admin: 'postgres:postgres',
  api: 'gow_api:gow_api_dev',
  worker: 'gow_worker:gow_worker_dev',
  whatsapp: 'gow_whatsapp:gow_whatsapp_dev',
  readonly: 'gow_readonly:gow_readonly_dev',
  queue: 'gow_queue:gow_queue_dev',
  mastra: 'gow_mastra:gow_mastra_dev',
}

const ENV_NAME: Record<DbRole, string> = {
  admin: 'DATABASE_ADMIN_URL',
  api: 'DATABASE_URL_API',
  worker: 'DATABASE_URL_WORKER',
  whatsapp: 'DATABASE_URL_WHATSAPP',
  readonly: 'DATABASE_URL_READONLY',
  queue: 'DATABASE_URL_QUEUE',
  mastra: 'DATABASE_URL_MASTRA',
}

/** URL de un rol contra una base: la del entorno, o la local de desarrollo con esa base. */
export function databaseUrl(role: DbRole, opts: { database?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env
  const fromEnv = env[ENV_NAME[role]]?.trim()
  const base = new URL(fromEnv || LOCAL_DATABASE)
  if (!fromEnv) {
    const [user, password] = LOCAL_CREDENTIALS[role].split(':')
    base.username = user ?? ''
    base.password = password ?? ''
  }
  if (opts.database) base.pathname = `/${opts.database}`
  return base.toString()
}

export type Db = NodePgDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Database {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

/** Registro por omisión de un error en una conexión inactiva: solo el código de Postgres, sin datos. */
function logIdleError(err: Error & { code?: string }): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'db_idle_client_error', code: err.code ?? null })}\n`)
}

/**
 * Pool de un rol. Una conexión inactiva puede morir del lado del servidor (reinicio, failover,
 * `pg_terminate_backend`, `DROP DATABASE ... WITH (FORCE)` en las pruebas): el pool la descarta y
 * reemite el error. Sin este manejador ese `error` no tiene quién lo escuche y tumba el proceso.
 */
export function connect(url: string, opts: { max?: number; onIdleError?: (err: Error & { code?: string }) => void } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 })
  pool.on('error', opts.onIdleError ?? logIdleError)
  const db = drizzle(pool, { schema })
  return { db, pool, close: () => pool.end() }
}

/** Corre `fn` en una transacción con `app.tenant_id` fijado: es la única forma de leer o escribir datos de negocio. */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}
