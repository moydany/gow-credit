/**
 * Worker data access. Everything goes through `withTenant` with the `gow_worker` role: a query
 * without a tenant sees no rows even if there is a bug (RLS applies to internal processes too).
 */
import { notQualifiedReasons, renderVerdict } from '@gow/channels'
import { describeFailure, parsePolicy, type ApplicationRequest, type Decision, type Policy, type StatementAgeSetting, type StatementExtraction, type SupplierIdentity } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, decisions, documents, extractions, outboundMessages, policyVersions, supplierContacts, suppliers, tenants, withTenant, type Db, type Tx } from '@gow/db'
import { evaluate } from '@gow/decision'
import { applicationStatus, type RunInfo, type RunOutcome } from '@gow/mastra'
import { offerAmount } from './offer.ts'
import { startConfirmation } from './registration.ts'
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'

export interface PolicyRef {
  id: string
  version: number
  policy: Policy
}

export interface AppContext {
  tenantId: string
  application: typeof applications.$inferSelect
  supplier: typeof suppliers.$inferSelect
  documents: (typeof documents.$inferSelect)[]
  active: PolicyRef | null
  shadow: PolicyRef | null
  /** Tenant statement-age setting: the document's age warns, it does not ask for another. */
  statementAge: StatementAgeSetting
}

function toPolicyRef(row: typeof policyVersions.$inferSelect | undefined): PolicyRef | null {
  if (!row) return null
  const parsed = parsePolicy(row.document)
  if (!parsed.ok) throw new Error(`la versión de política ${row.id} no es válida: ${parsed.message}`)
  return { id: row.id, version: row.version, policy: parsed.policy }
}

export async function loadContext(db: Db, tenantId: string, applicationId: string): Promise<AppContext> {
  return withTenant(db, tenantId, async (tx) => {
    const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId))
    if (!application) throw new Error(`no existe la solicitud ${applicationId} en este tenant`)
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, application.supplierId))
    if (!supplier) throw new Error('la solicitud no tiene proveedor')
    const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, applicationId))
    const docs = links.length ? await tx.select().from(documents).where(inArray(documents.id, links.map((l) => l.documentId))) : []
    const versions = await tx.select().from(policyVersions).where(inArray(policyVersions.status, ['active', 'shadow'])).orderBy(desc(policyVersions.version))
    const [tenant] = await tx.select({ months: tenants.statementMaxAgeMonths }).from(tenants).where(eq(tenants.id, tenantId))
    if (!tenant) throw new Error(`no existe el tenant ${tenantId}`)
    return {
      tenantId,
      application,
      supplier,
      documents: docs,
      active: toPolicyRef(versions.find((v) => v.status === 'active')),
      shadow: toPolicyRef(versions.find((v) => v.status === 'shadow')),
      statementAge: { max_months: tenant.months },
    }
  })
}

/** Null until the supplier registering over WhatsApp confirms their data. */
export function supplierIdentity(s: AppContext['supplier']): SupplierIdentity | null {
  return s.legalName === null ? null : { legal_name: s.legalName, rfc: s.rfc, clabes: s.clabes }
}

/** A supplier registering with their first bank statement: the result waits for their data. */
export function identityPending(ctx: AppContext): boolean {
  return ctx.supplier.legalName === null
}

export async function verifiedContacts(db: Db, tenantId: string, supplierId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(supplierContacts).where(and(eq(supplierContacts.supplierId, supplierId), isNotNull(supplierContacts.verifiedAt))))
}

export async function setStatus(db: Db, tenantId: string, applicationId: string, status: typeof applications.$inferSelect.status, failureReason: string | null = null): Promise<void> {
  await withTenant(db, tenantId, (tx) => tx.update(applications).set({ status, failureReason, updatedAt: new Date() }).where(eq(applications.id, applicationId)))
}

export function requestOf(ctx: AppContext): ApplicationRequest | null {
  return (ctx.application.request ?? null) as ApplicationRequest | null
}

/** The active verdict and, if a shadow policy exists, that one's (evaluated and recorded without deciding). */
export async function insertDecisions(tx: Tx, ctx: AppContext, d: Decision): Promise<void> {
  await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.active?.id ?? null, kind: 'active', status: d.status, limitAmount: d.limit === null ? null : String(d.limit), score: d.score === null ? null : String(d.score), payload: d })
  if (ctx.shadow) {
    const sd = evaluate(ctx.shadow.policy, d.profile, { policyId: ctx.shadow.id, counterfactuals: false, statementAge: ctx.statementAge })
    await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.shadow.id, kind: 'shadow', status: sd.status, limitAmount: sd.limit === null ? null : String(sd.limit), score: sd.score === null ? null : String(sd.score), payload: sd })
  }
}

const VERDICT_STATUSES = ['qualified', 'qualified_with_limit', 'not_qualified', 'human_review', 'failed'] as const
type VerdictStatus = (typeof VERDICT_STATUSES)[number]

/**
 * Notifies the supplier of the result on their verified WhatsApp: a fixed-template message in
 * the outbox, in the same transaction that saves the state. `needs_clarification` sends no notice:
 * the question already went out. Without verified WhatsApp there is no notice (the result stays
 * in the API and backoffice). The destination comes from the link, never from the caller.
 */
export async function queueVerdict(tx: Tx, ctx: AppContext, status: typeof applications.$inferSelect.status, limit: number | null, failureReason: string | null = null, decision: Decision | null = null): Promise<boolean> {
  if (!(VERDICT_STATUSES as readonly string[]).includes(status)) return false
  // Registration in progress: the verdict goes out when the supplier confirms their data. A failure
  // does go out, because there is nothing to confirm and another document is needed.
  if (identityPending(ctx) && status !== 'failed') return false
  const [contact] = await tx
    .select({ address: supplierContacts.address })
    .from(supplierContacts)
    .where(and(eq(supplierContacts.supplierId, ctx.supplier.id), eq(supplierContacts.channel, 'whatsapp'), isNotNull(supplierContacts.verifiedAt)))
    .orderBy(asc(supplierContacts.createdAt))
    .limit(1)
  if (!contact) return false
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
  const request = requestOf(ctx)
  const failure = status === 'failed' ? describeFailure(failureReason) : null
  const verdict = renderVerdict({ status: status as VerdictStatus, limit, request, tenantName: tenant?.name ?? 'la institución crediticia', failure, reasons: status === 'not_qualified' ? notQualifiedReasons(decision) : [] })
  // With no requested amount and a line, the notice ends by asking how much they want to advance.
  const offer = await offerAmount(tx, { tenantId: ctx.tenantId, applicationId: ctx.application.id, status, limit, request, channel: 'whatsapp', address: contact.address })
  const body = offer ? `${verdict}\n\n${offer}` : verdict
  await tx.insert(outboundMessages).values({ tenantId: ctx.tenantId, kind: 'verdict', channel: 'whatsapp', destination: contact.address, body })
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: 'verdict.queued', subject: ctx.application.id, details: { status, channel: 'whatsapp', ...(failure ? { failure: failure.kind } : {}) } })
  return true
}

/**
 * Stores what a workflow run left: new extractions, the verdict under the active policy, the
 * shadow policy's (evaluated and recorded, does not decide) and the request state with the run to
 * resume.
 */
/** The address from the most recent bank statement (by period end) that has one; null if none. */
export function latestAddress(statements: readonly StatementExtraction[]): string | null {
  let best: { end: string; address: string } | null = null
  for (const s of statements) {
    const address = s.holder.address.value?.replace(/\s+/g, ' ').trim()
    if (!address) continue
    const end = s.accounts.flatMap((a) => a.periods.map((p) => p.period_end.value ?? '')).sort().at(-1) ?? ''
    if (!best || end > best.end) best = { end, address }
  }
  return best?.address ?? null
}

export async function persistOutcome(db: Db, ctx: AppContext, outcome: RunOutcome): Promise<typeof applications.$inferSelect.status> {
  const run: RunInfo = { workflow: 'process-application', run_id: outcome.runId, status: outcome.status, suspended_step: outcome.suspendedStep }
  const state = outcome.state
  const status = applicationStatus(state, run)
  await withTenant(db, ctx.tenantId, async (tx) => {
    for (const s of state?.statements ?? []) {
      const doc = ctx.documents.find((d) => d.sha256 === s.document.sha256)
      if (!doc) continue
      // The extraction is immutable: what the owner clarifies lives in the clarification and the verdict.
      const [existing] = await tx.select({ id: extractions.id }).from(extractions).where(eq(extractions.documentId, doc.id))
      if (!existing) await tx.insert(extractions).values({ tenantId: ctx.tenantId, documentId: doc.id, schemaVersion: s.schema_version, status: s.extraction.status, payload: s, costUsd: String(s.extraction.cost_usd) })
    }
    if (state?.decision) await insertDecisions(tx, ctx, state.decision)
    // The holder's address, if any bank statement carries it, goes into the supplier profile.
    const address = latestAddress(state?.statements ?? [])
    if (address) await tx.update(suppliers).set({ address }).where(eq(suppliers.id, ctx.supplier.id))
    const failure = status === 'failed' ? (state?.failure_reason ?? outcome.error ?? 'el workflow terminó sin veredicto') : null
    await tx
      .update(applications)
      .set({ status, failureReason: failure, runId: outcome.runId, suspendedStep: outcome.suspendedStep, updatedAt: new Date() })
      .where(eq(applications.id, ctx.application.id))
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: `application.${outcome.status}`, subject: ctx.application.id, details: { status } })
    // Without a requested amount, the notice amount is the maximum line.
    await queueVerdict(tx, ctx, status, state?.decision?.limit ?? state?.max_line?.amount ?? null, failure, state?.decision ?? null)
    if (identityPending(ctx)) await startConfirmation(tx, ctx, state, status)
  })
  return status
}
