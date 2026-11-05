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
import { emptyExternalSnapshot, type ExternalSnapshot, type StatementExtraction, type SyntheticStatement } from '@gow/contracts'
import type { Db } from '@gow/db'
import { DEFAULT_OPTIONS, extractStatement } from '@gow/extraction'
import type { Classifier, Limiter, StructuredLlm, TransactionClassifier } from '@gow/llm'
import { createRuntime, resumeApplication, startApplication, type AppInput, type AppState, type WorkflowDeps, type Writer } from '@gow/mastra'
import { enqueueResume, ProcessJob, QUEUES, ResumeJob, type DocumentStorage, type PgBoss } from '@gow/platform'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { OwnerAnswer } from '@gow/contracts'
import { clarifications, withTenant } from '@gow/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { DbClarificationChannel } from './channel.ts'
import { pendingInbound, resolveInbound } from './inbound.ts'
import { loadContext, persistOutcome, requestOf, setStatus, supplierIdentity, type AppContext } from './store.ts'

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
      return extractStatement(file, { llm: s.llm, classifier: s.documentClassifier }, { ...DEFAULT_OPTIONS, googleAvailable: s.googleAvailable, limit: s.limit })
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
  const input: AppInput = {
    application_id: ctx.application.id,
    pdf_path: doc.storagePath,
    as_of: ctx.application.asOf ?? (s.today ? s.today() : new Date().toISOString().slice(0, 10)),
    request: requestOf(ctx),
    supplier: supplierIdentity(ctx.supplier),
    policy: ctx.active.policy,
    policy_id: ctx.active.id,
  }
  const outcome = await startApplication(createRuntime(deps(s, ctx), s.mastraStore), input)
  const status = await persistOutcome(s.db, ctx, outcome)
  s.logger.info(`application ${ctx.application.id} → ${status}`)
  return status
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
  s.logger.info(`application ${ctx.application.id} reanudada → ${status}`)
  return status
}

/** Procesa los entrantes pendientes; los que completan una aclaración encolan la reanudación. */
export async function sweepInbound(s: WorkerServices, boss: PgBoss): Promise<number> {
  const pending = await pendingInbound(s.db)
  for (const m of pending) {
    const r = await resolveInbound(s.db, m.tenant_id, m.id)
    if (r.resume) await enqueueResume(boss, r.resume)
  }
  return pending.length
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
      await handleProcess(s, ProcessJob.parse(job.data))
    } catch (err) {
      s.logger.error(`process ${job.id}: ${errorText(err)}`)
      throw err
    }
  })
  await boss.work<ResumeJob>(QUEUES.resume, polling, async ([job]) => {
    if (!job) return
    try {
      await handleResume(s, ResumeJob.parse(job.data))
    } catch (err) {
      s.logger.error(`resume ${job.id}: ${errorText(err)}`)
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
    },
  }
}
