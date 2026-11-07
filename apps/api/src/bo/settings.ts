/** Backoffice settings: analysis settings and WhatsApp linking by QR. */
import { createHash } from 'node:crypto'
import { tenants, whatsappSessions, withTenant } from '@gow/db'
import { TenantSettingsUpdateBody, type TenantSettings, type WhatsAppLinkState, type WhatsAppUnlinkRequested } from '@gow/contracts'
import { eq, sql } from 'drizzle-orm'
import express from 'express'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, iso, who, whatsappSession, type BackofficeDeps } from './shared.ts'

export function settingsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  // ---------- Settings: tenant channels (read-only) and analysis settings
  const settingsOf = (t: typeof tenants.$inferSelect): TenantSettings => ({
    tenant: { id: t.id, name: t.name, created_at: t.createdAt.toISOString() },
    whatsapp: { number: t.whatsappNumber },
    email: { from: t.emailFrom },
    analysis: { statement_max_age_months: t.statementMaxAgeMonths },
  })
  r.get('/settings', async (_req, res) => {
    const w = who(res)
    const [t] = await withTenant(deps.db, w.tenantId, (tx) => tx.select().from(tenants).where(eq(tenants.id, w.tenantId)))
    if (!t) throw new HttpError(404, 'tenant no encontrado')
    res.json(settingsOf(t))
  })

  /**
   * Maximum statement age. Applies to requests analyzed from now on and to re-evaluations; a
   * request already in progress keeps the setting it started with.
   */
  r.patch('/settings', async (req, res) => {
    const w = who(res)
    const body = parse(TenantSettingsUpdateBody, req.body)
    const t = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [before] = await tx.select({ months: tenants.statementMaxAgeMonths }).from(tenants).where(eq(tenants.id, w.tenantId))
      if (!before) throw new HttpError(404, 'tenant no encontrado')
      await tx.update(tenants).set({ statementMaxAgeMonths: body.statement_max_age_months }).where(eq(tenants.id, w.tenantId))
      await audit(tx, w.tenantId, actorOf(w), 'settings.updated', w.tenantId, { statement_max_age_months: { from: before.months, to: body.statement_max_age_months } })
      const [after] = await tx.select().from(tenants).where(eq(tenants.id, w.tenantId))
      return after
    })
    if (!t) throw new HttpError(404, 'tenant no encontrado')
    res.json(settingsOf(t))
  })

  // ---------- Settings: link WhatsApp by scanning the QR
  /**
   * The QR is only served while the process is alive, in `waiting_qr` and unexpired. Whoever
   * scans it links their account to the tenant's bot: viewing it is audit-logged once per QR
   * value and user (the browser polls every 2 s), with a truncated fingerprint, never the value.
   */
  r.get('/whatsapp', async (_req, res) => {
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const s = await whatsappSession(tx, w.tenantId)
      const qr = s?.running && s.status === 'waiting_qr' && s.qrFresh ? s.qr : null
      if (s && qr) {
        const digest = createHash('sha256').update(qr).digest('hex').slice(0, 16)
        const seen = await tx.execute(sql`
          select 1 from app.audit_log
           where action = 'whatsapp.qr_viewed' and actor = ${actorOf(w)} and details->>'qr_digest' = ${digest} and at > now() - interval '15 minutes'
           limit 1`)
        if (!seen.rows.length) await audit(tx, w.tenantId, actorOf(w), 'whatsapp.qr_viewed', null, { qr_digest: digest })
      }
      return { s, qr }
    })
    const s = out.s
    const state: WhatsAppLinkState = {
      process_running: s?.running ?? false,
      status: s?.status ?? null,
      linked_number: s?.linkedNumber ?? null,
      qr: out.qr,
      qr_expires_at: out.qr ? iso(s?.qrExpiresAt ?? null) : null,
      unlink_pending: s?.unlinkPending ?? false,
      updated_at: iso(s?.updatedAt ?? null),
    }
    res.json(state)
  })

  /**
   * Unlink (or ask for a new QR after logging out from the phone): the process handles it within
   * seconds, closes the WhatsApp session and publishes a new QR. With no live process nobody can
   * handle it: 409.
   */
  r.post('/whatsapp/unlink', async (_req, res) => {
    const w = who(res)
    const at = await withTenant(deps.db, w.tenantId, async (tx) => {
      const s = await whatsappSession(tx, w.tenantId)
      if (!s?.running) throw new HttpError(409, 'el proceso de WhatsApp no está corriendo')
      const [row] = await tx.update(whatsappSessions).set({ unlinkRequestedAt: sql`now()` }).where(eq(whatsappSessions.tenantId, w.tenantId)).returning({ at: whatsappSessions.unlinkRequestedAt })
      if (!row?.at) throw new HttpError(409, 'el proceso de WhatsApp no está corriendo')
      await audit(tx, w.tenantId, actorOf(w), 'whatsapp.unlink_requested', null, { status: s.status })
      return row.at
    })
    const out: WhatsAppUnlinkRequested = { unlink_requested_at: at.toISOString() }
    res.status(202).json(out)
  })

  return r
}
