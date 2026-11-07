/**
 * El worker del modo full (docs/02 §4): consume `application.process` y `application.resume`, corre
 * el workflow de Mastra con estado en Postgres (el run suspendido vive en el esquema `mastra` y se
 * reanuda desde otro proceso), guarda lo que deja cada corrida y barre los mensajes entrantes.
 *
 * Todo lo externo entra por `WorkerServices`: almacenamiento, modelos, transportes y fuentes
 * externas. Los escenarios usan las mismas piezas con dobles (docs/06: "solo cambian las
 * implementaciones de las interfaces externas").
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
import { deleteApplicationJobs, enqueueProcess, enqueueRedecide, enqueueResume, pathBelongsTo, ProcessJob, PurgeJob, QUEUES, RedecideJob, ResumeJob, type DocumentStorage, type PgBoss } from '@gow/platform'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { OwnerAnswer } from '@gow/contracts'
import { clarifications, withTenant } from '@gow/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { DbClarificationChannel } from './channel.ts'
import { pendingInbound, resolveInbound } from './inbound.ts'
import type { MessageInterpreter } from './interpret.ts'
import { handleRedecide } from './redecide.ts'
import { loadContext, persistOutcome, requestOf, setStatus, supplierIdentity, type AppContext } from './store.ts'

/** Confianza del clasificador desde la que el modo full no extrae un documento que no es estado de cuenta (ADR 0002). */
export const REJECT_NOT_STATEMENT_ABOVE = 0.9

/** Estado de cuenta sintético guardado como documento (solo escenarios y desarrollo). */
export const SYNTHETIC_SUFFIX = '.synthetic.json'

export interface SyntheticDocument {
  input: z.input<typeof SyntheticStatement>
  holder: { name: string; rfc: string | null; clabe: string | null }
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
  /** Fuentes externas del perfil por proveedor (con las extracciones, para los UUID y RFC de contraparte); sin ellas, snapshot vacío. */
  external?: (ctx: AppContext, state: AppState) => Promise<ExternalSnapshot>
  /** Construye un estado de cuenta sintético; solo los escenarios lo pasan. */
  synthetic?: (doc: SyntheticDocument) => StatementExtraction
  /** Demo (ADR 0038): un número de WhatsApp sin vínculo se registra conversando. Apagado por defecto. */
  selfRegistration?: boolean
  /** Haiku para respuestas que las reglas no leen (ADR 0040); sin él, solo reglas. */
  interpreter?: MessageInterpreter
  /** "Hoy" para la antigüedad del documento cuando la solicitud no fija `as_of`. */
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
      // extractStatement lee de disco: copia temporal con el nombre original (va en document.file_name).
      const dir = await mkdtemp(join(tmpdir(), 'gow-doc-'))
      const file = join(dir, basename(path))
      await writeFile(file, bytes)
      // Modo full: un documento que con seguridad no es estado de cuenta, o que trae más de uno, no se extrae (ADR 0002, 0042 y 0057).
      return extractStatement(file, { llm: s.llm, classifier: s.documentClassifier }, { ...DEFAULT_OPTIONS, googleAvailable: s.googleAvailable, limit: s.limit, rejectNotStatementAbove: REJECT_NOT_STATEMENT_ABOVE, rejectMultipleStatements: true })
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
  const doc = ctx.documents[0]
  if (!doc) {
    await setStatus(s.db, job.tenant_id, job.application_id, 'failed', 'la solicitud no tiene documento')
    return 'failed'
  }
  await setStatus(s.db, job.tenant_id, job.application_id, 'extracting')
  s.logger.info(`application ${ctx.application.id} → extracting (extracción, perfil y política)`)
  const input: AppInput = {
    application_id: ctx.application.id,
    pdf_path: doc.storagePath,
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

/** ` (no es estado de cuenta: credit_card_statement)`: el tipo de motivo, nunca datos del documento (ADR 0041). */
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
  // La aclaración tiene que ser de esta solicitud y de este tenant (RLS ya filtró el tenant).
  if (clar?.applicationId !== ctx.application.id || clar.status !== 'answered') return ctx.application.status
  const answers = z.array(OwnerAnswer).parse(clar.answers)
  const outcome = await resumeApplication(createRuntime(deps(s, ctx), s.mastraStore), runId, z.array(z.string()).parse(suspendedStep), { answers, base_dir: null })
  const status = await persistOutcome(s.db, ctx, outcome)
  s.logger.info(`application ${ctx.application.id} reanudada → ${status}${failureSuffix(status, outcome.state?.failure_reason ?? outcome.error ?? null)}`)
  return status
}

/** Procesa los entrantes pendientes; los que completan una aclaración encolan la reanudación. */
export async function sweepInbound(s: WorkerServices, boss: PgBoss): Promise<number> {
  const pending = await pendingInbound(s.db)
  for (const m of pending) {
    // Lo que lea Haiku de este mensaje queda atribuido a él (ADR 0064).
    const r = await withLlmScope({ tenantId: m.tenant_id, inboundMessageId: m.id }, () =>
      resolveInbound(s.db, m.tenant_id, m.id, { storage: s.storage, selfRegistration: s.selfRegistration === true, ...(s.today ? { today: s.today } : {}), ...(s.interpreter ? { interpreter: s.interpreter } : {}) }),
    )
    s.logger.info(`entrante ${m.id} → ${r.resolution}${r.interpreted ? ' (Haiku)' : ''}`)
    if (r.resume) await enqueueResume(boss, r.resume)
    // Monto pedido después de la oferta (ADR 0053): se decide de nuevo con él, sin modelos.
    if (r.redecide) await enqueueRedecide(boss, r.redecide)
    if (r.process) {
      await enqueueProcess(boss, r.process.job, r.process.sha256)
      s.logger.info(`application ${r.process.job.application_id} recibida por un mensaje entrante`)
    }
  }
  return pending.length
}

/**
 * Limpieza de un proveedor borrado desde el backoffice (ADR 0059): la base ya no tiene sus filas; aquí
 * se borran sus PDFs, los trabajos de la cola de sus solicitudes y el estado de Mastra de sus corridas.
 * Todo es idempotente: si pg-boss reintenta, lo que ya no está no es error.
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

/** Cada llamada al modelo de un trabajo queda atribuida a su solicitud (ADR 0064). */
function scopeOf(job: { tenant_id: string; application_id: string }): { tenantId: string; applicationId: string } {
  return { tenantId: job.tenant_id, applicationId: job.application_id }
}

export interface RunningWorker {
  stop(): Promise<void>
}

export async function startWorker(s: WorkerServices, boss: PgBoss, opts: { sweepMs?: number; pollingSeconds?: number } = {}): Promise<RunningWorker> {
  const polling = { pollingIntervalSeconds: opts.pollingSeconds ?? 2 }
  // Un fallo lanza: pg-boss reintenta con backoff y, agotado, lo manda a application.dead.
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
      await boss.offWork(QUEUES.purge)
    },
  }
}
