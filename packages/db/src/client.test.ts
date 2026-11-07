/**
 * An idle connection the server terminates (restart, failover, DROP ... WITH (FORCE)) must not
 * crash the process: the pool drops it, reports via `onIdleError`, and the next query opens a new
 * one. Skipped without Postgres.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, databaseUrl } from './client.ts'
import { createTestDatabase, postgresAvailable, type TestDatabase } from './testing.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('pool de conexiones (necesita Postgres)', () => {
  let tdb: TestDatabase
  beforeAll(async () => { tdb = await createTestDatabase('gow_pool') })
  afterAll(async () => { await tdb.drop() })

  it('sobrevive a que el servidor termine una conexión inactiva y sigue respondiendo', async () => {
    const codes: (string | null)[] = []
    const database = connect(tdb.url('api'), { max: 1, onIdleError: (err) => codes.push(err.code ?? null) })
    try {
      const pid = (await database.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      const admin = new pg.Client({ connectionString: databaseUrl('admin') })
      await admin.connect()
      await admin.query('SELECT pg_terminate_backend($1)', [pid])
      await admin.end()
      await expect.poll(() => codes).toEqual(['57P01'])
      const again = await database.pool.query<{ one: number }>('SELECT 1 AS one')
      expect(again.rows[0]?.one).toBe(1)
    } finally {
      await database.close()
    }
  })
})
