/**
 * Supabase Auth custom access token hook (0008_access_token_hook.sql): which claims it returns and
 * who can run it. Runs against whatever Postgres is available (docker-compose.yml, or local
 * Supabase with infra/supabase/app.env loaded); skipped without Postgres. The permission checks for
 * supabase_auth_admin, anon and authenticated only run if those roles exist (Supabase).
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, postgresAvailable, type TestDatabase } from './testing.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('Hook de Supabase Auth: tenant_id en el access token', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let supabase = false
  const tenantA = randomUUID()
  const tenantB = randomUUID()
  const member = randomUUID()
  const twice = randomUUID()
  const stranger = randomUUID()

  const baseClaims = (sub: string) => ({ aud: 'authenticated', role: 'authenticated', sub, email: 'x@prestamista.test', exp: 2_000_000_000, session_id: randomUUID() })
  async function hook(event: unknown): Promise<{ claims: Record<string, unknown> } & Record<string, unknown>> {
    const r = await admin.query<{ out: { claims: Record<string, unknown> } & Record<string, unknown> }>('SELECT app.custom_access_token_hook($1::jsonb) AS out', [JSON.stringify(event)])
    const out = r.rows[0]?.out
    if (!out) throw new Error('sin resultado')
    return out
  }

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    supabase = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin'")).rowCount === 1
    await admin.query('INSERT INTO app.tenants (id, name) VALUES ($1, $2), ($3, $4)', [tenantA, 'Tenant A', tenantB, 'Tenant B'])
    await admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [tenantA, member, 'miembro@prestamista.test'])
    // Same id in two tenants (only possible by hand): the oldest membership wins.
    await admin.query("INSERT INTO app.tenant_users (tenant_id, user_id, email, created_at) VALUES ($1, $2, $3, now() - interval '1 day'), ($4, $2, $5, now())", [tenantB, twice, 'antes@prestamista.test', tenantA, 'despues@prestamista.test'])
  }, 60_000)

  afterAll(async () => {
    await admin.end()
    await tdb.drop()
  })

  it('un miembro recibe tenant_id y el resto de los claims queda igual', async () => {
    const claims = baseClaims(member)
    const out = await hook({ user_id: member, claims, authentication_method: 'otp' })
    expect(out.claims).toEqual({ ...claims, tenant_id: tenantA })
    expect(out.authentication_method).toBe('otp')
  })

  it('sin pertenencia no hay tenant_id, y uno que viniera en los claims se descarta', async () => {
    const out = await hook({ user_id: stranger, claims: { ...baseClaims(stranger), tenant_id: tenantA } })
    expect(out.claims).not.toHaveProperty('tenant_id')
    expect(out.claims.sub).toBe(stranger)
  })

  it('con varias pertenencias gana la más antigua', async () => {
    expect((await hook({ user_id: twice, claims: baseClaims(twice) })).claims.tenant_id).toBe(tenantB)
  })

  it('un user_id que no es uuid no truena: solo no agrega el claim', async () => {
    const out = await hook({ user_id: 'no-es-uuid', claims: { sub: 'no-es-uuid' } })
    expect(out.claims).toEqual({ sub: 'no-es-uuid' })
  })

  it('los roles de la app no pueden ejecutar el hook ni la función que lee la pertenencia', async () => {
    for (const role of ['gow_api', 'gow_worker', 'gow_whatsapp', 'gow_readonly']) {
      for (const fn of ['app.custom_access_token_hook(jsonb)', 'app.backoffice_tenant_of(uuid)']) {
        const r = await admin.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, $3) AS ok', [role, fn, 'EXECUTE'])
        expect(r.rows[0]?.ok, `${role} sobre ${fn}`).toBe(false)
      }
    }
  })

  it('en Supabase: solo supabase_auth_admin ejecuta el hook; anon, authenticated y service_role no', async (ctx) => {
    if (!supabase) return ctx.skip()
    const can = async (role: string, fn: string) => (await admin.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, $3) AS ok', [role, fn, 'EXECUTE'])).rows[0]?.ok
    for (const fn of ['app.custom_access_token_hook(jsonb)', 'app.backoffice_tenant_of(uuid)']) {
      expect(await can('supabase_auth_admin', fn)).toBe(true)
      for (const role of ['anon', 'authenticated', 'service_role']) expect(await can(role, fn), `${role} sobre ${fn}`).toBe(false)
    }
    // Having schema usage doesn't grant access to any table.
    const tables = await admin.query<{ ok: boolean }>("SELECT has_table_privilege('supabase_auth_admin', 'app.tenant_users', 'SELECT') AS ok")
    expect(tables.rows[0]?.ok).toBe(false)
    // The function that reads membership runs as its owner, which skips RLS (`postgres` has
    // BYPASSRLS on Supabase); without that GoTrue would see no rows. `postgres` can't SET ROLE to
    // supabase_auth_admin, so GoTrue's real call is tested end to end.
    const owner = await admin.query<{ definer: boolean; bypass: boolean }>("SELECT p.prosecdef AS definer, r.rolbypassrls OR r.rolsuper AS bypass FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'app.backoffice_tenant_of(uuid)'::regprocedure")
    expect(owner.rows[0]).toEqual({ definer: true, bypass: true })
  })
})
