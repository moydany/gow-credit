/**
 * Cola del modo full (docs/02 §4 y §4b): pg-boss en su propio esquema y con su propio rol. La API
 * encola y el worker consume; nadie espera a un workflow suspendido.
 *
 * - `application.process`: un documento nuevo. `singletonKey` = tenant + sha256 + versión de
 *   prompts: el mismo PDF subido dos veces no crea dos trabajos.
 * - `application.resume`: una aclaración respondida. Prioridad alta: el proveedor está esperando.
 * - Reintentos con backoff exponencial y, agotados, `application.dead` (dead letter).
 */
import { PgBoss } from 'pg-boss'
import { z } from 'zod'

export const QUEUES = {
  process: 'application.process',
  resume: 'application.resume',
  redecide: 'application.redecide',
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
  for (const name of [QUEUES.process, QUEUES.resume, QUEUES.redecide]) {
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

export type { PgBoss }
