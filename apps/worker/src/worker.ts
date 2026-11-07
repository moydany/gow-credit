/**
 * The full-mode worker: consumes `application.process` and `application.resume`, runs the Mastra
 * workflow with state in Postgres (the suspended run lives in the `mastra` schema and resumes from
 * another process), stores what each run leaves and sweeps inbound messages.
 *
 * Everything external enters through `WorkerServices`: storage, models, transports and external
 * sources. Scenarios use the same pieces with doubles (only the implementations of the external
 * interfaces change).
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Transport } from '@gow/channels'
import { calendarToday, describeFailure, emptyExternalSnapshot, type ExternalSnapshot, type StatementExtraction, type SyntheticStatement } from '@gow/contracts'
import type { Db } from '@gow/db'
import { DEFAULT_OPTIONS, extractStatement } from '@gow/extraction'
import { withLlmScope, type Classifier, type Limiter, type StructuredLlm, type TransactionClassifier } from '@gow/llm'
import { CLARIFICATION_LOOP_ID, createRuntime, resumeApplication, startApplication, WORKFLOW_ID, type AppInput, type AppState, type WorkflowDeps, type Writer } from '@gow/mastra'
import { deleteApplicationJobs, DiscardNoticeJob, enqueueProcess, enqueueRedecide, enqueueResume, pathBelongsTo, ProcessJob, PurgeJob, QUEUES, RedecideJob, ResumeJob, type DocumentStorage, type PgBoss } from '@gow/platform'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { OwnerAnswer } from '@gow/contracts'
import { clarifications, withTenant } from '@gow/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { DbClarificationChannel } from './channel.ts'
import { pendingInbound, resolveInbound } from './inbound.ts'
import type { MessageInterpreter } from './interpret.ts'
import { handleDiscardNotice } from './discard-notice.ts'
import { handleRedecide } from './redecide.ts'
import { loadContext, persistOutcome, requestOf, setStatus, supplierIdentity, type AppContext } from './store.ts'

/** Classifier confidence from which full mode does not extract a document that is not a bank statement. */
export const REJECT_NOT_STATEMENT_ABOVE = 0.9

/** Synthetic bank statement stored as a document (scenarios and development only). */
export const SYNTHETIC_SUFFIX = '.synthetic.json'

export interface SyntheticDocument {
  input: z.input<typeof SyntheticStatement>
  holder: { name: string; rfc: string | null; clabe: string | null; address?: string | null }
  seed: string
}

export interface WorkerServices {
  db: Db
  mastraStore: MastraCompositeStore
  storage: DocumentStorage
  llm: StructuredLlm
  documentClassifier: Classifier
  transactionClassifier: TransactionClassifier | null
  writer: Writer
  limit: Limiter
  googleAvailable: boolean
  transports: { email?: Transport }
  /** External sources for the supplier profile (with the extractions, for counterparty UUIDs and RFCs); without them, an empty snapshot. */
  external?: (ctx: AppContext, state: AppState) => Promise<ExternalSnapshot>
  /** Builds a synthetic bank statement; only scenarios pass it. */
  synthetic?: (doc: SyntheticDocument) => StatementExtraction
  /** Demo: an unlinked WhatsApp number registers by chatting. Off by default. */
  selfRegistration?: boolean
  /** Haiku for replies the rules cannot read; without it, rules only. */
  interpreter?: MessageInterpreter
  /** "Today" for document age when the request does not set `as_of`. */
  today?: () => string
  logger: { info(message: string): void; error(message: string): void }
}

function deps(s: WorkerServices, ctx: AppContext): WorkflowDeps {
  return {
    extract: async (path) => {
      const bytes = await s.storage.read(path)
      if (path.endsWith(SYNTHETIC_SUFFIX)) {
        if (!s.synthetic) throw new Error('documento sintético fuera de un escenario')
        return s.synthetic(JSON.parse(bytes.toString('utf8')) as SyntheticDocument)
      }
      // extractStatement reads from disk: temporary copy with the original name (it goes in document.file_name).
      const dir = await mkdtemp(join(tmpdir(), 'gow-doc-'))
      const file = join(dir, basename(path))
      await writeFile(file, bytes)
      // Full mode: a document that is surely not a bank statement, or that holds more than one, is not extracted.
      return extractStatement(file, { llm: s.llm, classifier: s.documentClassifier }, { ...DEFAULT_OPTIONS, googleAvailable: s.googleAvailable, limit: s.limit, rejectNotStatementAbove: REJECT_NOT_STATEMENT_ABOVE })
    },
    transactionClassifier: s.transactionClassifier,
    writer: s.writer,
    channel: new DbClarificationChannel(s.db, ctx, { email: s.transports.email ?? null }),
    limit: s.limit,
    external: (state) => (s.external ? s.external(ctx, state) : Promise.resolve(emptyExternalSnapshot())),
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error').slice(0, 200) : 'error'
}

export async function handleProcess(s: WorkerServices, job: ProcessJob): Promise<string> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  if (ctx.application.runId !== null && ctx.application.status !== 'failed') return ctx.application.status
  if (!ctx.active) {
    await setStatus(s.db, job.tenant_id, job.application_id, 'failed', 'el tenant no tiene una política activa')
    return 'failed'
  }
  // Sent together (ADR 0072): the first one opened the request, the rest are the other months.
  const [doc, ...extra] = ctx.submitted.length > 0 ? ctx.submitted : ctx.documents
  if (!doc) {
    await setStatus(s.db, job.tenant_id, job.application_id, 'failed', 'la solicitud no tiene documento')
    return 'failed'
  }
  await setStatus(s.db, job.tenant_id, job.application_id, 'extracting')
  s.logger.info(`application ${ctx.application.id} → extracting (extracción, perfil y política)`)
  const input: AppInput = {
    application_id: ctx.application.id,
    pdf_path: doc.storagePath,
    extra_pdf_paths: extra.map((d) => d.storagePath),
    as_of: ctx.application.asOf ?? (s.today ? s.today() : calendarToday()),
    request: requestOf(ctx),
    supplier: supplierIdentity(ctx.supplier),
    policy: ctx.active.policy,
    policy_id: ctx.active.id,
    statement_age: ctx.statementAge,
  }
  const outcome = await startApplication(createRuntime(deps(s, ctx), s.mastraStore), input)
  const status = await persistOutcome(s.db, ctx, outcome)
  s.logger.info(`application ${ctx.application.id} → ${status}${failureSuffix(status, outcome.state?.failure_reason ?? outcome.error ?? null)}`)
  return status
}

/** ` (not a bank statement: credit_card_statement)`: the reason type, never document data. */
function failureSuffix(status: string, reason: string | null): string {
  if (status !== 'failed') return ''
  const f = describeFailure(reason)
  return `: ${f.kind}${f.documentType ? ` (${f.documentType})` : ''}`
}

export async function handleResume(s: WorkerServices, job: ResumeJob): Promise<string> {
  const ctx = await loadContext(s.db, job.tenant_id, job.application_id)
  const { runId, suspendedStep } = ctx.application
  if (runId === null || suspendedStep === null) return ctx.application.status
  const [clar] = await withTenant(s.db, job.tenant_id, (tx) => tx.select().from(clarifications).where(eq(clarifications.id, job.clarification_id)))
  // The clarification must belong to this request and tenant (RLS already filtered the tenant).
  if (clar?.applicationId !== ctx.application.id || clar.status !== 'answered') return ctx.application.status
  const answers = z.array(OwnerAnswer).parse(clar.answers)
  const outcome = await resumeApplication(createRuntime(deps(s, ctx), s.mastraStore), runId, z.array(z.string()).parse(suspendedStep), { answers, base_dir: null })
  const status = await persistOutcome(s.db, ctx, outcome)
  s.logger.info(`application ${ctx.application.id} reanudada → ${status}${failureSuffix(status, outcome.state?.failure_reason ?? outcome.error ?? null)}`)
  return status
}

/** Processes pending inbound messages; those that complete a clarification enqueue the resume. */
export async function sweepInbound(s: WorkerServices, boss: PgBoss): Promise<number> {
  const pending = await pendingInbound(s.db)
  for (const m of pending) {
    // Whatever Haiku reads from this message is attributed to it.
    const r = await withLlmScope({ tenantId: m.tenant_id, inboundMessageId: m.id }, () =>
      resolveInbound(s.db, m.tenant_id, m.id, { storage: s.storage, selfRegistration: s.selfRegistration === true, ...(s.today ? { today: s.today } : {}), ...(s.interpreter ? { interpreter: s.interpreter } : {}) }),
    )
    s.logger.info(`entrante ${m.id} → ${r.resolution}${r.interpreted ? ' (Haiku)' : ''}`)
    if (r.resume) await enqueueResume(boss, r.resume, r.resumeDelaySeconds ?? 0)
    // Amount requested after the offer: decide again with it, without models.
    if (r.redecide) await enqueueRedecide(boss, r.redecide)
    if (r.process) {
      await enqueueProcess(boss, r.process.job, r.process.sha256, undefined, r.process.delaySeconds ?? 0)
      s.logger.info(`application ${r.process.job.application_id} recibida por un mensaje entrante`)
    }
  }
  return pending.length
}

/**
 * Cleanup of a supplier deleted from the backoffice: the database no longer has their rows; here
 * their PDFs, their requests' queue jobs and their runs' Mastra state are deleted. Everything is
 * idempotent: if pg-boss retries, what is already gone is not an error.
 */
export async function handlePurge(s: WorkerServices, boss: PgBoss, job: PurgeJob): Promise<{ files: number; runs: number; jobs: number }> {
  let files = 0
  for (const path of job.storage_paths) {
    if (!pathBelongsTo(path, job.tenant_id)) continue
    await s.storage.remove(path)
    files++
  }
  const workflows = await s.mastraStore.getStore('workflows')
  for (const runId of job.run_ids) {
    for (const workflowName of [WORKFLOW_ID, CLARIFICATION_LOOP_ID]) await workflows?.deleteWorkflowRunById({ runId, workflowName })
  }
  const jobs = await deleteApplicationJobs(boss, job.application_ids)
  return { files, runs: job.run_ids.length, jobs }
}

/** Every model call in a job is attributed to its request. */
function scopeOf(job: { tenant_id: string; application_id: string }): { tenantId: string; applicationId: string } {
  return { tenantId: job.tenant_id, applicationId: job.application_id }
}

export interface RunningWorker {
  stop(): Promise<void>
}

export async function startWorker(s: WorkerServices, boss: PgBoss, opts: { sweepMs?: number; pollingSeconds?: number } = {}): Promise<RunningWorker> {
  const polling = { pollingIntervalSeconds: opts.pollingSeconds ?? 2 }
  // A failure throws: pg-boss retries with backoff and, once exhausted, sends it to application.dead.
  await boss.work<ProcessJob>(QUEUES.process, polling, async ([job]) => {
    if (!job) return
    try {
      const data = ProcessJob.parse(job.data)
      await withLlmScope(scopeOf(data), () => handleProcess(s, data))
    } catch (err) {
      s.logger.error(`process ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  await boss.work<ResumeJob>(QUEUES.resume, polling, async ([job]) => {
    if (!job) return
    try {
      const data = ResumeJob.parse(job.data)
      await withLlmScope(scopeOf(data), () => handleResume(s, data))
    } catch (err) {
      s.logger.error(`resume ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  await boss.work<RedecideJob>(QUEUES.redecide, polling, async ([job]) => {
    if (!job) return
    try {
      const data = RedecideJob.parse(job.data)
      await withLlmScope(scopeOf(data), () => handleRedecide(s, data))
    } catch (err) {
      s.logger.error(`redecide ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  await boss.work<DiscardNoticeJob>(QUEUES.discardNotice, polling, async ([job]) => {
    if (!job) return
    try {
      const r = await handleDiscardNotice(s, DiscardNoticeJob.parse(job.data))
      s.logger.info(`application ${job.data.application_id}: aviso de descarte → ${r}`)
    } catch (err) {
      s.logger.error(`discard_notice ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  await boss.work<PurgeJob>(QUEUES.purge, polling, async ([job]) => {
    if (!job) return
    try {
      const r = await handlePurge(s, boss, PurgeJob.parse(job.data))
      s.logger.info(`proveedor ${job.data.supplier_id} borrado: ${String(r.files)} PDF, ${String(r.runs)} corridas, ${String(r.jobs)} trabajos`)
    } catch (err) {
      s.logger.error(`purge ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  let sweeping = false
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    sweepInbound(s, boss)
      .catch((err: unknown) => {
        s.logger.error(`inbound: ${errorText(err)}`)
      })
      .finally(() => {
        sweeping = false
      })
  }, opts.sweepMs ?? 2000)
  return {
    stop: async () => {
      clearInterval(timer)
      await boss.offWork(QUEUES.process)
      await boss.offWork(QUEUES.resume)
      await boss.offWork(QUEUES.redecide)
      await boss.offWork(QUEUES.discardNotice)
      await boss.offWork(QUEUES.purge)
    },
  }
}
