import {
  type AuditEntry,
  type PolicyVersionItem,
} from '@gow/contracts'
import {
  desc,
  sql,
} from 'drizzle-orm'
import {
  policyVersions,
  withTenant,
} from '@gow/db'
import express from 'express'
import { z } from 'zod'
import {
  PolicyBody,
  createPolicyDraft,
  parse,
  recordOutcome,
  simulateVersion,
  transitionVersion,
} from '../ops.ts'
import {
  actorOf,
  iso,
  who,
  type BackofficeDeps,
} from './shared.ts'

export function policiesRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()

  r.get('/policies/versions', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.select().from(policyVersions).orderBy(desc(policyVersions.version)),
    )
    const list: PolicyVersionItem[] = rows.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      document: v.document,
      simulation: v.simulation as PolicyVersionItem['simulation'],
      created_at: v.createdAt.toISOString(),
      activated_at: iso(v.activatedAt),
    }))
    res.json(list)
  })

  r.post('/policies/versions', async (req, res) => {
    const w = who(res)
    const body = parse(PolicyBody, req.body)
    res.status(201).json(await createPolicyDraft(deps.db, w.tenantId, actorOf(w), body.document))
  })

  r.post('/policies/versions/:id/simulate', async (req, res) => {
    const w = who(res)
    res.json(await simulateVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id)))
  })

  r.post('/policies/versions/:id/shadow', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'shadow'))
  })

  r.post('/policies/versions/:id/activate', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'active'))
  })

  r.post('/outcomes', async (req, res) => {
    const w = who(res)
    await recordOutcome(deps.db, w.tenantId, actorOf(w), req.body)
    res.status(201).json({ ok: true })
  })

  r.get('/audit', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.execute<{
        id: string
        actor: string
        actor_label: string | null
        action: string
        subject: string | null
        details: Record<string, unknown>
        at: Date
      }>(sql`
        select l.id, l.actor, u.email as actor_label, l.action, l.subject, l.details, l.at
          from app.audit_log l left join app.tenant_users u on 'user:' || u.user_id::text = l.actor
         order by l.at desc limit 200`),
    )
    const list: AuditEntry[] = rows.rows.map((l) => ({
      id: l.id,
      actor: l.actor,
      actor_label: l.actor_label,
      action: l.action,
      subject: l.subject,
      details: l.details,
      at: new Date(l.at).toISOString(),
    }))
    res.json(list)
  })

  return r
}
