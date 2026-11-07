/**
 * Wipes a lender (tenant) with everything it owns, to hand a demo over clean: suppliers with their
 * requests, documents, decisions and messages (each through `app.purge_supplier`, the same path as
 * deleting a supplier from the backoffice), and then the lender itself: users, API keys, policies,
 * audit log, WhatsApp status rows. Afterwards the first-run wizard shows up again.
 *
 * What it does not touch: prompts (global), the WhatsApp session files on the volume (the linked
 * number stays linked; the process picks up the new lender once it exists) and the Supabase Auth
 * accounts, which the CLI deletes with the returned ids.
 *
 * PDFs, queue jobs and Mastra state go through the same `supplier.purge` job the worker already runs.
 */
import { withTenant, type Db } from '@gow/db'
import { enqueuePurge, pathBelongsTo, type PgBoss } from '@gow/platform'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { inUse } from './bo/suppliers.ts'

/**
 * Tables with `tenant_id`, children before parents, for what `purge_supplier` leaves behind. Every
 * query filters by `tenant_id` explicitly: the admin role is not always subject to row security.
 */
const TENANT_TABLES = [
  'llm_exchanges',
  'inbound_messages',
  'outbound_messages',
  'supplier_registrations',
  'invoice_intakes',
  'corrections',
  'outcomes',
  'decisions',
  'clarifications',
  'application_documents',
  'extractions',
  'documents',
  'applications',
  'supplier_contacts',
  'suppliers',
  'audit_log',
  'api_keys',
  'tenant_users',
  'policy_versions',
  'policies',
  'whatsapp_sessions',
] as const

const Purged = z.object({ application_ids: z.array(z.uuid()), run_ids: z.array(z.string()), storage_paths: z.array(z.string()), counts: z.record(z.string(), z.number()) })

export interface ResetResult {
  tenantId: string
  suppliers: number
  /** Backoffice members' ids: their Supabase Auth accounts, if any, are deleted by the caller. */
  userIds: string[]
  /** Rows deleted per table after the suppliers (not counting what `purge_supplier` took). */
  rows: Record<string, number>
}

export class ResetBlocked extends Error {}

/** The only tenant, or null if there are none (or more than one: then it must be named). */
export async function soleTenant(db: Db): Promise<string | null> {
  const r = await db.execute<{ tenant: string | null }>(sql`select app.sole_tenant()::text as tenant`)
  return r.rows[0]?.tenant ?? null
}

/**
 * Deletes the tenant `tenantId` and all its data. Refuses (`ResetBlocked`) while a request is being
 * processed, like deleting a supplier. `db` must be the admin connection.
 */
export async function resetTenant(db: Db, boss: PgBoss, tenantId: string): Promise<ResetResult> {
  const supplierIds = await withTenant(db, tenantId, async (tx) => (await tx.execute<{ id: string }>(sql`select id from app.suppliers where tenant_id = ${tenantId}::uuid`)).rows.map((r) => r.id))
  for (const supplierId of supplierIds) {
    const purged = await withTenant(db, tenantId, async (tx) => {
      try {
        const out = await tx.execute<{ purged: unknown }>(sql`select app.purge_supplier(${supplierId}::uuid) as purged`)
        const raw = out.rows[0]?.purged ?? null
        return raw === null ? null : Purged.parse(raw)
      } catch (e) {
        if (inUse(e)) throw new ResetBlocked('hay una solicitud en proceso; espera a que termine y vuelve a correrlo')
        throw e
      }
    })
    if (!purged) continue
    await enqueuePurge(boss, { tenant_id: tenantId, supplier_id: supplierId, application_ids: purged.application_ids, run_ids: purged.run_ids, storage_paths: purged.storage_paths.filter((p) => pathBelongsTo(p, tenantId)) })
  }
  return withTenant(db, tenantId, async (tx) => {
    const userIds = (await tx.execute<{ user_id: string }>(sql`select user_id::text from app.tenant_users where tenant_id = ${tenantId}::uuid`)).rows.map((r) => r.user_id)
    const rows: Record<string, number> = {}
    for (const table of TENANT_TABLES) {
      const r = await tx.execute(sql`delete from ${sql.identifier('app')}.${sql.identifier(table)} where tenant_id = ${tenantId}::uuid`)
      rows[table] = r.rowCount ?? 0
    }
    const t = await tx.execute(sql`delete from app.tenants where id = ${tenantId}::uuid`)
    rows.tenants = t.rowCount ?? 0
    return { tenantId, suppliers: supplierIds.length, userIds, rows }
  })
}
