/**
 * A supplier's approved line (one at a time): the most recent request of theirs that ended in
 * `qualified` or `qualified_with_limit` with a line. While it exists, a PDF over chat does not open
 * another request and a message with nothing pending gets the line's summary (inbound.ts).
 */
import { renderLineSummary, type ActiveLine } from '@gow/channels'
import { ApplicationRequest, Decision } from '@gow/contracts'
import { applications, decisions, suppliers, tenants, type Tx } from '@gow/db'
import { and, desc, eq, inArray } from 'drizzle-orm'

const APPROVED = ['qualified', 'qualified_with_limit'] as const

export async function activeLineOf(tx: Tx, supplierIds: readonly string[]): Promise<ActiveLine | null> {
  if (supplierIds.length === 0) return null
  const [row] = await tx
    .select({ request: applications.request, payload: decisions.payload, limit: decisions.limitAmount, at: decisions.createdAt })
    .from(applications)
    .innerJoin(decisions, and(eq(decisions.applicationId, applications.id), eq(decisions.kind, 'active')))
    .where(and(inArray(applications.supplierId, [...supplierIds]), inArray(applications.status, [...APPROVED])))
    .orderBy(desc(decisions.createdAt))
    .limit(1)
  if (!row || row.limit === null) return null
  const limit = Number(row.limit)
  if (!(limit > 0)) return null
  // Same rule as the verdict: evaluated at the maximum line means there was no amount.
  const decision = Decision.safeParse(row.payload)
  const atMax = decision.success && decision.data.reasons.some((r) => r.code === 'evaluated_at_max_line')
  const request = ApplicationRequest.nullable().safeParse(row.request)
  const requested = atMax || !request.success ? null : (request.data?.amount ?? null)
  const approved = requested !== null && requested <= limit + 0.005 ? requested : limit
  return { approved, limit, requested, decidedAt: row.at.toISOString() }
}

/** The summary for this supplier, with the tenant's and the supplier's names. */
export async function lineSummaryFor(tx: Tx, supplierId: string, line: ActiveLine, opts: { contactName: string | null; sentDocument: boolean }): Promise<string> {
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
  const [supplier] = await tx.select({ legalName: suppliers.legalName }).from(suppliers).where(eq(suppliers.id, supplierId))
  return renderLineSummary({ line, tenantName: tenant?.name ?? 'la institución crediticia', legalName: supplier?.legalName ?? null, contactName: opts.contactName, sentDocument: opts.sentDocument })
}
