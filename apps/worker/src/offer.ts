/**
 * Offering the maximum line and asking for the amount afterwards. The amount is not requested on
 * receiving the bank statement: without one, the decision uses the maximum line and, if it
 * qualifies, the notice ends by asking how much they want to advance. The reply (inbound.ts)
 * stores the amount on the request and re-evaluation decides again with it, without models
 * (redecide.ts).
 */
import { AMOUNT_OFFER } from '@gow/channels'
import { ApplicationRequest } from '@gow/contracts'
import { applicationDocuments, documents, invoiceIntakes, type Tx } from '@gow/db'
import { eq, sql } from 'drizzle-orm'

/** `invoice_intakes` step that waits for the amount after the offer. */
export const OFFER_STEP = 'requested_amount'

const OFFER_STATUSES = ['qualified', 'qualified_with_limit']

/**
 * If the verdict qualifies, no amount was requested and there is a line, leaves the amount
 * question open and returns its text to append to the notice. Otherwise null.
 */
export async function offerAmount(tx: Tx, o: { tenantId: string; applicationId: string; status: string; limit: number | null; request: unknown; channel: 'whatsapp'; address: string }): Promise<string | null> {
  if (!OFFER_STATUSES.includes(o.status) || o.limit === null || o.limit <= 0) return null
  const request = ApplicationRequest.nullable().safeParse(o.request)
  if (request.success && request.data?.amount != null) return null
  const [doc] = await tx.select({ sha256: documents.sha256 }).from(applicationDocuments).innerJoin(documents, eq(documents.id, applicationDocuments.documentId)).where(eq(applicationDocuments.applicationId, o.applicationId)).limit(1)
  if (!doc) return null
  await tx
    .insert(invoiceIntakes)
    .values({ applicationId: o.applicationId, tenantId: o.tenantId, channel: o.channel, address: o.address, step: OFFER_STEP, draft: { max: o.limit }, documentSha256: doc.sha256 })
    .onConflictDoUpdate({ target: invoiceIntakes.applicationId, set: { step: OFFER_STEP, draft: { max: o.limit }, updatedAt: sql`now()` } })
  return AMOUNT_OFFER.ask(o.limit)
}
