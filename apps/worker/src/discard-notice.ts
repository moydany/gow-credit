/**
 * Tells the supplier that an analyst discarded their document in human review. The API closes the
 * request and enqueues this job; the outbox belongs to the worker, so the message is written here.
 * The reason comes from the request (`document_discarded:<reason>`), never from the job.
 */
import { renderDiscardNotice } from '@gow/channels'
import { DiscardReason, DISCARDED_PREFIX } from '@gow/contracts'
import { auditLog, outboundMessages, supplierContacts, tenants, withTenant } from '@gow/db'
import type { DiscardNoticeJob } from '@gow/platform'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { loadContext, requestOf } from './store.ts'
import type { WorkerServices } from './worker.ts'

export type DiscardNoticeResult = 'queued' | 'already_sent' | 'no_verified_whatsapp' | 'not_discarded'

export async function handleDiscardNotice(s: WorkerServices, job: DiscardNoticeJob): Promise<DiscardNoticeResult> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  const reason = ctx.application.status === 'not_qualified' && ctx.application.failureReason?.startsWith(DISCARDED_PREFIX) ? DiscardReason.safeParse(ctx.application.failureReason.slice(DISCARDED_PREFIX.length)) : null
  if (!reason?.success) return 'not_discarded'
  return withTenant(s.db, job.tenant_id, async (tx): Promise<DiscardNoticeResult> => {
    // A redelivered job must not tell the supplier twice.
    const [sent] = await tx.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.subject, ctx.application.id), inArray(auditLog.action, ['verdict.queued', 'discard_notice.skipped']))).limit(1)
    if (sent) return 'already_sent'
    // Not held back by a pending registration: nothing is left to confirm and another document is needed.
    const [contact] = await tx
      .select({ address: supplierContacts.address })
      .from(supplierContacts)
      .where(and(eq(supplierContacts.supplierId, ctx.supplier.id), eq(supplierContacts.channel, 'whatsapp'), isNotNull(supplierContacts.verifiedAt)))
      .orderBy(asc(supplierContacts.createdAt))
      .limit(1)
    if (!contact) {
      await tx.insert(auditLog).values({ tenantId: job.tenant_id, actor: 'worker', action: 'discard_notice.skipped', subject: ctx.application.id, details: { reason: 'no_verified_whatsapp' } })
      return 'no_verified_whatsapp'
    }
    const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
    const body = renderDiscardNotice({ reason: reason.data, request: requestOf(ctx), tenantName: tenant?.name ?? 'la institución crediticia' })
    await tx.insert(outboundMessages).values({ tenantId: job.tenant_id, kind: 'verdict', channel: 'whatsapp', destination: contact.address, body })
    await tx.insert(auditLog).values({ tenantId: job.tenant_id, actor: 'worker', action: 'verdict.queued', subject: ctx.application.id, details: { status: 'not_qualified', channel: 'whatsapp', failure: 'discarded' } })
    return 'queued'
  })
}
