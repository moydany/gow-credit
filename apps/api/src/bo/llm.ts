/**
 * Model exchanges: the "model calls" tab of the audit log. The list carries no content; the detail
 * returns the prompt and response as they were, and viewing it is audit-logged like opening a
 * request.
 */
import { llmExchanges, withTenant } from '@gow/db'
import { LlmExchangeListQuery, TokenUsage, type LlmExchangeDetail, type LlmExchangeRow } from '@gow/contracts'
import { and, desc, eq, type SQL } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, who, type BackofficeDeps } from './shared.ts'

const LIST_LIMIT = 300

type Row = typeof llmExchanges.$inferSelect

function rowOf(r: Pick<Row, 'id' | 'applicationId' | 'inboundMessageId' | 'purpose' | 'model' | 'schemaName' | 'promptVersion' | 'effort' | 'outcome' | 'errorCode' | 'finishReason' | 'responseCacheHit' | 'usage' | 'costUsd' | 'latencyMs' | 'createdAt'>): LlmExchangeRow {
  const usage = TokenUsage.safeParse(r.usage)
  return {
    id: r.id,
    application_id: r.applicationId,
    inbound_message_id: r.inboundMessageId,
    purpose: r.purpose,
    model: r.model,
    schema_name: r.schemaName,
    prompt_version: r.promptVersion,
    effort: r.effort,
    outcome: r.outcome === 'ok' ? 'ok' : 'error',
    error_code: r.errorCode,
    finish_reason: r.finishReason,
    response_cache_hit: r.responseCacheHit,
    usage: usage.success ? usage.data : null,
    cost_usd: Number(r.costUsd),
    latency_ms: r.latencyMs,
    at: r.createdAt.toISOString(),
  }
}

export function llmRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()

  r.get('/llm-exchanges', async (req, res) => {
    const w = who(res)
    const q = parse(LlmExchangeListQuery, { ...(typeof req.query.application_id === 'string' ? { application_id: req.query.application_id } : {}), ...(typeof req.query.outcome === 'string' ? { outcome: req.query.outcome } : {}) })
    const where: SQL[] = []
    if (q.application_id) where.push(eq(llmExchanges.applicationId, q.application_id))
    if (q.outcome) where.push(eq(llmExchanges.outcome, q.outcome))
    const rows = await withTenant(deps.db, w.tenantId, (tx) =>
      tx
        .select({
          id: llmExchanges.id,
          applicationId: llmExchanges.applicationId,
          inboundMessageId: llmExchanges.inboundMessageId,
          purpose: llmExchanges.purpose,
          model: llmExchanges.model,
          schemaName: llmExchanges.schemaName,
          promptVersion: llmExchanges.promptVersion,
          effort: llmExchanges.effort,
          outcome: llmExchanges.outcome,
          errorCode: llmExchanges.errorCode,
          finishReason: llmExchanges.finishReason,
          responseCacheHit: llmExchanges.responseCacheHit,
          usage: llmExchanges.usage,
          costUsd: llmExchanges.costUsd,
          latencyMs: llmExchanges.latencyMs,
          createdAt: llmExchanges.createdAt,
        })
        .from(llmExchanges)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(llmExchanges.createdAt))
        .limit(LIST_LIMIT),
    )
    res.json(rows.map(rowOf))
  })

  r.get('/llm-exchanges/:id', async (req, res) => {
    const w = who(res)
    const id = parse(z.uuid(), req.params.id)
    const detail = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [x] = await tx.select().from(llmExchanges).where(eq(llmExchanges.id, id))
      if (!x) return null
      // Viewing the prompt and response means viewing document data: it is audit-logged (without content).
      await audit(tx, w.tenantId, actorOf(w), 'llm_exchange.viewed', id, x.applicationId ? { application_id: x.applicationId } : {})
      const out: LlmExchangeDetail = {
        ...rowOf(x),
        system: x.system,
        instruction: x.instruction,
        document_sha256: x.documentSha256,
        max_output_tokens: x.maxOutputTokens,
        server_fallback: x.serverFallback,
        response: x.response,
        raw_output: x.rawOutput,
        error_message: x.errorMessage,
      }
      return out
    })
    if (!detail) throw new HttpError(404, 'intercambio no encontrado')
    res.json(detail)
  })

  return r
}
