/**
 * The verifier `roles.ts` sends must be one Postgres accepts as a password: a role created with it
 * logs in with the plain password and not with another one. Skipped without Postgres.
 */
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseUrl } from './client.ts'
import { scramSha256Verifier } from './scram.ts'
import { postgresAvailable } from './testing.ts'

const available = await postgresAvailable()

describe('scramSha256Verifier', () => {
  it('tiene el formato de pg_authid y una sal nueva en cada llamada', () => {
    const v = scramSha256Verifier('secreto')
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/)
    expect(scramSha256Verifier('secreto')).not.toBe(v)
  })
})

describe.skipIf(!available)('scramSha256Verifier contra Postgres (necesita Postgres)', () => {
  const role = `gow_scram_${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  const admin = new pg.Client({ connectionString: databaseUrl('admin') })
  const login = async (pass: string) => {
    const url = new URL(databaseUrl('admin'))
    url.username = role
    url.password = pass
    const c = new pg.Client({ connectionString: url.toString() })
    try {
      await c.connect()
      return (await c.query<{ who: string }>('SELECT current_user AS who')).rows[0]?.who
    } finally {
      await c.end().catch(() => undefined)
    }
  }

  beforeAll(async () => {
    await admin.connect()
    await admin.query(`CREATE ROLE ${admin.escapeIdentifier(role)} LOGIN PASSWORD ${admin.escapeLiteral(scramSha256Verifier(password))}`)
  })
  afterAll(async () => {
    await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(role)}`)
    await admin.end()
  })

  it('entra con la contraseña y no con otra', async () => {
    await expect(login(password)).resolves.toBe(role)
    await expect(login('otra')).rejects.toThrow()
  })
})
