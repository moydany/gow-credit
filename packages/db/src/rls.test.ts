/**
 * Aislamiento por tenant (docs/05 §2, §2b y §8). Dos tenants con una fila en cada tabla:
 * - el catálogo: toda tabla de `app` tiene RLS habilitada y forzada, con política, y está en
 *   TENANT_TABLES (una tabla nueva sin política hace fallar esta prueba);
 * - tabla por tabla: A no ve, no actualiza ni inserta filas de B;
 * - sin `app.tenant_id` no hay filas;
 * - el rol de WhatsApp no puede leer documentos ni nada fuera de su buzón.
 * Necesita el Postgres de docker compose; sin él se salta.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_TABLES } from './schema.ts'
import { createTestDatabase, postgresAvailable, type TestDatabase } from './testing.ts'

const available = await postgresAvailable()

const A = randomUUID()
const B = randomUUID()

async function client(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  return c
}

/** Una fila por tabla para un tenant, como administrador. */
async function seed(admin: pg.Client, tenant: string, label: string): Promise<void> {
  const q = (text: string, values: unknown[]) => admin.query(text, values)
  const sup = randomUUID()
  const contact = randomUUID()
  const doc = randomUUID()
  const appId = randomUUID()
  const pol = randomUUID()
  const ver = randomUUID()
  const clar = randomUUID()
  await q('INSERT INTO app.tenants (id, name, whatsapp_number) VALUES ($1, $2, $3)', [tenant, `Tenant ${label}`, `+52155000000${label === 'A' ? '1' : '2'}`])
  await q('INSERT INTO app.api_keys (tenant_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)', [tenant, `gowk_${label}${tenant.slice(0, 6)}`, 'hash', ['ingest']])
  await q('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [tenant, randomUUID(), `analista-${label.toLowerCase()}@prestamista.test`])
  await q('INSERT INTO app.suppliers (id, tenant_id, legal_name) VALUES ($1, $2, $3)', [sup, tenant, `Proveedor ${label}`])
  await q("INSERT INTO app.supplier_contacts (id, tenant_id, supplier_id, channel, address, verified_at) VALUES ($1, $2, $3, 'whatsapp', $4, now())", [contact, tenant, sup, `+52155111111${label === 'A' ? '1' : '2'}`])
  await q("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, 'x', $4, 10, 'application/pdf')", [doc, tenant, sup, label.repeat(64).slice(0, 64)])
  await q('INSERT INTO app.applications (id, tenant_id, supplier_id) VALUES ($1, $2, $3)', [appId, tenant, sup])
  await q('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenant, appId, doc])
  await q("INSERT INTO app.extractions (tenant_id, document_id, schema_version, status, payload) VALUES ($1, $2, '1.2.0', 'complete', '{}')", [tenant, doc])
  await q("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [pol, tenant])
  await q("INSERT INTO app.policy_versions (id, tenant_id, policy_id, version, status, document) VALUES ($1, $2, $3, 1, 'active', '{}')", [ver, tenant, pol])
  await q("INSERT INTO app.decisions (tenant_id, application_id, policy_version_id, status, payload) VALUES ($1, $2, $3, 'human_review', '{}')", [tenant, appId, ver])
  await q("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, destination, questions) VALUES ($1, $2, $3, $4, 1, 'whatsapp', 'x', '[]')", [clar, tenant, appId, sup])
  await q("INSERT INTO app.outbound_messages (tenant_id, clarification_id, channel, destination, body) VALUES ($1, $2, 'whatsapp', 'x', 'hola')", [tenant, clar])
  await q("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body) VALUES ($1, 'whatsapp', 'x', 'hola')", [tenant])
  await q("INSERT INTO app.corrections (tenant_id, application_id, document_id, target, value) VALUES ($1, $2, $3, '{\"kind\":\"holder\",\"field\":\"name\"}', '\"Prueba\"')", [tenant, appId, doc])
  await q("INSERT INTO app.outcomes (tenant_id, application_id, outcome, observed_at) VALUES ($1, $2, 'paid', now())", [tenant, appId])
  await q("INSERT INTO app.audit_log (tenant_id, actor, action) VALUES ($1, 'test', 'seed')", [tenant])
}

/** Corre `fn` en una transacción con el tenant fijado (o sin él). */
async function asTenant<T>(c: pg.Client, tenant: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  try {
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    return await fn()
  } finally {
    await c.query('ROLLBACK')
  }
}

/** La consulta o el error que lanzó: un permiso denegado también es un resultado esperado. */
async function attempt(c: pg.Client, text: string, values: unknown[] = []): Promise<pg.QueryResult | Error> {
  try {
    return await c.query(text, values)
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

function tenantColumn(table: string): string {
  return table === 'tenants' ? 'id' : 'tenant_id'
}

describe.skipIf(!available)('RLS por tenant (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let readonly: pg.Client
  let api: pg.Client
  let worker: pg.Client
  let whatsapp: pg.Client

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = await client(tdb.url('admin'))
    await seed(admin, A, 'A')
    await seed(admin, B, 'B')
    readonly = await client(tdb.url('readonly'))
    api = await client(tdb.url('api'))
    worker = await client(tdb.url('worker'))
    whatsapp = await client(tdb.url('whatsapp'))
  }, 60_000)

  afterAll(async () => {
    for (const c of [readonly, api, worker, whatsapp, admin]) await c.end()
    await tdb.drop()
  })

  it('toda tabla de app tiene RLS habilitada y forzada, con política, y está en la lista que se prueba', async () => {
    const { rows } = await admin.query<{ table: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`)
    expect(rows.map((r) => r.table).sort()).toEqual([...TENANT_TABLES].sort())
    for (const r of rows) expect({ table: r.table, rls: r.rls, forced: r.forced, hasPolicy: r.policies > 0 }).toEqual({ table: r.table, rls: true, forced: true, hasPolicy: true })
  })

  it.each([...TENANT_TABLES])('%s: A solo ve sus filas', async (table) => {
    const col = tenantColumn(table)
    const seen = await asTenant(readonly, A, () => readonly.query<{ t: string }>(`SELECT ${col}::text AS t FROM app.${table}`))
    expect(seen.rows.length).toBeGreaterThan(0)
    expect(new Set(seen.rows.map((r) => r.t))).toEqual(new Set([A]))
  })

  it.each([...TENANT_TABLES])('%s: sin app.tenant_id no hay filas', async (table) => {
    const seen = await asTenant(worker, null, () => attempt(worker, `SELECT 1 FROM app.${table}`))
    // El worker no puede leer llaves de API: permiso denegado también cuenta como cero filas.
    if (seen instanceof Error) expect(seen.message).toMatch(/permission denied/)
    else expect(seen.rows).toHaveLength(0)
  })

  it.each([...TENANT_TABLES])('%s: A no actualiza filas de B', async (table) => {
    const col = tenantColumn(table)
    for (const c of [api, worker]) {
      const r = await asTenant(c, A, () => attempt(c, `UPDATE app.${table} SET ${col} = ${col} WHERE ${col} = $1`, [B]))
      if (r instanceof Error) expect(r.message).toMatch(/permission denied/)
      else expect(r.rowCount).toBe(0)
    }
  })

  it.each([...TENANT_TABLES])('%s: A no inserta filas a nombre de B', async (table) => {
    const col = tenantColumn(table)
    // Copia de una fila de B con id nuevo: la política la rechaza antes que cualquier restricción.
    const { rows } = await admin.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM app.${table} t WHERE ${col} = $1 LIMIT 1`, [B])
    const row = { ...rows[0]?.row }
    if ('id' in row) row.id = randomUUID()
    if (table === 'api_keys') row.prefix = `gowk_${randomUUID().slice(0, 8)}`
    for (const c of [api, worker]) {
      const r = await asTenant(c, A, () => attempt(c, `INSERT INTO app.${table} SELECT * FROM jsonb_populate_record(NULL::app.${table}, $1)`, [JSON.stringify(row)]))
      expect(r).toBeInstanceOf(Error)
      expect((r as Error).message).toMatch(/row-level security|permission denied/)
    }
  })

  it('WhatsApp no lee documentos, extracciones, decisiones ni proveedores', async () => {
    for (const table of ['documents', 'extractions', 'decisions', 'suppliers', 'clarifications', 'policies', 'tenants']) {
      const r = await asTenant(whatsapp, A, () => attempt(whatsapp, `SELECT 1 FROM app.${table}`))
      expect(r, table).toBeInstanceOf(Error)
      expect((r as Error).message).toMatch(/permission denied/)
    }
  })

  it('WhatsApp ve solo el buzón de su tenant y puede encolar entrantes del suyo', async () => {
    const out = await asTenant(whatsapp, A, () => whatsapp.query<{ t: string }>('SELECT tenant_id::text AS t FROM app.outbound_messages'))
    expect(new Set(out.rows.map((r) => r.t))).toEqual(new Set([A]))
    const ok = await asTenant(whatsapp, A, () => whatsapp.query("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body) VALUES ($1, 'whatsapp', 'x', 'sí') RETURNING id", [A]))
    expect(ok.rowCount).toBe(1)
    const ko = await asTenant(whatsapp, A, () => attempt(whatsapp, "INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body) VALUES ($1, 'whatsapp', 'x', 'sí')", [B]))
    expect((ko as Error).message).toMatch(/row-level security/)
  })

  it('la API lista y revoca llaves de su tenant sin poder leer el hash ni cambiar otra columna', async () => {
    const seen = await asTenant(api, A, () => api.query<{ t: string }>('SELECT tenant_id::text AS t, prefix, scopes, revoked_at FROM app.api_keys'))
    expect(new Set(seen.rows.map((r) => r.t))).toEqual(new Set([A]))
    const hash = await asTenant(api, A, () => attempt(api, 'SELECT key_hash FROM app.api_keys'))
    expect((hash as Error).message).toMatch(/permission denied/)
    const scopes = await asTenant(api, A, () => attempt(api, "UPDATE app.api_keys SET scopes = '{policies}'"))
    expect((scopes as Error).message).toMatch(/permission denied/)
    const revokeB = await asTenant(api, A, () => api.query('UPDATE app.api_keys SET revoked_at = now() WHERE tenant_id = $1', [B]))
    expect(revokeB.rowCount).toBe(0)
  })

  it('la API quita usuarios solo de su tenant', async () => {
    const r = await asTenant(api, A, () => api.query('DELETE FROM app.tenant_users WHERE tenant_id = $1', [B]))
    expect(r.rowCount).toBe(0)
  })

  it('la llave de API se resuelve sin conocer el tenant, solo desde la API', async () => {
    const { rows } = await admin.query<{ prefix: string }>('SELECT prefix FROM app.api_keys WHERE tenant_id = $1', [A])
    const r = await api.query<{ tenant_id: string }>('SELECT tenant_id::text FROM app.resolve_api_key($1)', [rows[0]?.prefix])
    expect(r.rows).toEqual([{ tenant_id: A }])
    const denied = await attempt(worker, 'SELECT * FROM app.resolve_api_key($1)', [rows[0]?.prefix])
    expect((denied as Error).message).toMatch(/permission denied/)
  })
})
