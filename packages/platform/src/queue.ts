/**
 * Full-mode queue: pg-boss in its own schema and role. The API enqueues and the worker consumes;
 * nobody waits on a suspended workflow.
 *
 * - `application.process`: a new document. `singletonKey` = tenant + sha256 + prompt version: the
 *   same PDF uploaded twice does not create two jobs.
 * - `application.resume`: an answered clarification. High priority: the supplier is waiting.
 * - `application.discard_notice`: tells the supplier an analyst discarded their document. The API
 *   cannot write the outbox (that belongs to the worker's role), so it enqueues and the worker writes.
 * - `supplier.purge`: cleanup outside the database for a supplier deleted from the backoffice.
 * - Retries with exponential backoff and, once exhausted, `application.dead` (dead letter).
 */
import { PgBoss } from 'pg-boss'
import { z } from 'zod'

export const QUEUES = {
  process: 'application.process',
  resume: 'application.resume',
  redecide: 'application.redecide',
  discardNotice: 'application.discard_notice',
  purge: 'supplier.purge',
  dead: 'application.dead',
} as const

export const PRIORITY = { redecide: 10, resume: 10, discardNotice: 10, process: 0, bulk: -10 } as const

/** Extraction prompt version in the idempotency key (changing prompts reprocesses). */
export const PROMPTS_VERSION = 'extract_summary.v2+extract_transactions.v2'

export const ProcessJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid() })
export type ProcessJob = z.infer<typeof ProcessJob>
export const ResumeJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid(), clarification_id: z.uuid() })
export type ResumeJob = z.infer<typeof ResumeJob>

/** An analyst corrected values in human review: re-evaluate with them. */
export const RedecideJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid(), correction_batch: z.uuid() })
export type RedecideJob = z.infer<typeof RedecideJob>

/** An analyst discarded the document in human review: tell the supplier why (the reason is read from the request). */
export const DiscardNoticeJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid() })
export type DiscardNoticeJob = z.infer<typeof DiscardNoticeJob>

/**
 * A supplier deleted from the backoffice: the database no longer has its rows; what remains is its
 * PDFs, the queue jobs of its requests and the Mastra state of its runs. Ids and paths only.
 */
export const PurgeJob = z.strictObject({
  tenant_id: z.uuid(),
  supplier_id: z.uuid(),
  application_ids: z.array(z.uuid()),
  run_ids: z.array(z.string().min(1)),
  storage_paths: z.array(z.string().min(1)),
})
export type PurgeJob = z.infer<typeof PurgeJob>

const RETRY = { retryLimit: 3, retryDelay: 5, retryBackoff: true, expireInSeconds: 900 } as const

export interface QueueLogger {
  error(message: string): void
}

export async function startQueue(connectionString: string, logger: QueueLogger, opts: { supervise?: boolean } = {}): Promise<PgBoss> {
  // The migration (0001_rls.sql) creates the schema with its owner: the queue role does not create schemas.
  const boss = new PgBoss({ connectionString, schema: 'pgboss', createSchema: false, supervise: opts.supervise ?? true, schedule: false })
  // Not the raw error: it may carry the job payload. Only the code.
  boss.on('error', (err: unknown) => {
    logger.error(`pg-boss: ${err instanceof Error ? err.name : 'error'}`)
  })
  await boss.start()
  if (!(await boss.getQueue(QUEUES.dead))) await boss.createQueue(QUEUES.dead, { retryLimit: 0 })
  for (const name of [QUEUES.process, QUEUES.resume, QUEUES.redecide, QUEUES.discardNotice, QUEUES.purge]) {
    // `exclusive` with singletonKey: at most one queued or active job per key (in `standard`
     // the key does not deduplicate).
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { ...RETRY, policy: 'exclusive', deadLetter: QUEUES.dead })
  }
  return boss
}

export function processKey(tenantId: string, sha256: string): string {
  return `${tenantId}:${sha256}:${PROMPTS_VERSION}`
}

/** `startAfterSeconds`: the job waits, so PDFs sent together can join the request first (ADR 0072). */
export async function enqueueProcess(boss: PgBoss, job: ProcessJob, sha256: string, priority: number = PRIORITY.process, startAfterSeconds = 0): Promise<string | null> {
  return boss.send(QUEUES.process, ProcessJob.parse(job), { singletonKey: processKey(job.tenant_id, sha256), priority, ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}) })
}

/** `startAfterSeconds`: the resume waits for the other PDFs of the same send (ADR 0072). */
export async function enqueueResume(boss: PgBoss, job: ResumeJob, startAfterSeconds = 0): Promise<string | null> {
  return boss.send(QUEUES.resume, ResumeJob.parse(job), { singletonKey: job.clarification_id, priority: PRIORITY.resume, ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}) })
}

export async function enqueueRedecide(boss: PgBoss, job: RedecideJob): Promise<string | null> {
  return boss.send(QUEUES.redecide, RedecideJob.parse(job), { singletonKey: job.correction_batch, priority: PRIORITY.redecide })
}

export async function enqueueDiscardNotice(boss: PgBoss, job: DiscardNoticeJob): Promise<string | null> {
  return boss.send(QUEUES.discardNotice, DiscardNoticeJob.parse(job), { singletonKey: job.application_id, priority: PRIORITY.discardNotice })
}

export async function enqueuePurge(boss: PgBoss, job: PurgeJob): Promise<string | null> {
  return boss.send(QUEUES.purge, PurgeJob.parse(job), { singletonKey: job.supplier_id, priority: PRIORITY.process })
}

/** Queue jobs of these requests, in any state: deleted when the supplier is deleted. */
export async function deleteApplicationJobs(boss: PgBoss, applicationIds: readonly string[]): Promise<number> {
  if (applicationIds.length === 0) return 0
  const queues = [QUEUES.process, QUEUES.resume, QUEUES.redecide, QUEUES.discardNotice, QUEUES.dead] as const
  const results = await Promise.all(
    queues.map(async (name) => {
      const nested = await Promise.all(
        applicationIds.map((application_id) => boss.findJobs<object>(name, { data: { application_id } })),
      )
      const ids = nested.flat().map((j) => j.id)
      if (ids.length > 0) {
        await boss.deleteJob(name, ids)
      }
      return ids.length
    }),
  )
  return results.reduce((acc, count) => acc + count, 0)
}

export type { PgBoss }
