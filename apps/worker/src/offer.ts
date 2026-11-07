/**
 * Oferta de la línea máxima y monto pedido después (ADR 0053). El brief no pide el monto al recibir
 * el estado de cuenta: sin monto se decide con la línea máxima (ADR 0045) y, si califica, el aviso
 * termina preguntando cuánto quiere adelantar. La respuesta (inbound.ts) guarda el monto en la
 * solicitud y la reevaluación decide de nuevo con él, sin modelos (redecide.ts).
 */
import { AMOUNT_OFFER } from '@gow/channels'
import { ApplicationRequest } from '@gow/contracts'
import { applicationDocuments, documents, invoiceIntakes, type Tx } from '@gow/db'
import { eq, sql } from 'drizzle-orm'

/** Paso de `invoice_intakes` que espera el monto después de la oferta. */
export const OFFER_STEP = 'requested_amount'

const OFFER_STATUSES = ['qualified', 'qualified_with_limit']

/**
 * Si el veredicto califica, no hay monto pedido y hay línea, deja abierta la pregunta del monto y
 * devuelve su texto para agregarlo al aviso. Si no aplica, null.
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
