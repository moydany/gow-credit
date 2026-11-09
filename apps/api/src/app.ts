/**
 * Full-mode API. Rules:
 * - The API never runs a workflow: it stores and enqueues.
 * - The tenant comes from the API key (hash, constant-time compare), never from a parameter;
 *   each query runs in `withTenant` with the `gow_api` role.
 * - Zod on every body; errors return the field path, never the value.
 * - The PDF does not go through the API: short-lived signed URL, and on request creation it is
 *   read from our own storage (never from a user URL).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { verifySvix } from '@gow/channels'
import { ApplicationRequest, IsoDate } from '@gow/contracts'
import { applicationDocuments, applications, clarifications, decisions, documents, inboundMessages, policyVersions, supplierContacts, suppliers, withTenant, type Db } from '@gow/db'
import { enqueueProcess, isPdf, LocalDocumentStorage, MAX_DOCUMENT_BYTES, pathBelongsTo, type DocumentStorage, type PgBoss } from '@gow/platform'
import { and, desc, eq, sql } from 'drizzle-orm'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { hashSecret, type ApiKeyScope } from './admin.ts'
import { backofficeRouter } from './backoffice.ts'
import type { PromptEditors } from './bo/prompts.ts'
import { answerClarification, audit, createPolicyDraft, HttpError, parse, PolicyBody, recordOutcome, simulateVersion, transitionVersion } from './ops.ts'
import { createWindowLimiter } from './rate-limit.ts'
import type { AuthDirectory } from './supabase-auth.ts'

export interface ApiDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  /** Inbound email webhook secret (Svix); without it the webhook returns 404. */
  resendWebhookSecret?: string | null
  /** Scenarios only: accepts synthetic statements besides PDF. */
  allowSynthetic?: boolean
  /** Requests per minute per key. */
  rateLimitPerMinute?: number
  logger?: { error(message: string): void }
  /** Secret that verifies backoffice JWTs; without it `/bo/v1` returns 404. */
  backofficeJwtSecret?: string | null
  /** Session cookie with `Secure` (production behind HTTPS). */
  secureCookies?: boolean
  /** Backoffice origin for invited users' access links (`BACKOFFICE_URL`). */
  backofficeUrl?: string | null
  /** Supabase Auth for email login to the backoffice; without it, only the JWT link works. */
  auth?: AuthDirectory | null
  /** Renewable Supabase Auth session limits, in hours: absolute and idle. */
  sessionMaxHours?: number
  sessionIdleHours?: number
  /** Who creates and activates prompt versions; null: only with a single lender. */
  promptEditors?: PromptEditors
  /** `SETUP_PASSWORD`: with it, the first-run wizard asks for it before creating the lender. */
  setupPassword?: string | null
}

interface Auth {
  tenantId: string
  scopes: string[]
  keyPrefix: string
}

function auth(res: Response): Auth {
  return res.locals.auth as Auth
}

const SyntheticSuffix = '.synthetic.json'

const SupplierBody = z.strictObject({
  external_ref: z.string().min(1).nullable().default(null),
  legal_name: z.string().min(1),
  rfc: z.string().min(1).nullable().default(null),
  clabes: z.array(z.string().min(1)).default([]),
  contacts: z.array(z.strictObject({ channel: z.enum(['whatsapp', 'email']), address: z.string().min(3), verified_by_kyc: z.boolean().default(false) })).default([]),
})

const ContactBody = z.strictObject({ channel: z.enum(['whatsapp', 'email']), address: z.string().min(3), verified_by_kyc: z.boolean().default(false) })

const ApplicationBody = z.strictObject({
  supplier_id: z.uuid(),
  document_path: z.string().min(1),
  request: ApplicationRequest.nullable().default(null),
  as_of: IsoDate.nullable().default(null),
})

const ResendInbound = z.object({
  type: z.string(),
  data: z.object({ email_id: z.string().optional(), from: z.string(), to: z.union([z.string(), z.array(z.string())]), text: z.string().optional() }),
})

/** "Name <email@x>" → email@x */
function bareAddress(a: string): string {
  return (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase()
}

function mountUploadRoute(app: express.Express, storage: DocumentStorage): void {
  if (!(storage instanceof LocalDocumentStorage)) return
  const local = storage
  app.put('/storage/upload/:token', express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    const path = local.verifyUploadToken(req.params.token)
    if (!path) throw new HttpError(403, 'URL de subida inválida o vencida')
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'cuerpo vacío')
    await local.put(path, body)
    res.status(204).end()
  })
}

function mountResendWebhook(app: express.Express, deps: ApiDeps): void {
  app.post('/v1/webhooks/resend', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    const secret = deps.resendWebhookSecret
    if (!secret) throw new HttpError(404, 'no encontrado')
    const body = typeof req.body === 'string' ? req.body : ''
    if (!verifySvix(secret, { id: req.header('svix-id'), timestamp: req.header('svix-timestamp'), signature: req.header('svix-signature') }, body)) {
      throw new HttpError(401, 'firma inválida')
    }
    const event = ResendInbound.safeParse(JSON.parse(body))
    if (!event.success || event.data.type !== 'email.received') return void res.status(200).json({ ok: true })
    const to = (Array.isArray(event.data.data.to) ? event.data.data.to : [event.data.data.to]).map(bareAddress)
    for (const address of to) {
      const found = await deps.db.execute<{ tenant: string | null }>(sql`select app.tenant_by_email(${address})::text as tenant`)
      const tenantId = found.rows[0]?.tenant
      if (!tenantId) continue
      await withTenant(deps.db, tenantId, (tx) =>
        tx
          .insert(inboundMessages)
          .values({
            tenantId,
            channel: 'email',
            fromAddress: bareAddress(event.data.data.from),
            externalId: event.data.data.email_id ?? req.header('svix-id') ?? null,
            body: (event.data.data.text ?? '').split('\n')[0]?.slice(0, 2000) ?? '',
          })
          .onConflictDoNothing(),
      )
    }
    res.status(200).json({ ok: true })
  })
}

function createV1AuthMiddleware(
  deps: ApiDeps,
  rateLimiter: (key: string) => boolean,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? ''
    const m = /^Bearer (gowk_[0-9a-f]{8})\.([A-Za-z0-9_-]{20,})$/.exec(header)
    if (!m?.[1] || !m[2]) throw new HttpError(401, 'llave de API requerida')
    const found = await deps.db.execute<{ tenant_id: string; key_hash: string; scopes: string[] }>(
      sql`select tenant_id::text, key_hash, scopes from app.resolve_api_key(${m[1]})`,
    )
    const row = found.rows[0]
    const got = Buffer.from(hashSecret(m[2]))
    if (!row || got.length !== Buffer.from(row.key_hash).length || !timingSafeEqual(got, Buffer.from(row.key_hash))) {
      throw new HttpError(401, 'llave de API inválida')
    }
    if (!rateLimiter(m[1])) throw new HttpError(429, 'demasiadas peticiones')
    res.locals.auth = { tenantId: row.tenant_id, scopes: row.scopes, keyPrefix: m[1] } satisfies Auth
    next()
  }
}

function mountSuppliersRoutes(
  v1: express.Router,
  deps: ApiDeps,
  need: (scope: ApiKeyScope) => express.RequestHandler,
  actor: (res: Response) => string,
): void {
  v1.post('/suppliers', need('ingest'), async (req, res) => {
    const body = parse(SupplierBody, req.body)
    const { tenantId } = auth(res)
    const supplier = await withTenant(deps.db, tenantId, async (tx) => {
      const [s] = await tx.insert(suppliers).values({ tenantId, externalRef: body.external_ref, legalName: body.legal_name, rfc: body.rfc, clabes: body.clabes }).returning()
      if (!s) throw new HttpError(500, 'no se creó el proveedor')
      for (const c of body.contacts) {
        await tx.insert(supplierContacts).values({ tenantId, supplierId: s.id, channel: c.channel, address: c.address, verifiedAt: c.verified_by_kyc ? new Date() : null, verificationMethod: c.verified_by_kyc ? 'kyc' : null })
      }
      await audit(tx, tenantId, actor(res), 'supplier.created', s.id, { contacts: body.contacts.length })
      return s
    })
    res.status(201).json({ id: supplier.id, external_ref: supplier.externalRef, legal_name: supplier.legalName })
  })

  v1.post('/suppliers/:id/contacts', need('ingest'), async (req, res) => {
    const body = parse(ContactBody, req.body)
    const supplierId = parse(z.uuid(), req.params.id)
    const { tenantId } = auth(res)
    const contact = await withTenant(deps.db, tenantId, async (tx) => {
      const [s] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId))
      if (!s) throw new HttpError(404, 'proveedor no encontrado')
      const [c] = await tx.insert(supplierContacts).values({ tenantId, supplierId, channel: body.channel, address: body.address, verifiedAt: body.verified_by_kyc ? new Date() : null, verificationMethod: body.verified_by_kyc ? 'kyc' : null }).returning()
      await audit(tx, tenantId, actor(res), 'contact.created', c?.id ?? null, { channel: body.channel, verified: body.verified_by_kyc })
      return c
    })
    res.status(201).json({ id: contact?.id, verified: body.verified_by_kyc })
  })
}

async function createApplicationDocument(
  deps: ApiDeps,
  tenantId: string,
  body: z.infer<typeof ApplicationBody>,
  actorName: string,
): Promise<{ id: string; duplicate: boolean }> {
  if (!pathBelongsTo(body.document_path, tenantId)) throw new HttpError(403, 'el documento no es de este tenant')
  if (!(await deps.storage.exists(body.document_path))) throw new HttpError(404, 'documento no encontrado; súbelo primero')
  const bytes = await deps.storage.read(body.document_path)
  const synthetic = deps.allowSynthetic === true && body.document_path.endsWith(SyntheticSuffix)
  if (!synthetic && !isPdf(bytes)) throw new HttpError(415, 'el documento no es un PDF')
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'el documento excede el tamaño máximo')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const result = await withTenant(deps.db, tenantId, async (tx) => {
    const [supplier] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, body.supplier_id))
    if (!supplier) throw new HttpError(404, 'proveedor no encontrado')
    const [existing] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.sha256, sha256))
    if (existing) {
      const [link] = await tx.select({ applicationId: applicationDocuments.applicationId }).from(applicationDocuments).where(eq(applicationDocuments.documentId, existing.id))
      if (link) return { id: link.applicationId, duplicate: true }
    }
    const [doc] = existing ? [existing] : await tx.insert(documents).values({ tenantId, supplierId: supplier.id, storagePath: body.document_path, sha256, sizeBytes: bytes.length, mediaType: synthetic ? 'application/json' : 'application/pdf' }).returning({ id: documents.id })
    const [created] = await tx.insert(applications).values({ tenantId, supplierId: supplier.id, request: body.request, asOf: body.as_of }).returning({ id: applications.id })
    if (!doc || !created) throw new HttpError(500, 'no se creó la solicitud')
    await tx.insert(applicationDocuments).values({ tenantId, applicationId: created.id, documentId: doc.id })
    await audit(tx, tenantId, actorName, 'application.received', created.id)
    return { id: created.id, duplicate: false }
  })
  if (!result.duplicate) await enqueueProcess(deps.boss, { tenant_id: tenantId, application_id: result.id }, sha256)
  return result
}

function mountApplicationsRoutes(
  v1: express.Router,
  deps: ApiDeps,
  need: (scope: ApiKeyScope) => express.RequestHandler,
  actor: (res: Response) => string,
): void {
  v1.post('/applications', need('ingest'), async (req, res) => {
    const body = parse(ApplicationBody, req.body)
    const { tenantId } = auth(res)
    const result = await createApplicationDocument(deps, tenantId, body, actor(res))
    res.status(result.duplicate ? 200 : 201).json({ id: result.id, status: result.duplicate ? undefined : 'received', duplicate: result.duplicate })
  })

  v1.get('/applications/:id', need('read'), async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const { tenantId } = auth(res)
    const out = await withTenant(deps.db, tenantId, async (tx) => {
      const [a] = await tx.select().from(applications).where(eq(applications.id, id))
      if (!a) throw new HttpError(404, 'solicitud no encontrada')
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
      const [shadow] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'shadow'))).orderBy(desc(decisions.createdAt)).limit(1)
      const open = await tx.select().from(clarifications).where(and(eq(clarifications.applicationId, id), eq(clarifications.status, 'open')))
      return { a, d, shadow, open }
    })
    const decision = out.d ? (out.d.payload as { reasons: { code: string }[]; next_steps: { message: string | null }[] }) : null
    res.json({
      id: out.a.id,
      status: out.a.status,
      failure_reason: out.a.failureReason,
      decision: out.d ? { status: out.d.status, limit: out.d.limitAmount === null ? null : Number(out.d.limitAmount), score: out.d.score === null ? null : Number(out.d.score), reasons: decision?.reasons.map((r) => r.code) ?? [], next_steps: decision?.next_steps.map((s) => s.message) ?? [] } : null,
      shadow_decision: out.shadow ? { status: out.shadow.status, limit: out.shadow.limitAmount === null ? null : Number(out.shadow.limitAmount) } : null,
      open_clarifications: out.open.map((c) => ({ id: c.id, channel: c.channel, round: c.round })),
    })
  })

  v1.get('/applications/:id/clarifications', need('read'), async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const rows = await withTenant(deps.db, auth(res).tenantId, (tx) => tx.select().from(clarifications).where(eq(clarifications.applicationId, id)).orderBy(clarifications.round))
    res.json(rows.map((c) => ({ id: c.id, round: c.round, status: c.status, channel: c.channel, questions: c.questions, answers: c.answers })))
  })

  v1.post('/clarifications/:id/answers', need('ingest'), async (req, res) => {
    res.json(await answerClarification(deps, auth(res).tenantId, actor(res), parse(z.uuid(), req.params.id), req.body))
  })
}

function mountPoliciesAndOutcomesRoutes(
  v1: express.Router,
  deps: ApiDeps,
  need: (scope: ApiKeyScope) => express.RequestHandler,
  actor: (res: Response) => string,
): void {
  v1.get('/policies/versions', need('policies'), async (_req, res) => {
    const rows = await withTenant(deps.db, auth(res).tenantId, (tx) => tx.select({ id: policyVersions.id, version: policyVersions.version, status: policyVersions.status, created_at: policyVersions.createdAt, activated_at: policyVersions.activatedAt }).from(policyVersions).orderBy(desc(policyVersions.version)))
    res.json(rows)
  })

  v1.post('/policies/versions', need('policies'), async (req, res) => {
    const body = parse(PolicyBody, req.body)
    res.status(201).json(await createPolicyDraft(deps.db, auth(res).tenantId, actor(res), body.document))
  })

  v1.post('/policies/versions/:id/simulate', need('policies'), async (req, res) => {
    res.json(await simulateVersion(deps.db, auth(res).tenantId, actor(res), parse(z.uuid(), req.params.id)))
  })

  v1.post('/policies/versions/:id/shadow', need('policies'), async (req, res) => {
    res.json(await transitionVersion(deps.db, auth(res).tenantId, actor(res), parse(z.uuid(), req.params.id), 'shadow'))
  })

  v1.post('/policies/versions/:id/activate', need('policies'), async (req, res) => {
    res.json(await transitionVersion(deps.db, auth(res).tenantId, actor(res), parse(z.uuid(), req.params.id), 'active'))
  })

  v1.post('/outcomes', need('ingest'), async (req, res) => {
    await recordOutcome(deps.db, auth(res).tenantId, actor(res), req.body)
    res.status(201).json({ ok: true })
  })
}

function createV1Router(deps: ApiDeps, rateLimiter: (key: string) => boolean): express.Router {
  const v1 = express.Router()
  v1.use(express.json({ limit: '1mb' }))
  v1.use(createV1AuthMiddleware(deps, rateLimiter))

  const need = (scope: ApiKeyScope) => (_req: Request, res: Response, next: NextFunction) => {
    if (!auth(res).scopes.includes(scope)) throw new HttpError(403, `la llave no tiene el alcance ${scope}`)
    next()
  }
  const actor = (res: Response) => `api:${auth(res).keyPrefix}`

  v1.post('/uploads', need('ingest'), (req, res) => {
    const body = parse(z.strictObject({ synthetic: z.boolean().default(false) }), req.body ?? {})
    if (body.synthetic && deps.allowSynthetic !== true) throw new HttpError(400, 'los documentos sintéticos solo existen en escenarios')
    res.status(201).json(deps.storage.createSignedUpload(auth(res).tenantId, undefined, body.synthetic ? SyntheticSuffix : '.pdf'))
  })

  mountSuppliersRoutes(v1, deps, need, actor)
  mountApplicationsRoutes(v1, deps, need, actor)
  mountPoliciesAndOutcomesRoutes(v1, deps, need, actor)

  return v1
}

function mountErrorHandlers(app: express.Express, deps: ApiDeps): void {
  app.use((_req, _res) => {
    throw new HttpError(404, 'no encontrado')
  })
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...(err.issues.length ? { issues: err.issues } : {}) })
    const e = err as { type?: string; status?: number }
    if (e.type === 'entity.too.large') return void res.status(413).json({ error: 'cuerpo demasiado grande' })
    if (e.type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON inválido' })
    deps.logger?.error(`api: ${err instanceof Error ? err.name : 'error'}`)
    res.status(500).json({ error: 'error interno' })
  })
}

export function createApp(deps: ApiDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')

  mountUploadRoute(app, deps.storage)
  mountResendWebhook(app, deps)

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  const rateLimiter = createWindowLimiter(deps.rateLimitPerMinute ?? 120, 60_000)
  app.use('/v1', createV1Router(deps, rateLimiter))

  if (deps.backofficeJwtSecret) {
    app.use('/bo/v1', backofficeRouter({ ...deps, backofficeJwtSecret: deps.backofficeJwtSecret }))
  }

  mountErrorHandlers(app, deps)
  return app
}
