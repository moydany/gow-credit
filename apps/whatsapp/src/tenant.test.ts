/**
 * Discovering the tenant without `WHATSAPP_TENANT_ID`, as the `gow_whatsapp` role against real
 * Postgres: a single tenant is found, none makes it wait for the wizard's, and with several it
 * doesn't guess. The role can't read `tenants`; it only knows the function.
 */
import { randomUUID } from 'node:crypto'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTenantId } from './tenant.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('Tenant del proceso de WhatsApp (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let wa: Database
  let admin: pg.Client
  const addTenant = async (name: string) => {
    const id = randomUUID()
    await admin.query('INSERT INTO app.tenants (id, name) VALUES ($1, $2)', [id, name])
    return id
  }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    wa = connect(tdb.url('whatsapp'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
  }, 60_000)
  afterAll(async () => {
    await admin.end()
    await wa.close()
    await tdb.drop()
  })

  it('con la variable definida usa esa, sin preguntar; una que no es UUID falla', async () => {
    const id = randomUUID()
    expect(await resolveTenantId({ db: wa.db, configured: ` ${id} ` })).toBe(id)
    await expect(resolveTenantId({ db: wa.db, configured: 'no-es-uuid' })).rejects.toThrow('UUID')
  })

  it('sin ningún tenant espera, y en cuanto el wizard crea el primero lo descubre', async () => {
    let waited = 0
    const pending = resolveTenantId({ db: wa.db, pollMs: 20, onWaiting: () => { waited++ } })
    await new Promise((r) => setTimeout(r, 120))
    const id = await addTenant('Primero')
    expect(await pending).toBe(id)
    expect(waited).toBe(1)
  })

  it('con dos tenants no adivina: sigue esperando hasta que lo detengan', async () => {
    await addTenant('Segundo')
    const stop = new AbortController()
    const pending = resolveTenantId({ db: wa.db, pollMs: 20, signal: stop.signal })
    const settled = Promise.race([pending.then(() => 'resuelto', () => 'detenido'), new Promise((r) => { setTimeout(() => { r('esperando') }, 150) })])
    expect(await settled).toBe('esperando')
    stop.abort()
    await expect(pending).rejects.toThrow('detenido')
  })

  it('el rol de WhatsApp sigue sin leer tenants y la función solo la ejecutan él', async () => {
    const direct = await wa.pool.query('SELECT 1 FROM app.tenants').then(() => 'leyó', () => 'denegado')
    expect(direct).toBe('denegado')
    const api = new pg.Client({ connectionString: tdb.url('api') })
    await api.connect()
    const viaApi = await api.query('SELECT app.sole_tenant()').then(() => 'ejecutó', () => 'denegado')
    await api.end()
    expect(viaApi).toBe('denegado')
  })
})
