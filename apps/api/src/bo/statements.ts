/**
 * A bank statement uploaded from the supplier's page in the backoffice, with the amount to request.
 * Same path as the integration API (`POST /v1/applications`): it stores the PDF, opens the request
 * and enqueues its processing; the page follows the request's status. Several statements for a
 * policy that evaluates three months go in one request: opened with `hold`, added with `/documents`
 * and started with `/start`. One PDF with several months needs nothing else. The verdict only goes out
 * over WhatsApp if the supplier has a verified number; clarifications without a verified contact
 * are answered from Aclaraciones.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ApplicationRequest, Decision, describeFailure, type SupplierStatementStatus, type SupplierStatementUploaded } from '@gow/contracts'
import { applicationDocuments, applications, clarifications, decisions, documents, suppliers, withTenant, type Tx } from '@gow/db'
import { pdfProtection } from '@gow/extraction'
import { enqueueProcess, isPdf, MAX_DOCUMENT_BYTES } from '@gow/platform'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, SUPPLIER_NOT_FOUND, who, type BackofficeDeps } from './shared.ts'

const IN_PROGRESS = ['received', 'extracting', 'extracted', 'deciding'] as const

/**
 * `?amount=150000`: pesos, optional; without it the request is decided with the maximum line.
 * `?hold=1`: more statements follow; the request starts with `/start`.
 */
const UploadQuery = z.strictObject({ amount: z.coerce.number().positive().max(1_000_000_000).optional(), hold: z.enum(['1']).optional() })

/** The PDF in the body, checked: not empty, a PDF, no password. */
async function pdfOf(body: unknown): Promise<{ bytes: Buffer; sha256: string }> {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(415, 'manda el estado de cuenta como PDF')
  if (!isPdf(body)) throw new HttpError(415, 'el archivo no es un PDF')
  if ((await pdfProtection(body)) === 'password') throw new HttpError(422, 'el PDF tiene contraseña; descárgalo de nuevo del banco sin contraseña')
  return { bytes: body, sha256: createHash('sha256').update(body).digest('hex') }
}

/**
 * Stores the supplier's PDF, or reuses it if the tenant already has it. The same PDF can be evaluated
 * again for the same supplier (another amount), never for another one, and not while it is running.
 */
async function storeStatement(tx: Tx, deps: BackofficeDeps, tenantId: string, supplierId: string, pdf: { bytes: Buffer; sha256: string }): Promise<{ documentId: string; reused: boolean }> {
  const [existing] = await tx.select({ id: documents.id, supplierId: documents.supplierId }).from(documents).where(eq(documents.sha256, pdf.sha256))
  if (existing) {
    const [other] = await tx
      .select({ id: applications.id })
      .from(applicationDocuments)
      .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
      .where(and(eq(applicationDocuments.documentId, existing.id), ne(applications.supplierId, supplierId)))
      .limit(1)
    if (other || (existing.supplierId !== null && existing.supplierId !== supplierId)) throw new HttpError(409, 'este estado de cuenta ya está en una solicitud de otro proveedor')
    // Processing is one job per document: while one is running, another would never start.
    const [running] = await tx
      .select({ id: applications.id })
      .from(applicationDocuments)
      .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
      .where(and(eq(applicationDocuments.documentId, existing.id), inArray(applications.status, [...IN_PROGRESS])))
      .limit(1)
    if (running) throw new HttpError(409, 'este estado de cuenta ya se está procesando; espera a que termine')
    return { documentId: existing.id, reused: true }
  }
  // If the transaction rolls back later, an orphan file remains; never a row without a file.
  const storagePath = `${tenantId}/${randomUUID()}.pdf`
  await deps.storage.put(storagePath, pdf.bytes)
  const [doc] = await tx.insert(documents).values({ tenantId, supplierId, storagePath, sha256: pdf.sha256, sizeBytes: pdf.bytes.length, mediaType: 'application/pdf' }).returning({ id: documents.id })
  if (!doc) throw new HttpError(500, 'no se guardó el estado de cuenta')
  return { documentId: doc.id, reused: false }
}

/** A request of this supplier still waiting for its documents (opened with `hold`, not started). */
async function heldApplication(tx: Tx, supplierId: string, applicationId: string): Promise<{ id: string }> {
  const [a] = await tx.select({ id: applications.id, status: applications.status, runId: applications.runId }).from(applications).where(and(eq(applications.id, applicationId), eq(applications.supplierId, supplierId)))
  if (!a) throw new HttpError(404, 'solicitud no encontrada')
  if (a.status !== 'received' || a.runId !== null) throw new HttpError(409, 'la solicitud ya se está evaluando; abre otra para agregar estados de cuenta')
  return a
}

const PDF_BODY = express.raw({ type: 'application/pdf', limit: MAX_DOCUMENT_BYTES })

/** Several statements in one request: add them while it waits, then start it. */
function heldRoutes(r: express.Router, deps: BackofficeDeps): void {
  /** Another statement for a request opened with `hold`, before it starts. */
  r.post('/suppliers/:id/statements/:applicationId/documents', PDF_BODY, async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const applicationId = parse(z.uuid(), req.params.applicationId)
    const w = who(res)
    const pdf = await pdfOf(req.body)
    await withTenant(deps.db, w.tenantId, async (tx) => {
      await heldApplication(tx, id, applicationId)
      const stored = await storeStatement(tx, deps, w.tenantId, id, pdf)
      const [linked] = await tx.select({ id: applicationDocuments.documentId }).from(applicationDocuments).where(and(eq(applicationDocuments.applicationId, applicationId), eq(applicationDocuments.documentId, stored.documentId)))
      if (linked) throw new HttpError(409, 'ese estado de cuenta ya está en esta solicitud')
      await tx.insert(applicationDocuments).values({ tenantId: w.tenantId, applicationId, documentId: stored.documentId })
      await audit(tx, w.tenantId, actorOf(w), 'application.document_added', applicationId, { source: 'backoffice', document_reused: stored.reused })
    })
    res.status(201).json({ id: applicationId, status: 'received' })
  })

  /** Starts a request opened with `hold`, with every statement added to it. */
  r.post('/suppliers/:id/statements/:applicationId/start', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const applicationId = parse(z.uuid(), req.params.applicationId)
    const w = who(res)
    const first = await withTenant(deps.db, w.tenantId, async (tx) => {
      await heldApplication(tx, id, applicationId)
      const [doc] = await tx
        .select({ sha256: documents.sha256 })
        .from(applicationDocuments)
        .innerJoin(documents, eq(documents.id, applicationDocuments.documentId))
        .where(eq(applicationDocuments.applicationId, applicationId))
        .orderBy(documents.createdAt, documents.id)
        .limit(1)
      if (!doc) throw new HttpError(409, 'la solicitud no tiene estados de cuenta')
      return doc.sha256
    })
    await enqueueProcess(deps.boss, { tenant_id: w.tenantId, application_id: applicationId }, first)
    const body: SupplierStatementUploaded = { id: applicationId, status: 'received' }
    res.status(202).json(body)
  })
}

export function statementsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  /**
   * Opens a request with the PDF. With `?hold=1` it waits for more PDFs (`/documents`) and for
   * `/start`: several statements sent together, the months of a policy that evaluates three.
   */
  r.post('/suppliers/:id/statements', PDF_BODY, async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const { amount, hold } = parse(UploadQuery, req.query)
    const w = who(res)
    const pdf = await pdfOf(req.body)
    const request = amount === undefined ? null : ApplicationRequest.parse({ amount: Math.round(amount * 100) / 100, maturity: null, buyer: null })

    const created = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [supplier] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, id))
      if (!supplier) throw new HttpError(404, SUPPLIER_NOT_FOUND)
      const stored = await storeStatement(tx, deps, w.tenantId, id, pdf)
      const [app] = await tx.insert(applications).values({ tenantId: w.tenantId, supplierId: id, request, asOf: null }).returning({ id: applications.id })
      if (!app) throw new HttpError(500, 'no se creó la solicitud')
      await tx.insert(applicationDocuments).values({ tenantId: w.tenantId, applicationId: app.id, documentId: stored.documentId })
      // Ids and whether there was an amount; never the document's content.
      await audit(tx, w.tenantId, actorOf(w), 'application.received', app.id, { source: 'backoffice', supplier_id: id, amount_given: request !== null, document_reused: stored.reused, held: hold === '1' })
      return app.id
    })
    if (hold !== '1') await enqueueProcess(deps.boss, { tenant_id: w.tenantId, application_id: created }, pdf.sha256)
    const body: SupplierStatementUploaded = { id: created, status: 'received' }
    res.status(201).json(body)
  })

  heldRoutes(r, deps)

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
