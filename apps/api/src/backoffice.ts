/**
 * API del backoffice (docs/08): lo que lee y hace un usuario del prestamista desde el navegador.
 * Misma regla que `/v1`: el tenant sale de la credencial (aquí la sesión), nunca de un parámetro,
 * y todo corre en `withTenant` con el rol `gow_api`. Cada mutación entra a la bitácora con el
 * usuario; la vista de una solicitud también (docs/08 §2, "quién vio qué").
 */
import { applicationDocuments, applications, decisions, documents, extractions, outcomes, policyVersions, suppliers, tenants, tenantUsers, withTenant, type Db } from '@gow/db'
import { applyCorrections } from '@gow/extraction/corrections'
import { ClarificationStatus, CorrectionTarget, type ApplicationDetail, type Correction, type ApplicationRow, type AuditEntry, type BackofficeMe, type ClarificationItem, type PolicyVersionItem, ApplicationStatus } from '@gow/contracts'
import { pathBelongsTo, type DocumentStorage, type PgBoss } from '@gow/platform'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { answerClarification, audit, createPolicyDraft, HttpError, parse, PolicyBody, recordCorrections, recordOutcome, simulateVersion, transitionVersion } from './ops.ts'
import { CSRF_HEADER, clearedCookie, readCookie, SESSION_COOKIE, sessionCookie, verifyToken } from './session.ts'

export interface BackofficeDeps {
  db: Db
  boss: PgBoss
  storage: DocumentStorage
  backofficeJwtSecret: string
  secureCookies?: boolean
}

interface Who {
  userId: string
  email: string
  tenantId: string
}

const SESSION_SECONDS = 8 * 60 * 60

const who = (res: Response) => res.locals.who as Who
const actorOf = (w: Who) => `user:${w.userId}`
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

export function backofficeRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.use(express.json({ limit: '2mb' }))
  r.use((_req, res, next) => {
    // Datos de un tenant: nunca en cachés compartidas.
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  const attempts = new Map<string, { start: number; count: number }>()
  const secure = deps.secureCookies === true

  async function membership(token: string): Promise<Who | null> {
    const claims = verifyToken(deps.backofficeJwtSecret, token)
    if (!claims) return null
    const [m] = await withTenant(deps.db, claims.tenant_id, (tx) => tx.select().from(tenantUsers).where(and(eq(tenantUsers.tenantId, claims.tenant_id), eq(tenantUsers.userId, claims.sub))))
    return m ? { userId: m.userId, email: m.email, tenantId: m.tenantId } : null
  }

  async function meOf(w: Who): Promise<BackofficeMe> {
    const [t] = await withTenant(deps.db, w.tenantId, (tx) => tx.select({ id: tenants.id, name: tenants.name, whatsapp: tenants.whatsappNumber }).from(tenants).where(eq(tenants.id, w.tenantId)))
    if (!t) throw new HttpError(401, 'sesión inválida')
    return { user: { id: w.userId, email: w.email }, tenant: { id: t.id, name: t.name, whatsapp_number: t.whatsapp } }
  }

  // ---------- Sesión: el enlace de acceso trae el JWT; la API lo cambia por una cookie HttpOnly
  r.post('/session', async (req, res) => {
    const key = req.ip ?? 'local'
    const now = Date.now()
    const w0 = attempts.get(key)
    if (!w0 || now - w0.start > 60_000) attempts.set(key, { start: now, count: 1 })
    else if (++w0.count > 20) throw new HttpError(429, 'demasiados intentos')
    if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
    const body = parse(z.strictObject({ token: z.string().min(20).max(4000) }), req.body)
    const w = await membership(body.token)
    if (!w) throw new HttpError(401, 'el enlace de acceso no es válido o ya venció')
    res.setHeader('Set-Cookie', sessionCookie(body.token, { maxAgeSeconds: SESSION_SECONDS, secure }))
    res.json(await meOf(w))
  })

  r.delete('/session', (req, res) => {
    if (req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
    res.setHeader('Set-Cookie', clearedCookie(secure))
    res.status(204).end()
  })

  // ---------- Todo lo demás exige sesión vigente y miembro del tenant
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1]
    const token = bearer ?? readCookie(req.header('cookie'), SESSION_COOKIE)
    const w = token ? await membership(token) : null
    if (!w) throw new HttpError(401, 'sesión requerida')
    // Con cookie, toda escritura debe traer el encabezado: un formulario de otro sitio no puede.
    if (!['GET', 'HEAD'].includes(req.method) && !bearer && req.header(CSRF_HEADER) !== '1') throw new HttpError(403, 'petición no permitida')
    res.locals.who = w
    next()
  })

  r.get('/me', async (_req, res) => {
    res.json(await meOf(who(res)))
  })

  // ---------- Bandeja de solicitudes
  r.get('/applications', async (req, res) => {
    const w = who(res)
    const statuses = typeof req.query.status === 'string' && req.query.status ? z.array(ApplicationStatus).parse(req.query.status.split(',')) : null
    const rows = await withTenant(deps.db, w.tenantId, async (tx) => {
      const out = await tx.execute<{
        id: string; status: ApplicationRow['status']; failure_reason: string | null; request: ApplicationRow['request']; created_at: Date; updated_at: Date
        supplier_id: string; legal_name: string
        decision_status: NonNullable<ApplicationRow['decision']>['status'] | null; limit_amount: string | null; score: string | null; policy_version: number | null; reasons: { code: string; message: string }[] | null
        file_name: string | null; bank: string | null; page_count: number | null; issues: number | null; flags: string[] | null; has_extraction: boolean
        open_clarifications: number; outcome: ApplicationRow['outcome']
      }>(sql`
        select a.id, a.status, a.failure_reason, a.request, a.created_at, a.updated_at,
               s.id as supplier_id, s.legal_name,
               d.status as decision_status, d.limit_amount, d.score, pv.version as policy_version, d.reasons,
               e.file_name, e.bank, e.page_count, e.issues, e.flags, (e.file_name is not null) as has_extraction,
               (select count(*)::int from app.clarifications c where c.application_id = a.id and c.status = 'open') as open_clarifications,
               (select o.outcome from app.outcomes o where o.application_id = a.id order by o.observed_at desc limit 1) as outcome
          from app.applications a
          join app.suppliers s on s.id = a.supplier_id
          left join lateral (select dd.status, dd.limit_amount, dd.score, dd.policy_version_id, dd.payload->'reasons' as reasons from app.decisions dd where dd.application_id = a.id and dd.kind = 'active' order by dd.created_at desc limit 1) d on true
          left join app.policy_versions pv on pv.id = d.policy_version_id
          left join lateral (
            select ex.payload->'document'->>'file_name' as file_name, ex.payload->'bank_name'->>'value' as bank,
                   (ex.payload->'document'->>'page_count')::int as page_count, jsonb_array_length(ex.payload->'issues')::int as issues,
                   array(select jsonb_array_elements_text(ex.payload->'flags')) as flags
              from app.application_documents ad join app.extractions ex on ex.document_id = ad.document_id
             where ad.application_id = a.id order by ex.created_at limit 1) e on true
         ${statuses ? sql`where a.status in (${sql.join(statuses.map((s) => sql`${s}::app.application_status`), sql`, `)})` : sql``}
         order by a.created_at desc
         limit 300`)
      return out.rows
    })
    const list: ApplicationRow[] = rows.map((x) => ({
      id: x.id,
      status: x.status,
      failure_reason: x.failure_reason,
      supplier: { id: x.supplier_id, legal_name: x.legal_name },
      request: x.request,
      decision: x.decision_status ? { status: x.decision_status, limit: x.limit_amount === null ? null : Number(x.limit_amount), score: x.score === null ? null : Number(x.score), policy_version: x.policy_version, reasons: (x.reasons ?? []).map((r) => ({ code: r.code, message: r.message })) } : null,
      document: x.has_extraction ? { file_name: x.file_name, bank: x.bank, page_count: x.page_count, issues: x.issues ?? 0, flags: x.flags ?? [] } : null,
      open_clarifications: x.open_clarifications,
      outcome: x.outcome,
      created_at: new Date(x.created_at).toISOString(),
      updated_at: new Date(x.updated_at).toISOString(),
    }))
    res.json(list)
  })

  // ---------- Detalle: documento, extracción, decisión, aclaraciones
  async function clarificationItems(tx: Parameters<Parameters<Db['transaction']>[0]>[0], where: ReturnType<typeof sql>): Promise<ClarificationItem[]> {
    const rows = await tx.execute<{
      id: string; application_id: string; legal_name: string; round: number; status: ClarificationItem['status']; channel: ClarificationItem['channel']
      questions: ClarificationItem['questions']; answers: ClarificationItem['answers']; created_at: Date; answered_at: Date | null; answered_by: string | null
    }>(sql`
      select c.id, c.application_id, s.legal_name, c.round, c.status, c.channel, c.questions, c.answers, c.created_at, c.answered_at,
             (select u.email from app.audit_log l join app.tenant_users u on 'user:' || u.user_id::text = l.actor
               where l.subject = c.id::text and l.action = 'clarification.answered' order by l.at desc limit 1) as answered_by
        from app.clarifications c join app.suppliers s on s.id = c.supplier_id
       where ${where}
       order by c.created_at desc`)
    return rows.rows.map((c) => ({ id: c.id, application_id: c.application_id, supplier_name: c.legal_name, round: c.round, status: c.status, channel: c.channel, questions: c.questions, answers: c.answers, created_at: new Date(c.created_at).toISOString(), answered_at: iso(c.answered_at), answered_by: c.answered_by }))
  }

  r.get('/applications/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [a] = await tx.select().from(applications).where(eq(applications.id, id))
      if (!a) throw new HttpError(404, 'solicitud no encontrada')
      const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, a.supplierId))
      if (!s) throw new HttpError(404, 'proveedor no encontrado')
      const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, id))
      const docs = links.length ? await tx.select().from(documents).where(inArray(documents.id, links.map((l) => l.documentId))) : []
      const [ex] = docs.length ? await tx.select().from(extractions).where(inArray(extractions.documentId, docs.map((d) => d.id))).orderBy(extractions.createdAt).limit(1) : []
      const [dec] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
      const [shadow] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'shadow'))).orderBy(desc(decisions.createdAt)).limit(1)
      const versionIds = [dec?.policyVersionId, shadow?.policyVersionId].filter((v): v is string => !!v)
      const versions = versionIds.length ? await tx.select({ id: policyVersions.id, version: policyVersions.version }).from(policyVersions).where(inArray(policyVersions.id, versionIds)) : []
      const clar = await clarificationItems(tx, sql`c.application_id = ${id}::uuid`)
      const outs = await tx.select().from(outcomes).where(eq(outcomes.applicationId, id)).orderBy(desc(outcomes.observedAt))
      const fixes = await tx.execute<{ id: string; target: unknown; read_value: string | number | null; value: string | number; page: number | null; created_by: string | null; created_at: Date }>(sql`
        select c.id, c.target, c.read_value, c.value, c.page, u.email as created_by, c.created_at
          from app.corrections c left join app.tenant_users u on u.user_id = c.created_by
         where c.application_id = ${id}::uuid order by c.created_at`)
      await audit(tx, w.tenantId, actorOf(w), 'application.viewed', id)
      return { a, s, docs, ex, dec, shadow, versions, clar, outs, fixes: fixes.rows }
    })
    const fixes: Correction[] = out.fixes.map((c) => ({ id: c.id, target: CorrectionTarget.parse(c.target), read_value: c.read_value, value: c.value, page: c.page, created_by: c.created_by, created_at: new Date(c.created_at).toISOString() }))
    const version = (vid: string | null | undefined) => out.versions.find((v) => v.id === vid)?.version ?? null
    const detail: ApplicationDetail = {
      id: out.a.id,
      status: out.a.status,
      failure_reason: out.a.failureReason,
      request: out.a.request as ApplicationDetail['request'],
      as_of: out.a.asOf,
      created_at: out.a.createdAt.toISOString(),
      updated_at: out.a.updatedAt.toISOString(),
      supplier: { id: out.s.id, legal_name: out.s.legalName, rfc: out.s.rfc, external_ref: out.s.externalRef, clabes: out.s.clabes },
      documents: out.docs.map((d) => ({ id: d.id, sha256: d.sha256, size_bytes: d.sizeBytes, media_type: d.mediaType })),
      // La extracción guardada es inmutable: se muestra con las correcciones del analista encima.
      extraction: (out.ex ? applyCorrections(out.ex.payload as NonNullable<ApplicationDetail['extraction']>, fixes) : null),
      decision: out.dec ? { id: out.dec.id, policy_version: version(out.dec.policyVersionId), created_at: out.dec.createdAt.toISOString(), payload: out.dec.payload as NonNullable<ApplicationDetail['decision']>['payload'] } : null,
      shadow: out.shadow ? { policy_version: version(out.shadow.policyVersionId), status: out.shadow.status, limit: out.shadow.limitAmount === null ? null : Number(out.shadow.limitAmount), score: out.shadow.score === null ? null : Number(out.shadow.score) } : null,
      clarifications: out.clar,
      outcomes: out.outs.map((o) => ({ outcome: o.outcome, observed_at: o.observedAt.toISOString() })),
      corrections: fixes,
    }
    res.json(detail)
  })

  /** El PDF, desde el almacenamiento propio y solo si es de este tenant (RLS + prefijo de ruta). */
  r.get('/documents/:id/file', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const [d] = await withTenant(deps.db, w.tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, id)))
    if (!d || !pathBelongsTo(d.storagePath, w.tenantId) || d.mediaType !== 'application/pdf') throw new HttpError(404, 'documento no encontrado')
    const bytes = await deps.storage.read(d.storagePath)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  })

  /** Corrección de valores en revisión humana: guarda los pares leído/correcto y reencola a decidir. */
  r.post('/applications/:id/corrections', async (req, res) => {
    const w = who(res)
    res.status(202).json(await recordCorrections(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Aclaraciones con respuesta manual
  r.get('/clarifications', async (req, res) => {
    const status = typeof req.query.status === 'string' ? ClarificationStatus.safeParse(req.query.status) : null
    const items = await withTenant(deps.db, who(res).tenantId, (tx) => clarificationItems(tx, status?.success ? sql`c.status = ${status.data}::app.clarification_status` : sql`true`))
    res.json(items)
  })

  /** Respuesta a nombre del proveedor: entra por la misma operación que la API, con el usuario en la bitácora. */
  r.post('/clarifications/:id/answers', async (req, res) => {
    const w = who(res)
    res.json(await answerClarification(deps, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), req.body))
  })

  // ---------- Políticas
  r.get('/policies/versions', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) => tx.select().from(policyVersions).orderBy(desc(policyVersions.version)))
    const list: PolicyVersionItem[] = rows.map((v) => ({ id: v.id, version: v.version, status: v.status, document: v.document, simulation: v.simulation as PolicyVersionItem['simulation'], created_at: v.createdAt.toISOString(), activated_at: iso(v.activatedAt) }))
    res.json(list)
  })

  r.post('/policies/versions', async (req, res) => {
    const w = who(res)
    const body = parse(PolicyBody, req.body)
    res.status(201).json(await createPolicyDraft(deps.db, w.tenantId, actorOf(w), body.document))
  })

  r.post('/policies/versions/:id/simulate', async (req, res) => {
    const w = who(res)
    res.json(await simulateVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id)))
  })
  r.post('/policies/versions/:id/shadow', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'shadow'))
  })
  r.post('/policies/versions/:id/activate', async (req, res) => {
    const w = who(res)
    res.json(await transitionVersion(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), 'active'))
  })

  // ---------- Outcomes y bitácora
  r.post('/outcomes', async (req, res) => {
    const w = who(res)
    await recordOutcome(deps.db, w.tenantId, actorOf(w), req.body)
    res.status(201).json({ ok: true })
  })

  r.get('/audit', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) =>
      tx.execute<{ id: string; actor: string; actor_label: string | null; action: string; subject: string | null; details: Record<string, unknown>; at: Date }>(sql`
        select l.id, l.actor, u.email as actor_label, l.action, l.subject, l.details, l.at
          from app.audit_log l left join app.tenant_users u on 'user:' || u.user_id::text = l.actor
         order by l.at desc limit 200`),
    )
    const list: AuditEntry[] = rows.rows.map((l) => ({ id: l.id, actor: l.actor, actor_label: l.actor_label, action: l.action, subject: l.subject, details: l.details, at: new Date(l.at).toISOString() }))
    res.json(list)
  })

  return r
}
