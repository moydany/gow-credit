/**
 * API del modo full (docs/02 §1 y §4, docs/05 §2 y §5). Reglas:
 * - La API nunca ejecuta un workflow: guarda y encola.
 * - El tenant sale de la llave de API (hash, comparación en tiempo constante), nunca de un
 *   parámetro; cada consulta corre en `withTenant` con el rol `gow_api`.
 * - Zod en cada cuerpo; los errores devuelven la ruta del campo, nunca el valor.
 * - El PDF no pasa por la API: URL firmada de vida corta, y al crear la solicitud se lee del
 *   almacenamiento propio (nunca de una URL del usuario).
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
import { answerClarification, audit, createPolicyDraft, HttpError, parse, PolicyBody, recordOutcome, simulateVersion, transitionVersion } from './ops.ts'

export interface ApiDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  /** Secreto del webhook de correo entrante (Svix); sin él, el webhook responde 404. */
  resendWebhookSecret?: string | null
  /** Solo escenarios: acepta estados de cuenta sintéticos además de PDF. */
  allowSynthetic?: boolean
  /** Peticiones por minuto por llave. */
  rateLimitPerMinute?: number
  logger?: { error(message: string): void }
  /** Secreto con el que se verifican los JWT del backoffice; sin él `/bo/v1` responde 404. */
  backofficeJwtSecret?: string | null
  /** Cookie de sesión con `Secure` (producción detrás de HTTPS). */
  secureCookies?: boolean
  /** Origen del backoffice para los enlaces de acceso de usuarios invitados (`BACKOFFICE_URL`). */
  backofficeUrl?: string | null
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

/** "Nombre <correo@x>" → correo@x */
function bareAddress(a: string): string {
  return (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase()
}

export function createApp(deps: ApiDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  const windows = new Map<string, { start: number; count: number }>()
  const limitPerMinute = deps.rateLimitPerMinute ?? 120

  // ---------- Subida directa (solo almacenamiento local de desarrollo y escenarios)
  if (deps.storage instanceof LocalDocumentStorage) {
    const local = deps.storage
    app.put('/storage/upload/:token', express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
      const path = local.verifyUploadToken(req.params.token)
      if (!path) throw new HttpError(403, 'URL de subida inválida o vencida')
      const body = req.body as Buffer
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'cuerpo vacío')
      await local.put(path, body)
      res.status(204).end()
    })
  }

  // ---------- Webhook de correo entrante (Resend, firmado con Svix)
  app.post('/v1/webhooks/resend', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    const secret = deps.resendWebhookSecret
    if (!secret) throw new HttpError(404, 'no encontrado')
    const body = typeof req.body === 'string' ? req.body : ''
    if (!verifySvix(secret, { id: req.header('svix-id'), timestamp: req.header('svix-timestamp'), signature: req.header('svix-signature') }, body)) throw new HttpError(401, 'firma inválida')
    const event = ResendInbound.safeParse(JSON.parse(body))
    // Siempre 200 tras verificar: la respuesta no dice si el destinatario existe.
    if (!event.success || event.data.type !== 'email.received') return void res.status(200).json({ ok: true })
    const to = (Array.isArray(event.data.data.to) ? event.data.data.to : [event.data.data.to]).map(bareAddress)
    for (const address of to) {
      const found = await deps.db.execute<{ tenant: string | null }>(sql`select app.tenant_by_email(${address})::text as tenant`)
      const tenantId = found.rows[0]?.tenant
      if (!tenantId) continue
      await withTenant(deps.db, tenantId, (tx) =>
        tx
          .insert(inboundMessages)
          .values({ tenantId, channel: 'email', fromAddress: bareAddress(event.data.data.from), externalId: event.data.data.email_id ?? req.header('svix-id') ?? null, body: (event.data.data.text ?? '').split('\n')[0]?.slice(0, 2000) ?? '' })
          .onConflictDoNothing(),
      )
    }
    res.status(200).json({ ok: true })
  })

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  // ---------- Autenticación por llave de API y límite por llave
  const v1 = express.Router()
  v1.use(express.json({ limit: '1mb' }))
  v1.use(async (req, res, next) => {
    const header = req.header('authorization') ?? ''
    const m = /^Bearer (gowk_[0-9a-f]{8})\.([A-Za-z0-9_-]{20,})$/.exec(header)
    if (!m?.[1] || !m[2]) throw new HttpError(401, 'llave de API requerida')
    const found = await deps.db.execute<{ tenant_id: string; key_hash: string; scopes: string[] }>(sql`select tenant_id::text, key_hash, scopes from app.resolve_api_key(${m[1]})`)
    const row = found.rows[0]
    const got = Buffer.from(hashSecret(m[2]))
    if (!row || got.length !== Buffer.from(row.key_hash).length || !timingSafeEqual(got, Buffer.from(row.key_hash))) throw new HttpError(401, 'llave de API inválida')
    const now = Date.now()
    const w = windows.get(m[1])
    if (!w || now - w.start > 60_000) windows.set(m[1], { start: now, count: 1 })
    else if (++w.count > limitPerMinute) throw new HttpError(429, 'demasiadas peticiones')
    res.locals.auth = { tenantId: row.tenant_id, scopes: row.scopes, keyPrefix: m[1] } satisfies Auth
    next()
  })
  const need = (scope: ApiKeyScope) => (_req: Request, res: Response, next: NextFunction) => {
    if (!auth(res).scopes.includes(scope)) throw new HttpError(403, `la llave no tiene el alcance ${scope}`)
    next()
  }
  const actor = (res: Response) => `api:${auth(res).keyPrefix}`

  // ---------- Documentos
  v1.post('/uploads', need('ingest'), (req, res) => {
    const body = parse(z.strictObject({ synthetic: z.boolean().default(false) }), req.body ?? {})
    if (body.synthetic && deps.allowSynthetic !== true) throw new HttpError(400, 'los documentos sintéticos solo existen en escenarios')
    res.status(201).json(deps.storage.createSignedUpload(auth(res).tenantId, undefined, body.synthetic ? SyntheticSuffix : '.pdf'))
  })

  // ---------- Proveedores y vínculos verificados
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

  // ---------- Solicitudes
  v1.post('/applications', need('ingest'), async (req, res) => {
    const body = parse(ApplicationBody, req.body)
    const { tenantId } = auth(res)
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
      await audit(tx, tenantId, actor(res), 'application.received', created.id)
      return { id: created.id, duplicate: false }
    })
    if (!result.duplicate) await enqueueProcess(deps.boss, { tenant_id: tenantId, application_id: result.id }, sha256)
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

  /** Respuestas por la API (integración o enlace de un solo uso): las que no van por WhatsApp o correo. */
  v1.post('/clarifications/:id/answers', need('ingest'), async (req, res) => {
    res.json(await answerClarification(deps, auth(res).tenantId, actor(res), parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Políticas: borrador → simular → sombra → activa (docs/03 §5)
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

  // ---------- Outcomes (docs/03 §8)
  v1.post('/outcomes', need('ingest'), async (req, res) => {
    await recordOutcome(deps.db, auth(res).tenantId, actor(res), req.body)
    res.status(201).json({ ok: true })
  })

  // ---------- Backoffice: sesión de usuario, no llave de API (docs/08)
  if (deps.backofficeJwtSecret) app.use('/bo/v1', backofficeRouter({ ...deps, backofficeJwtSecret: deps.backofficeJwtSecret }))

  app.use('/v1', v1)

  app.use((_req, _res) => {
    throw new HttpError(404, 'no encontrado')
  })
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...(err.issues.length ? { issues: err.issues } : {}) })
    const e = err as { type?: string; status?: number }
    if (e.type === 'entity.too.large') return void res.status(413).json({ error: 'cuerpo demasiado grande' })
    if (e.type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON inválido' })
    // Sin detalle hacia afuera ni hacia el log: solo el tipo.
    deps.logger?.error(`api: ${err instanceof Error ? err.name : 'error'}`)
    res.status(500).json({ error: 'error interno' })
  })
  return app
}
