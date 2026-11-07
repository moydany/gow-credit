/**
 * Queue jobs: the "Trabajos" tab of the audit log. Read through pg-boss itself (`findJobs`, with the
 * API's queue connection), filtering by the `tenant_id` every job payload carries, so no grant on
 * the `pgboss` schema is needed. Only ids and the error message leave here: never the payload
 * (a purge carries storage paths) nor the stack.
 */
import { JobListQuery, type JobItem, type JobState } from '@gow/contracts'
import { QUEUES } from '@gow/platform'
import express from 'express'
import { z } from 'zod'
import { parse } from '../ops.ts'
import { who, type BackofficeDeps } from './shared.ts'

const LIST_LIMIT = 200
/** Per queue, oldest first (pg-boss order); jobs are deleted after their retention anyway. */
const SCAN_LIMIT = 2000
const ERROR_CHARS = 300
const RUNNING: readonly JobState[] = ['created', 'retry', 'active']
const FAILED: readonly JobState[] = ['failed', 'cancelled']

const Payload = z.object({ application_id: z.uuid().optional(), supplier_id: z.uuid().optional() })
const ErrorOutput = z.object({ message: z.string() })

interface FoundJob {
  id: string
  name: string
  state: JobState
  data: unknown
  retryCount: number
  retryLimit: number
  createdOn: Date
  startedOn: Date | null
  completedOn: Date | null
  output: unknown
  sourceName?: string | null
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/** The error of the last attempt: pg-boss stores `{ message, stack }` in `output`; only the message, trimmed. */
function errorOf(job: FoundJob): string | null {
  if (job.state !== 'failed' && job.state !== 'retry' && job.state !== 'cancelled') return null
  const out = ErrorOutput.safeParse(job.output)
  if (!out.success) return null
  const text = out.data.message.replace(/\s+/g, ' ').trim()
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text
}

export function itemOf(job: FoundJob): JobItem {
  const data = Payload.safeParse(job.data)
  const started = job.startedOn !== null && job.state !== 'created'
  return {
    id: job.id,
    queue: job.name,
    state: job.state,
    attempts: job.retryCount + (started ? 1 : 0),
    max_attempts: job.retryLimit + 1,
    application_id: data.success ? (data.data.application_id ?? null) : null,
    supplier_id: data.success ? (data.data.supplier_id ?? null) : null,
    created_at: new Date(job.createdOn).toISOString(),
    started_at: started ? iso(job.startedOn) : null,
    completed_at: iso(job.completedOn),
    error: errorOf(job),
    dead_letter_from: job.sourceName ?? null,
  }
}

export function jobsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  r.get('/jobs', async (req, res) => {
    const q = parse(JobListQuery, req.query)
    const { tenantId } = who(res)
    const filter = { tenant_id: tenantId, ...(q.application_id ? { application_id: q.application_id } : {}) }
    const found: FoundJob[] = []
    for (const queue of Object.values(QUEUES)) {
      // A queue that does not exist yet (nothing was ever created) is just empty; anything else is an error.
      const jobs = await deps.boss.findJobs<unknown>(queue, { data: filter, limit: SCAN_LIMIT }).catch((e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === 'PGBOSS_QUEUE_NOT_FOUND') return []
        throw e
      })
      found.push(...(jobs as unknown as FoundJob[]))
    }
    const wanted = q.state === 'failed' ? FAILED : q.state === 'running' ? RUNNING : null
    const list = found
      .filter((j) => !wanted || wanted.includes(j.state))
      .sort((a, b) => new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime())
      .slice(0, LIST_LIMIT)
      .map(itemOf)
    res.json(list)
  })
  return r
}
