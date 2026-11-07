/**
 * Cola del modo full (docs/02 §4 y §4b): pg-boss en su propio esquema y con su propio rol. La API
 * encola y el worker consume; nadie espera a un workflow suspendido.
 *
 * - `application.process`: un documento nuevo. `singletonKey` = tenant + sha256 + versión de
 *   prompts: el mismo PDF subido dos veces no crea dos trabajos.
 * - `application.resume`: una aclaración respondida. Prioridad alta: el proveedor está esperando.
 * - `supplier.purge`: limpieza fuera de la base de un proveedor borrado desde el backoffice (ADR 0059).
 * - Reintentos con backoff exponencial y, agotados, `application.dead` (dead letter).
 */
import { PgBoss } from 'pg-boss'
import { z } from 'zod'

export const QUEUES = {
  process: 'application.process',
  resume: 'application.resume',
  redecide: 'application.redecide',
  purge: 'supplier.purge',
  dead: 'application.dead',
} as const

export const PRIORITY = { redecide: 10, resume: 10, process: 0, bulk: -10 } as const

/** Versión de los prompts de extracción en la llave de idempotencia (cambiar prompts reprocesa). */
export const PROMPTS_VERSION = 'extract_summary.v2+extract_transactions.v2'

export const ProcessJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid() })
export type ProcessJob = z.infer<typeof ProcessJob>
export const ResumeJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid(), clarification_id: z.uuid() })
export type ResumeJob = z.infer<typeof ResumeJob>

/** Un analista corrigió valores en revisión humana: se reevalúa con ellos (ADR 0020). */
export const RedecideJob = z.strictObject({ tenant_id: z.uuid(), application_id: z.uuid(), correction_batch: z.uuid() })
export type RedecideJob = z.infer<typeof RedecideJob>

/**
 * Un proveedor borrado desde el backoffice (ADR 0059): la base ya no tiene sus filas; quedan sus PDFs,
 * los trabajos de la cola de sus solicitudes y el estado de Mastra de sus corridas. Solo ids y rutas.
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
  // El esquema lo crea la migración (0001_rls.sql) con su dueño: el rol de la cola no crea esquemas.
  const boss = new PgBoss({ connectionString, schema: 'pgboss', createSchema: false, supervise: opts.supervise ?? true, schedule: false })
  // Sin el error crudo: puede traer el payload del trabajo. Solo el código.
  boss.on('error', (err: unknown) => {
    logger.error(`pg-boss: ${err instanceof Error ? err.name : 'error'}`)
  })
  await boss.start()
  if (!(await boss.getQueue(QUEUES.dead))) await boss.createQueue(QUEUES.dead, { retryLimit: 0 })
  for (const name of [QUEUES.process, QUEUES.resume, QUEUES.redecide, QUEUES.purge]) {
    // `exclusive` con singletonKey: a lo más un trabajo en cola o activo por llave (en `standard`
    // la llave no deduplica).
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { ...RETRY, policy: 'exclusive', deadLetter: QUEUES.dead })
  }
  return boss
}

export function processKey(tenantId: string, sha256: string): string {
  return `${tenantId}:${sha256}:${PROMPTS_VERSION}`
}

export async function enqueueProcess(boss: PgBoss, job: ProcessJob, sha256: string, priority: number = PRIORITY.process): Promise<string | null> {
  return boss.send(QUEUES.process, ProcessJob.parse(job), { singletonKey: processKey(job.tenant_id, sha256), priority })
}

export async function enqueueResume(boss: PgBoss, job: ResumeJob): Promise<string | null> {
  return boss.send(QUEUES.resume, ResumeJob.parse(job), { singletonKey: job.clarification_id, priority: PRIORITY.resume })
}

export async function enqueueRedecide(boss: PgBoss, job: RedecideJob): Promise<string | null> {
  return boss.send(QUEUES.redecide, RedecideJob.parse(job), { singletonKey: job.correction_batch, priority: PRIORITY.redecide })
}

export async function enqueuePurge(boss: PgBoss, job: PurgeJob): Promise<string | null> {
  return boss.send(QUEUES.purge, PurgeJob.parse(job), { singletonKey: job.supplier_id, priority: PRIORITY.process })
}

/** Trabajos de la cola de estas solicitudes, en cualquier estado: se borran al borrar al proveedor. */
export async function deleteApplicationJobs(boss: PgBoss, applicationIds: readonly string[]): Promise<number> {
  let deleted = 0
  for (const name of [QUEUES.process, QUEUES.resume, QUEUES.redecide, QUEUES.dead]) {
    for (const application_id of applicationIds) {
      const jobs = await boss.findJobs<object>(name, { data: { application_id } })
      if (jobs.length === 0) continue
      await boss.deleteJob(name, jobs.map((j) => j.id))
      deleted += jobs.length
    }
  }
  return deleted
}

export type { PgBoss }
