/** Demo reset: deletes one lender with everything it owns and leaves the rest. */
import { randomUUID } from 'node:crypto'
import { connect, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { QUEUES, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant } from './admin.ts'
import { ResetBlocked, resetTenant, soleTenant } from './reset.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('Reinicio de la demo (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let adminDb: Database
  let admin: pg.Client
  let boss: PgBoss

  beforeAll(async () => {
    tdb = await createTestDatabase()
    adminDb = connect(tdb.url('admin'))
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
  }, 60_000)

  afterAll(async () => {
    await boss.stop({ graceful: false })
    await admin.end()
    await adminDb.close()
    await tdb.drop()
  })

  const count = async (q: string, values: unknown[] = []) => (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q}`, values)).rows[0]?.n ?? -1

  /** A lender with a user, a supplier, a request with its document and a message from an unknown number. */
  async function seed(name: string) {
    const { tenantId } = await createTenant(adminDb.db, { name })
    const q = (text: string, values: unknown[]) => admin.query(text, values)
    const sup = randomUUID()
    const app = randomUUID()
    const doc = randomUUID()
    await q('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [tenantId, randomUUID(), `admin@${name}.test`])
    await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenantId, `Proveedor de ${name}`])
    await q("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'qualified')", [app, tenantId, sup])
    await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/pdf')", [doc, tenantId, sup, `${tenantId}/${doc}.pdf`, doc.replace(/-/g, '').padEnd(64, '0')])
    await q('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenantId, app, doc])
    await q("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body) VALUES ($1, 'whatsapp', '+5215500000000', 'hola')", [tenantId])
    return { tenantId, app }
  }

  it('con una sola institución la encuentra; con dos hay que nombrarla', async () => {
    expect(await soleTenant(adminDb.db)).toBeNull()
    const a = await seed('a')
    expect(await soleTenant(adminDb.db)).toBe(a.tenantId)
    await seed('b')
    expect(await soleTenant(adminDb.db)).toBeNull()
  })

  it('borra la institución con todo lo suyo, encola la limpieza de sus PDFs y deja la otra y los prompts', async () => {
    const tenants = (await admin.query<{ id: string }>("SELECT t.id FROM app.tenants t JOIN app.tenant_users u ON u.tenant_id = t.id WHERE u.email = 'admin@a.test'")).rows
    const target = tenants[0]?.id ?? ''
    const other = (await admin.query<{ id: string }>("SELECT t.id FROM app.tenants t JOIN app.tenant_users u ON u.tenant_id = t.id WHERE u.email = 'admin@b.test'")).rows[0]?.id ?? ''
    const prompts = await count('app.prompt_versions')

    const r = await resetTenant(adminDb.db, boss, target)
    expect(r.suppliers).toBe(1)
    expect(r.userIds).toHaveLength(1)
    for (const table of ['tenants WHERE id = $1', 'tenant_users WHERE tenant_id = $1', 'suppliers WHERE tenant_id = $1', 'applications WHERE tenant_id = $1', 'documents WHERE tenant_id = $1', 'inbound_messages WHERE tenant_id = $1', 'policy_versions WHERE tenant_id = $1', 'audit_log WHERE tenant_id = $1']) {
      expect(await count(`app.${table}`, [target])).toBe(0)
    }
    // The other lender and the global prompts stay.
    expect(await count('app.suppliers WHERE tenant_id = $1', [other])).toBe(1)
    expect(await count('app.tenant_users WHERE tenant_id = $1', [other])).toBe(1)
    expect(await count('app.prompt_versions')).toBe(prompts)
    // The worker deletes the PDF with the usual purge job.
    const jobs = await admin.query<{ data: { tenant_id: string; storage_paths: string[] } }>('SELECT data FROM pgboss.job WHERE name = $1', [QUEUES.purge])
    expect(jobs.rows.map((j) => j.data.tenant_id)).toContain(target)
    expect(jobs.rows.find((j) => j.data.tenant_id === target)?.data.storage_paths).toHaveLength(1)
    // With one lender left, it is the sole one again.
    expect(await soleTenant(adminDb.db)).toBe(other)
  })

  it('no borra mientras una solicitud está en proceso', async () => {
    const other = (await soleTenant(adminDb.db)) ?? ''
    await admin.query("UPDATE app.applications SET status = 'extracting' WHERE tenant_id = $1", [other])
    await expect(resetTenant(adminDb.db, boss, other)).rejects.toBeInstanceOf(ResetBlocked)
    expect(await count('app.tenants WHERE id = $1', [other])).toBe(1)
  })
})
