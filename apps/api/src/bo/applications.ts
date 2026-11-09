import {
  ApplicationStatus,
  ClarificationStatus,
  CorrectionTarget,
  type ApplicationDetail,
  type ApplicationRow,
  type ClarificationItem,
  type Correction,
  type Decision,
} from '@gow/contracts'
import {
  applicationDocuments,
  applications,
  decisions,
  documents,
  extractions,
  outcomes,
  policyVersions,
  suppliers,
  withTenant,
  type Db,
} from '@gow/db'
import {
  and,
  desc,
  eq,
  inArray,
  sql,
} from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { answerClarification, audit, discardDocument, HttpError, parse, recordCorrections } from '../ops.ts'
import { pathBelongsTo } from '@gow/platform'
import { detailStatements } from './detail-statements.ts'
import {
  PENDING_SUPPLIER_NAME,
  SUPPLIER_NOT_FOUND,
  actorOf,
  iso,
  who,
  type BackofficeDeps,
} from './shared.ts'

export async function clarificationItems(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  where: ReturnType<typeof sql>,
): Promise<ClarificationItem[]> {
  const rows = await tx.execute<{
    id: string
    application_id: string
    legal_name: string
    round: number
    status: ClarificationItem['status']
    channel: ClarificationItem['channel']
    questions: ClarificationItem['questions']
    answers: ClarificationItem['answers']
    created_at: Date
    answered_at: Date | null
    answered_by: string | null
  }>(sql`
    select c.id, c.application_id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name, c.round, c.status, c.channel, c.questions, c.answers, c.created_at, c.answered_at,
           (select u.email from app.audit_log l join app.tenant_users u on 'user:' || u.user_id::text = l.actor
             where l.subject = c.id::text and l.action = 'clarification.answered' order by l.at desc limit 1) as answered_by
      from app.clarifications c join app.suppliers s on s.id = c.supplier_id
     where ${where}
     order by c.created_at desc`)
  return rows.rows.map((c) => ({
    id: c.id,
    application_id: c.application_id,
    supplier_name: c.legal_name,
    round: c.round,
    status: c.status,
    channel: c.channel,
    questions: c.questions,
    answers: c.answers,
    created_at: new Date(c.created_at).toISOString(),
    answered_at: iso(c.answered_at),
    answered_by: c.answered_by,
  }))
}

async function fetchApplicationsList(
  db: Db,
  tenantId: string,
  statuses: ApplicationStatus[] | null,
): Promise<ApplicationRow[]> {
  const rows = await withTenant(db, tenantId, async (tx) => {
    const out = await tx.execute<{
      id: string
      status: ApplicationRow['status']
      failure_reason: string | null
      request: ApplicationRow['request']
      created_at: Date
      updated_at: Date
      supplier_id: string
      legal_name: string
      decision_status: NonNullable<ApplicationRow['decision']>['status'] | null
      limit_amount: string | null
      score: string | null
      policy_version: number | null
      reasons: { code: string; message: string }[] | null
      file_name: string | null
      bank: string | null
      page_count: number | null
      issues: number | null
      flags: string[] | null
      has_extraction: boolean
      open_clarifications: number
      outcome: ApplicationRow['outcome']
    }>(sql`
      select a.id, a.status, a.failure_reason, a.request, a.created_at, a.updated_at,
             s.id as supplier_id, coalesce(s.legal_name, ${PENDING_SUPPLIER_NAME}) as legal_name,
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
  return rows.map((x) => ({
    id: x.id,
    status: x.status,
    failure_reason: x.failure_reason,
    supplier: { id: x.supplier_id, legal_name: x.legal_name },
    request: x.request,
    decision: x.decision_status
      ? {
          status: x.decision_status,
          limit: x.limit_amount === null ? null : Number(x.limit_amount),
          score: x.score === null ? null : Number(x.score),
          policy_version: x.policy_version,
          reasons: (x.reasons ?? []).map((r) => ({ code: r.code, message: r.message })),
        }
      : null,
    document: x.has_extraction
      ? {
          file_name: x.file_name,
          bank: x.bank,
          page_count: x.page_count,
          issues: x.issues ?? 0,
          flags: x.flags ?? [],
        }
      : null,
    open_clarifications: x.open_clarifications,
    outcome: x.outcome,
    created_at: new Date(x.created_at).toISOString(),
    updated_at: new Date(x.updated_at).toISOString(),
  }))
}

async function fetchApplicationDetail(
  db: Db,
  tenantId: string,
  actorName: string,
  id: string,
): Promise<ApplicationDetail> {
  const out = await withTenant(db, tenantId, async (tx) => {
    const [a] = await tx.select().from(applications).where(eq(applications.id, id))
    if (!a) throw new HttpError(404, 'solicitud no encontrada')
    const [s] = await tx.select().from(suppliers).where(eq(suppliers.id, a.supplierId))
    if (!s) throw new HttpError(404, SUPPLIER_NOT_FOUND)
    const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, id))
    const docs = links.length ? await tx.select().from(documents).where(inArray(documents.id, links.map((l) => l.documentId))) : []
    const exs = docs.length ? await tx.select().from(extractions).where(inArray(extractions.documentId, docs.map((d) => d.id))).orderBy(extractions.createdAt) : []
    const [dec] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1)
    const [shadow] = await tx.select().from(decisions).where(and(eq(decisions.applicationId, id), eq(decisions.kind, 'shadow'))).orderBy(desc(decisions.createdAt)).limit(1)
    const versionIds = [dec?.policyVersionId, shadow?.policyVersionId].filter((v): v is string => !!v)
    const versions = versionIds.length ? await tx.select({ id: policyVersions.id, version: policyVersions.version }).from(policyVersions).where(inArray(policyVersions.id, versionIds)) : []
    const clar = await clarificationItems(tx, sql`c.application_id = ${id}::uuid`)
    const outs = await tx.select().from(outcomes).where(eq(outcomes.applicationId, id)).orderBy(desc(outcomes.observedAt))
    const fixes = await tx.execute<{ id: string; document_id: string; target: unknown; read_value: string | number | null; value: string | number; page: number | null; created_by: string | null; created_at: Date }>(sql`
      select c.id, c.document_id, c.target, c.read_value, c.value, c.page, u.email as created_by, c.created_at
        from app.corrections c left join app.tenant_users u on u.user_id = c.created_by
       where c.application_id = ${id}::uuid order by c.created_at`)
    await audit(tx, tenantId, actorName, 'application.viewed', id)
    return { a, s, docs, links, exs, dec, shadow, versions, clar, outs, fixes: fixes.rows }
  })
  const fixes: Correction[] = out.fixes.map((c) => ({
    id: c.id,
    document_id: c.document_id,
    target: CorrectionTarget.parse(c.target),
    read_value: c.read_value,
    value: c.value,
    page: c.page,
    created_by: c.created_by,
    created_at: new Date(c.created_at).toISOString(),
  }))
  const version = (vid: string | null | undefined) => out.versions.find((v) => v.id === vid)?.version ?? null
  const statements = detailStatements(out.docs, out.links, out.exs, fixes, out.dec?.payload as Decision | undefined)
  return {
    id: out.a.id,
    status: out.a.status,
    failure_reason: out.a.failureReason,
    request: out.a.request as ApplicationDetail['request'],
    as_of: out.a.asOf,
    created_at: out.a.createdAt.toISOString(),
    updated_at: out.a.updatedAt.toISOString(),
    supplier: { id: out.s.id, legal_name: out.s.legalName ?? PENDING_SUPPLIER_NAME, rfc: out.s.rfc, external_ref: out.s.externalRef, clabes: out.s.clabes },
    documents: out.docs.map((d) => ({ id: d.id, sha256: d.sha256, size_bytes: d.sizeBytes, media_type: d.mediaType })),
    extraction: statements.list.at(-1)?.extraction ?? null,
    statements: statements.list,
    evaluation: statements.evaluation,
    decision: out.dec ? { id: out.dec.id, policy_version: version(out.dec.policyVersionId), created_at: out.dec.createdAt.toISOString(), payload: out.dec.payload as NonNullable<ApplicationDetail['decision']>['payload'] } : null,
    shadow: out.shadow ? { policy_version: version(out.shadow.policyVersionId), status: out.shadow.status, limit: out.shadow.limitAmount === null ? null : Number(out.shadow.limitAmount), score: out.shadow.score === null ? null : Number(out.shadow.score) } : null,
    clarifications: out.clar,
    outcomes: out.outs.map((o) => ({ outcome: o.outcome, observed_at: o.observedAt.toISOString() })),
    corrections: fixes,
  }
}

export function applicationsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()

  r.get('/applications', async (req, res) => {
    const statuses =
      typeof req.query.status === 'string' && req.query.status
        ? z.array(ApplicationStatus).parse(req.query.status.split(','))
        : null
    res.json(await fetchApplicationsList(deps.db, who(res).tenantId, statuses))
  })

  r.get('/applications/:id', async (req, res) => {
    const w = who(res)
    res.json(await fetchApplicationDetail(deps.db, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id)))
  })

  r.get('/documents/:id/file', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const [d] = await withTenant(deps.db, w.tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, id)))
    if (!d || !pathBelongsTo(d.storagePath, w.tenantId) || d.mediaType !== 'application/pdf') {
      throw new HttpError(404, 'documento no encontrado')
    }
    const bytes = await deps.storage.read(d.storagePath)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="documento.pdf"')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  })

  r.post('/applications/:id/corrections', async (req, res) => {
    const w = who(res)
    res.status(202).json(await recordCorrections(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  r.post('/applications/:id/discard', async (req, res) => {
    const w = who(res)
    res.json(await discardDocument(deps, w.tenantId, w.userId, parse(z.uuid(), req.params.id), req.body))
  })

  r.get('/clarifications', async (req, res) => {
    const status = typeof req.query.status === 'string' ? ClarificationStatus.safeParse(req.query.status) : null
    const items = await withTenant(deps.db, who(res).tenantId, (tx) =>
      clarificationItems(tx, status?.success ? sql`c.status = ${status.data}::app.clarification_status` : sql`true`),
    )
    res.json(items)
  })

  r.post('/clarifications/:id/answers', async (req, res) => {
    const w = who(res)
    res.json(await answerClarification(deps, w.tenantId, actorOf(w), parse(z.uuid(), req.params.id), req.body))
  })

  return r
}
