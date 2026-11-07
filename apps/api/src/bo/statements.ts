/**
 * A bank statement uploaded from the supplier's page in the backoffice, with the amount to request.
 * Same path as the integration API (`POST /v1/applications`): it stores the PDF, opens the request
 * and enqueues its processing; the page follows the request's status. The verdict only goes out
 * over WhatsApp if the supplier has a verified number; clarifications without a verified contact
 * are answered from Aclaraciones.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ApplicationRequest, Decision, describeFailure, type SupplierStatementStatus, type SupplierStatementUploaded } from '@gow/contracts'
import { applicationDocuments, applications, clarifications, decisions, documents, suppliers, withTenant } from '@gow/db'
import { pdfProtection } from '@gow/extraction'
import { enqueueProcess, isPdf, MAX_DOCUMENT_BYTES } from '@gow/platform'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, SUPPLIER_NOT_FOUND, who, type BackofficeDeps } from './shared.ts'

const IN_PROGRESS = ['received', 'extracting', 'extracted', 'deciding'] as const

/** `?amount=150000`: pesos, optional; without it the request is decided with the maximum line. */
const UploadQuery = z.strictObject({ amount: z.coerce.number().positive().max(1_000_000_000).optional() })

export function statementsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.post('/suppliers/:id/statements', express.raw({ type: 'application/pdf', limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const { amount } = parse(UploadQuery, req.query)
    const w = who(res)
    const bytes: unknown = req.body
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(415, 'manda el estado de cuenta como PDF')
    if (!isPdf(bytes)) throw new HttpError(415, 'el archivo no es un PDF')
    if ((await pdfProtection(bytes)) === 'password') throw new HttpError(422, 'el PDF tiene contraseña; descárgalo de nuevo del banco sin contraseña')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const request = amount === undefined ? null : ApplicationRequest.parse({ amount: Math.round(amount * 100) / 100, maturity: null, buyer: null })

    const created = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [supplier] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, id))
      if (!supplier) throw new HttpError(404, SUPPLIER_NOT_FOUND)
      const [existing] = await tx.select({ id: documents.id, supplierId: documents.supplierId }).from(documents).where(eq(documents.sha256, sha256))
      if (existing) {
        // The same PDF can be evaluated again (another amount) for the same supplier, never for another one.
        const [other] = await tx
          .select({ id: applications.id })
          .from(applicationDocuments)
          .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
          .where(and(eq(applicationDocuments.documentId, existing.id), ne(applications.supplierId, id)))
          .limit(1)
        if (other || (existing.supplierId !== null && existing.supplierId !== id)) throw new HttpError(409, 'este estado de cuenta ya está en una solicitud de otro proveedor')
        // Processing is one job per document: while one is running, another would never start.
        const [running] = await tx
          .select({ id: applications.id })
          .from(applicationDocuments)
          .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
          .where(and(eq(applicationDocuments.documentId, existing.id), inArray(applications.status, [...IN_PROGRESS])))
          .limit(1)
        if (running) throw new HttpError(409, 'este estado de cuenta ya se está procesando; espera a que termine')
      }
      let documentId = existing?.id
      if (!documentId) {
        // If the transaction rolls back later, an orphan file remains; never a row without a file.
        const storagePath = `${w.tenantId}/${randomUUID()}.pdf`
        await deps.storage.put(storagePath, bytes)
        const [doc] = await tx.insert(documents).values({ tenantId: w.tenantId, supplierId: id, storagePath, sha256, sizeBytes: bytes.length, mediaType: 'application/pdf' }).returning({ id: documents.id })
        documentId = doc?.id
      }
      const [app] = await tx.insert(applications).values({ tenantId: w.tenantId, supplierId: id, request, asOf: null }).returning({ id: applications.id })
      if (!documentId || !app) throw new HttpError(500, 'no se creó la solicitud')
      await tx.insert(applicationDocuments).values({ tenantId: w.tenantId, applicationId: app.id, documentId })
      // Ids and whether there was an amount; never the document's content.
      await audit(tx, w.tenantId, actorOf(w), 'application.received', app.id, { source: 'backoffice', supplier_id: id, amount_given: request !== null, document_reused: existing !== undefined })
      return app.id
    })
    await enqueueProcess(deps.boss, { tenant_id: w.tenantId, application_id: created }, sha256)
    const body: SupplierStatementUploaded = { id: created, status: 'received' }
    res.status(201).json(body)
  })

  r.get('/suppliers/:id/statements/:applicationId', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const applicationId = parse(z.uuid(), req.params.applicationId)
    const body = await withTenant(deps.db, who(res).tenantId, async (tx): Promise<SupplierStatementStatus> => {
      const [a] = await tx.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.supplierId, id)))
      if (!a) throw new HttpError(404, 'solicitud no encontrada')
      const [d] = await tx.select({ payload: decisions.payload, limit: decisions.limitAmount, score: decisions.score, status: decisions.status }).from(decisions).where(and(eq(decisions.applicationId, a.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
      const [open] = await tx.select({ id: clarifications.id }).from(clarifications).where(and(eq(clarifications.applicationId, a.id), eq(clarifications.status, 'open'))).limit(1)
      const request = ApplicationRequest.nullable().safeParse(a.request)
      const payload = d ? Decision.safeParse(d.payload) : null
      return {
        id: a.id,
        status: a.status,
        requested: request.success ? (request.data?.amount ?? null) : null,
        decision: d ? { status: d.status, limit: d.limit === null ? null : Number(d.limit), score: d.score === null ? null : Number(d.score), explanation: payload?.success ? (payload.data.explanation?.text ?? null) : null } : null,
        failure: a.status === 'failed' ? describeFailure(a.failureReason).label : null,
        open_clarification: open !== undefined,
        created_at: a.createdAt.toISOString(),
        updated_at: a.updatedAt.toISOString(),
      }
    })
    res.json(body)
  })
  return r
}
