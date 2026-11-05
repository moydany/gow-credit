/**
 * Bases de prueba: una base nueva por suite en el Postgres de docker compose, migrada desde cero.
 * Si no hay Postgres (`docker compose up`), las suites que la usan se saltan con aviso.
 */
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { databaseUrl, type DbRole } from './client.ts'
import { runMigrations } from './migrate.ts'

export interface TestDatabase {
  name: string
  url(role: DbRole): string
  drop(): Promise<void>
}

/** ¿Hay Postgres local? Para `describe.skipIf`. */
export async function postgresAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl('admin'), connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

export async function createTestDatabase(prefix = 'gow_test'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: databaseUrl('admin') })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  await runMigrations(databaseUrl('admin', { database: name }))
  return {
    name,
    url: (role) => databaseUrl(role, { database: name }),
    drop: async () => {
      const c = new pg.Client({ connectionString: databaseUrl('admin') })
      await c.connect()
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await c.end()
    },
  }
}
