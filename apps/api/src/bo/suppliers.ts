/** Backoffice suppliers: list, create, detail, edit and delete. */
import { suppliers, supplierContacts, withTenant } from '@gow/db'
import { SupplierCreateBody, SupplierDeleted, SupplierUpdateBody, type ApplicationRow, type SupplierDetail, type SupplierRow } from '@gow/contracts'
import { enqueuePurge, pathBelongsTo } from '@gow/platform'
import { eq, sql } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, iso, PENDING_SUPPLIER_NAME, SUPPLIER_NOT_FOUND, uniqueViolation, who, type BackofficeDeps } from './shared.ts'

/** The supplier has a request in progress (`app.purge_supplier`, 55006 object_in_use). */
function inUse(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { code?: unknown }).code === '55006') return true
  }
  return false
}

const PurgeResult = z.object({ application_ids: z.array(z.uuid()), run_ids: z.array(z.string()), storage_paths: z.array(z.string()), counts: SupplierDeleted.shape.counts })

export function suppliersRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  // ---------- Suppliers: list, create, detail and edit
  r.get('/suppliers', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.execute<{ id: string; legal_name: string; rfc: string | null; external_ref: string | null; created_at: Date; applications: number; last_id: string | null; last_status: ApplicationRow['status'] | null; last_at: Date | null }>(sql`
        select s.id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name, s.rfc, s.external_ref, s.created_at,
               (select count(*)::int from app.applications a where a.supplier_id = s.id) as applications,
               l.id as last_id, l.status as last_status, l.created_at as last_at
          from app.suppliers s
          left join lateral (select a.id, a.status, a.created_at from app.applications a where a.supplier_id = s.id order by a.created_at desc limit 1) l on true
         order by coalesce(l.created_at, s.created_at) desc
         limit 500`),
    )
    const list: SupplierRow[] = rows.rows.map((x) => ({
      id: x.id,
      legal_name: x.legal_name,
      rfc: x.rfc,
      external_ref: x.external_ref,
      applications: x.applications,
      last_application: x.last_id && x.last_status && x.last_at ? { id: x.last_id, status: x.last_status, created_at: new Date(x.last_at).toISOString() } : null,
      created_at: new Date(x.created_at).toISOString(),
    }))
    res.json(list)
  })

  /** Create without contacts: a verified link comes in through the integration API (tenant KYC). */
  r.post('/suppliers', async (req, res) => {
    const w = who(res)
    const body = parse(SupplierCreateBody, req.body)
    try {
      const id = await withTenant(deps.db, w.tenantId, async (tx) => {
        const [s] = await tx.insert(suppliers).values({ tenantId: w.tenantId, legalName: body.legal_name, rfc: body.rfc, externalRef: body.external_ref, clabes: body.clabes }).returning({ id: suppliers.id })
        if (!s) throw new HttpError(500, 'no se creó el proveedor')
        await audit(tx, w.tenantId, actorOf(w), 'supplier.created', s.id, { contacts: 0 })
        return s.id
      })
      res.status(201).json({ id })
    } catch (e) {
      if (uniqueViolation(e)) throw new HttpError(409, 'ya existe un proveedor con esa referencia externa', [{ path: 'external_ref', message: 'referencia repetida' }])
      throw e
    }
  })

  r.get('/suppliers/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, id))
      if (!s) throw new HttpError(404, SUPPLIER_NOT_FOUND)
      const contacts = await tx.select().from(supplierContacts).where(eq(supplierContacts.supplierId, id)).orderBy(supplierContacts.createdAt)
      const apps = await tx.execute<{ id: string; status: ApplicationRow['status']; request: ApplicationRow['request']; created_at: Date; decision_status: NonNullable<ApplicationRow['decision']>['status'] | null; limit_amount: string | null; score: string | null; outcomes: { outcome: 'paid' | 'late' | 'default' | 'fraud'; observed_at: string }[] }>(sql`
        select a.id, a.status, a.request, a.created_at, d.status as decision_status, d.limit_amount, d.score,
               coalesce((select jsonb_agg(jsonb_build_object('outcome', o.outcome, 'observed_at', o.observed_at) order by o.observed_at desc) from app.outcomes o where o.application_id = a.id), '[]'::jsonb) as outcomes
          from app.applications a
          left join lateral (select dd.status, dd.limit_amount, dd.score from app.decisions dd where dd.application_id = a.id and dd.kind = 'active' order by dd.created_at desc limit 1) d on true
         where a.supplier_id = ${id}::uuid
         order by a.created_at desc`)
      // Viewing a supplier means viewing their RFC and CLABEs: audit-logged like viewing a request.
      await audit(tx, w.tenantId, actorOf(w), 'supplier.viewed', id)
      return { s, contacts, apps: apps.rows }
    })
    const detail: SupplierDetail = {
      id: out.s.id,
      legal_name: out.s.legalName ?? PENDING_SUPPLIER_NAME,
      rfc: out.s.rfc,
      address: out.s.address,
      external_ref: out.s.externalRef,
      clabes: out.s.clabes,
      created_at: out.s.createdAt.toISOString(),
      contacts: out.contacts.map((c) => ({ id: c.id, channel: c.channel, address: c.address, verified_at: iso(c.verifiedAt), verification_method: c.verificationMethod, created_at: c.createdAt.toISOString() })),
      applications: out.apps.map((a) => ({
        id: a.id,
        status: a.status,
        request: a.request,
        decision: a.decision_status ? { status: a.decision_status, limit: a.limit_amount === null ? null : Number(a.limit_amount), score: a.score === null ? null : Number(a.score) } : null,
        outcomes: a.outcomes.map((o) => ({ outcome: o.outcome, observed_at: new Date(o.observed_at).toISOString() })),
        created_at: new Date(a.created_at).toISOString(),
      })),
    }
    res.json(detail)
  })

  /** Edit legal name, RFC and CLABEs; the audit log carries only field names, never values. */
  r.patch('/suppliers/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const body = parse(SupplierUpdateBody, req.body)
    const set = { ...(body.legal_name === undefined ? {} : { legalName: body.legal_name }), ...(body.rfc === undefined ? {} : { rfc: body.rfc }), ...(body.clabes === undefined ? {} : { clabes: body.clabes }) }
    const fields = (['legal_name', 'rfc', 'clabes'] as const).filter((f) => body[f] !== undefined)
    await withTenant(deps.db, w.tenantId, async (tx) => {
      const [s] = await tx.update(suppliers).set(set).where(eq(suppliers.id, id)).returning({ id: suppliers.id })
      if (!s) throw new HttpError(404, SUPPLIER_NOT_FOUND)
      await audit(tx, w.tenantId, actorOf(w), 'supplier.updated', id, { fields })
    })
    res.json({ id, fields })
  })

  /**
   * Delete a supplier with everything of theirs: requests, documents, extractions, decisions,
   * clarifications, credit results, corrections, registration and messages. The database part is
   * one transaction through `app.purge_supplier` (the API role has no DELETE on those tables); the
   * worker deletes the PDFs, queue jobs and Mastra state with `supplier.purge`. Refused with 409
   * while a request is in progress. The audit log keeps only counts.
   */
  r.delete('/suppliers/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    let purged: z.infer<typeof PurgeResult>
    try {
      purged = await withTenant(deps.db, w.tenantId, async (tx) => {
        const out = await tx.execute<{ purged: unknown }>(sql`select app.purge_supplier(${id}::uuid) as purged`)
        const raw = out.rows[0]?.purged ?? null
        if (raw === null) throw new HttpError(404, SUPPLIER_NOT_FOUND)
        const p = PurgeResult.parse(raw)
        await audit(tx, w.tenantId, actorOf(w), 'supplier.deleted', id, p.counts)
        return p
      })
    } catch (e) {
      if (inUse(e)) throw new HttpError(409, 'el proveedor tiene una solicitud en proceso; espera a que termine y vuelve a intentar')
      throw e
    }
    await enqueuePurge(deps.boss, { tenant_id: w.tenantId, supplier_id: id, application_ids: purged.application_ids, run_ids: purged.run_ids, storage_paths: purged.storage_paths.filter((p) => pathBelongsTo(p, w.tenantId)) })
    const body: SupplierDeleted = { id, counts: purged.counts }
    res.json(body)
  })

  return r
}
