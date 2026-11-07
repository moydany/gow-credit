/**
 * Request timeline: `GET /bo/v1/applications/:id/timeline`. The API builds the rows that
 * `TimelineSources` from the `app` schema asks for and `buildTimeline` (packages/contracts) turns
 * them into a timeline. Nothing is stored: it is rebuilt on every request, so no "viewed" audit
 * row; the response carries ids, statuses, counts, times and costs, never content.
 *
 * Never selected (the API does not read them, so a builder bug cannot leak them):
 * - `inbound_messages`: `body`, `from_address`, `external_id`, `attachment*` (`attachment_name` only for existence).
 * - `outbound_messages`: `body` and `destination` (the database enforces it too: 0023 grants SELECT per column).
 * - `llm_exchanges`: `system`, `instruction`, `response`, `raw_output`, `error_message`.
 * - `corrections`: `read_value` and `value`; the target is reduced to `<type>.<field>`.
 * - `clarifications`: `questions` and `answers` only as counts; never `destination`.
 * - `decisions`: the full `payload` (the builder validates and drops what it does not read); no `limit_amount`.
 *
 * How each source links to the request:
 * - inbound: `clarification_id` in the request's clarifications; or an `inbound.*` audit row whose
 *   `subject` is the message id and `details.application_id` is the request; or the request's
 *   `application.received` row with `details.inbound_message_id`.
 * - audit: `subject` = request, in the clarifications, or in those messages; or
 *   `details.application_id` = request.
 * - outbound: `clarification_id` in the clarifications; or `created_at` = `at` of an `inbound.*`,
 *   `verdict.queued` or `registration.confirmation_asked` row in that audit set. Both rows are
 *   inserted in the same transaction and share `now()` (the default of both columns).
 * - exchanges: `application_id` = request or `inbound_message_id` in those messages.
 */
import { withTenant, type Tx } from '@gow/db'
import { ApplicationStatus, ApplicationTimeline, buildTimeline, CorrectionTarget, TokenUsage, type StatementExtraction, type TimelineSources } from '@gow/contracts'
import { sql, type SQL } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { HttpError, parse } from '../ops.ts'
import { who, type BackofficeDeps } from './shared.ts'

type Channel = 'whatsapp' | 'email' | 'manual'

const at = (d: Date | string): Date => new Date(d)
const atOrNull = (d: Date | string | null): Date | null => (d === null ? null : new Date(d))

/** `array[...]::<type>[]` with parameters; empty gives the empty array (`IN ()` does not exist). */
const list = (ids: readonly string[], type: 'uuid' | 'text'): SQL => (ids.length ? sql`array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::${sql.raw(type)}[]` : sql`'{}'::${sql.raw(type)}[]`)

/** `<type>.<field>` of a correction's target (e.g. `holder.rfc`, `transaction.amount`), never the value. */
function targetText(target: unknown): string {
  const t = CorrectionTarget.safeParse(target)
  return t.success ? `${t.data.kind}.${t.data.field}` : 'unknown'
}

type Sources = TimelineSources
const app_ = (applicationId: string) => sql`${applicationId}::uuid`

async function loadApplication(tx: Tx, applicationId: string): Promise<Sources['application'] | null> {
  const [a] = (
    await tx.execute<{ id: string; status: string; created_at: Date; updated_at: Date; failure_reason: string | null }>(sql`
      select id, status, created_at, updated_at, failure_reason from app.applications where id = ${app_(applicationId)}`)
  ).rows
  return a ? { id: a.id, status: ApplicationStatus.parse(a.status), createdAt: at(a.created_at), updatedAt: at(a.updated_at), failureReason: a.failure_reason } : null
}

// The request's documents with their stored extraction (the oldest, like the detail view; immutable).
async function loadDocuments(tx: Tx, applicationId: string): Promise<Sources['documents']> {
  const rows = (
    await tx.execute<{ document_id: string; origin: 'submitted' | 'owner_answer'; created_at: Date; sha256: string; extraction_id: string | null; extraction_at: Date | null; payload: unknown }>(sql`
      select d.id as document_id, ad.origin, d.created_at, d.sha256, e.id as extraction_id, e.created_at as extraction_at, e.payload
        from app.application_documents ad
        join app.documents d on d.id = ad.document_id
        left join lateral (
          select x.id, x.created_at, x.payload from app.extractions x where x.document_id = d.id order by x.created_at, x.id limit 1
        ) e on true
       where ad.application_id = ${app_(applicationId)}
       order by d.created_at, d.id`)
  ).rows
  return rows.map((d) => ({
    documentId: d.document_id,
    origin: d.origin,
    createdAt: at(d.created_at),
    sha256: d.sha256,
    extraction: d.extraction_id && d.extraction_at ? { id: d.extraction_id, createdAt: at(d.extraction_at), payload: d.payload as StatementExtraction } : null,
  }))
}

async function loadClarifications(tx: Tx, applicationId: string): Promise<Sources['clarifications']> {
  const rows = (
    await tx.execute<{ id: string; round: number; status: 'open' | 'answered' | 'expired' | 'rejected'; channel: Channel; step: string; questions: number; answers: number; created_at: Date; answered_at: Date | null }>(sql`
      select id, round, status, channel, step,
             jsonb_array_length(questions)::int as questions, jsonb_array_length(answers)::int as answers,
             created_at, answered_at
        from app.clarifications where application_id = ${app_(applicationId)} order by round, id`)
  ).rows
  return rows.map((c) => ({ id: c.id, round: c.round, status: c.status, channel: c.channel, step: c.step, questions: c.questions, answers: c.answers, createdAt: at(c.created_at), answeredAt: atOrNull(c.answered_at) }))
}

// Linked inbound messages (see the header). `hasDocument`: the `attachment` column is emptied on
// processing, so it is decided from what survives: the attachment name or a `document_*` resolution.
async function loadInbound(tx: Tx, applicationId: string, clarIds: string[]): Promise<Sources['inbound']> {
  const rows = (
    await tx.execute<{ id: string; channel: Channel; received_at: Date; processed_at: Date | null; resolution: string | null; clarification_id: string | null; has_document: boolean; media_kind: string | null }>(sql`
      select m.id, m.channel, m.received_at, m.processed_at, m.resolution, m.clarification_id,
             (m.attachment_name is not null or m.resolution like 'document\_%') as has_document, m.media_kind
        from app.inbound_messages m
       where m.clarification_id = any(${list(clarIds, 'uuid')})
          or exists (
            select 1 from app.audit_log a
             where a.subject = m.id::text and a.action like 'inbound.%' and a.details ->> 'application_id' = ${applicationId}
          )
          or exists (
            select 1 from app.audit_log a
             where a.subject = ${applicationId} and a.action = 'application.received' and a.details ->> 'inbound_message_id' = m.id::text
          )
       order by m.received_at, m.id`)
  ).rows
  return rows.map((m) => ({ id: m.id, channel: m.channel, receivedAt: at(m.received_at), processedAt: atOrNull(m.processed_at), resolution: m.resolution, clarificationId: m.clarification_id, hasDocument: m.has_document, mediaKind: m.media_kind }))
}

async function loadAudit(tx: Tx, applicationId: string, relatedIds: string[]): Promise<Sources['audit']> {
  const rows = (
    await tx.execute<{ id: string; actor: string; action: string; subject: string | null; details: Record<string, unknown> | null; at: Date }>(sql`
      select id, actor, action, subject, details, at
        from app.audit_log
       where subject = ${applicationId}
          or subject = any(${list(relatedIds, 'text')})
          or details ->> 'application_id' = ${applicationId}
       order by at, id`)
  ).rows
  return rows.map((a) => ({ id: a.id, actor: a.actor, action: a.action, subject: a.subject, details: a.details ?? {}, at: at(a.at) }))
}

// Outbound: by clarification, or created in the same transaction as one of the request's audit rows.
// Instants are compared in SQL: passing them through JavaScript truncates to milliseconds and `now()` has microseconds.
async function loadOutbound(tx: Tx, clarIds: string[], audit: Sources['audit']): Promise<Sources['outbound']> {
  const sameTxAudit = audit.filter((a) => a.action.startsWith('inbound.') || a.action === 'verdict.queued' || a.action === 'registration.confirmation_asked').map((a) => a.id)
  const rows = (
    await tx.execute<{ id: string; channel: Channel; kind: string; status: 'pending' | 'sent' | 'failed'; attempts: number; clarification_id: string | null; created_at: Date; sent_at: Date | null }>(sql`
      select id, channel, kind, status, attempts, clarification_id, created_at, sent_at
        from app.outbound_messages
       where clarification_id = any(${list(clarIds, 'uuid')})
          or created_at in (select a.at from app.audit_log a where a.id = any(${list(sameTxAudit, 'uuid')}))
       order by created_at, id`)
  ).rows
  return rows.map((o) => ({ id: o.id, channel: o.channel, kind: o.kind, status: o.status, attempts: o.attempts, clarificationId: o.clarification_id, createdAt: at(o.created_at), sentAt: atOrNull(o.sent_at) }))
}

async function loadExchanges(tx: Tx, applicationId: string, inboundIds: string[]): Promise<Sources['exchanges']> {
  const rows = (
    await tx.execute<{ id: string; application_id: string | null; inbound_message_id: string | null; purpose: string; model: string; prompt_version: string; effort: string; document_sha256: string | null; outcome: string; error_code: string | null; response_cache_hit: boolean; usage: unknown; cost_usd: string; latency_ms: number; created_at: Date }>(sql`
      select id, application_id, inbound_message_id, purpose, model, prompt_version, effort, document_sha256, outcome, error_code,
             response_cache_hit, usage, cost_usd, latency_ms, created_at
        from app.llm_exchanges
       where application_id = ${app_(applicationId)} or inbound_message_id = any(${list(inboundIds, 'uuid')})
       order by created_at, id`)
  ).rows
  return rows.map((x) => {
    const usage = TokenUsage.safeParse(x.usage)
    return {
      id: x.id,
      applicationId: x.application_id,
      inboundMessageId: x.inbound_message_id,
      purpose: x.purpose,
      model: x.model,
      promptVersion: x.prompt_version,
      effort: x.effort,
      documentSha256: x.document_sha256,
      outcome: x.outcome === 'ok' ? ('ok' as const) : ('error' as const),
      errorCode: x.error_code,
      responseCacheHit: x.response_cache_hit,
      usage: usage.success ? { input_tokens: usage.data.input_tokens, output_tokens: usage.data.output_tokens } : null,
      costUsd: Number(x.cost_usd),
      latencyMs: x.latency_ms,
      createdAt: at(x.created_at),
    }
  })
}

async function loadDecisions(tx: Tx, applicationId: string): Promise<Sources['decisions']> {
  const rows = (
    await tx.execute<{ id: string; kind: 'active' | 'shadow'; status: string; policy_version: number | null; payload: unknown; created_at: Date }>(sql`
      select d.id, d.kind, d.status, pv.version as policy_version, d.payload, d.created_at
        from app.decisions d left join app.policy_versions pv on pv.id = d.policy_version_id
       where d.application_id = ${app_(applicationId)} order by d.created_at, d.id`)
  ).rows
  return rows.map((d) => ({ id: d.id, kind: d.kind, status: d.status, policyVersion: d.policy_version, payload: d.payload, createdAt: at(d.created_at) }))
}

async function loadCorrections(tx: Tx, applicationId: string): Promise<Sources['corrections']> {
  const rows = (
    await tx.execute<{ id: string; document_id: string; target: unknown; page: number | null; created_at: Date }>(sql`
      select id, document_id, target, page, created_at from app.corrections where application_id = ${app_(applicationId)} order by created_at, id`)
  ).rows
  return rows.map((c) => ({ id: c.id, documentId: c.document_id, target: targetText(c.target), page: c.page, createdAt: at(c.created_at) }))
}

async function loadOutcomes(tx: Tx, applicationId: string): Promise<Sources['outcomes']> {
  const rows = (await tx.execute<{ id: string; created_at: Date }>(sql`select id, created_at from app.outcomes where application_id = ${app_(applicationId)} order by created_at, id`)).rows
  return rows.map((o) => ({ id: o.id, createdAt: at(o.created_at) }))
}

/**
 * The request's rows, or null if it does not exist in this tenant (RLS hides another tenant's).
 * Runs in the `withTenant` transaction: with no tenant set it returns nothing.
 */
export async function loadTimelineSources(tx: Tx, applicationId: string): Promise<TimelineSources | null> {
  const application = await loadApplication(tx, applicationId)
  if (!application) return null
  const documents = await loadDocuments(tx, applicationId)
  const clarifications = await loadClarifications(tx, applicationId)
  const clarIds = clarifications.map((c) => c.id)
  const inbound = await loadInbound(tx, applicationId, clarIds)
  const audit = await loadAudit(tx, applicationId, [...clarIds, ...inbound.map((m) => m.id)])
  const outbound = await loadOutbound(tx, clarIds, audit)
  const exchanges = await loadExchanges(tx, applicationId, inbound.map((m) => m.id))
  const decisions = await loadDecisions(tx, applicationId)
  const corrections = await loadCorrections(tx, applicationId)
  const outcomes = await loadOutcomes(tx, applicationId)
  return { application, documents, inbound, outbound, audit, exchanges, decisions, clarifications, corrections, outcomes }
}

export function timelineRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()

  r.get('/applications/:id/timeline', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const sources = await withTenant(deps.db, w.tenantId, (tx) => loadTimelineSources(tx, id))
    if (!sources) throw new HttpError(404, 'solicitud no encontrada')
    res.json(ApplicationTimeline.parse(buildTimeline(sources)))
  })

  return r
}
