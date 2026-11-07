/**
 * Per-role connections: each process uses its own role and never the migration role. Every business
 * query goes through `withTenant`, which sets `app.tenant_id` for the transaction; without it the
 * RLS policies return no rows, even if the code has a bug.
 */
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type DbRole = 'admin' | 'api' | 'worker' | 'whatsapp' | 'readonly' | 'queue' | 'mastra'

/** Local docker compose Postgres (port 54330); on Supabase each URL comes from the environment. */
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

/** URL for a role against a database: the one from the environment, or the local dev one. */
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

/** Default log for an idle-connection error: the Postgres code only, no data. */
function logIdleError(err: Error & { code?: string }): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', event: 'db_idle_client_error', code: err.code ?? null })}\n`)
}

/**
 * Pool for one role. An idle connection can die server-side (restart, failover,
 * `pg_terminate_backend`, `DROP DATABASE ... WITH (FORCE)` in tests): the pool drops it and re-emits
 * the error. Without this handler nothing listens for that `error` and it crashes the process.
 */
export function connect(url: string, opts: { max?: number; onIdleError?: (err: Error & { code?: string }) => void } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 })
  pool.on('error', opts.onIdleError ?? logIdleError)
  const db = drizzle(pool, { schema })
  return { db, pool, close: () => pool.end() }
}

/** Runs `fn` in a transaction with `app.tenant_id` set: the only way to read or write business data. */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}
