/* eslint-disable no-console -- entry point: one JSON line per event, only ids and codes (no PII) */
/**
 * pnpm worker: the long-lived full-mode process. Separate database roles for business
 * (gow_worker), queue (gow_queue) and Mastra (gow_mastra); URLs come from the environment or,
 * without it, from the local docker compose Postgres.
 */
import { join, resolve } from 'node:path'
import { ResendEmailTransport } from '@gow/channels'
import { BUSINESS_TIME_ZONE, calendarToday } from '@gow/contracts'
import { connect, databaseUrl, loadActivePrompts } from '@gow/db'
import { CachedClassifier, CachingStructuredLlm, createClassifier, createLimiter, createTransactionClassifier, JsonFileCache, loadRootEnv, MastraStructuredLlm, readAnthropicEnv, readGoogleEnv, RecordingStructuredLlm, type CacheMode } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage, startQueue } from '@gow/platform'
import { startHealthListener } from '@gow/platform/health'
import { PostgresStore } from '@mastra/pg'
import { HaikuInterpreter } from './interpret.ts'
import { DbLlmExchangeSink } from './llm-exchanges.ts'
import { startPromptRefresh } from './prompts.ts'
import { startWorker } from './worker.ts'

const REPO = resolve(import.meta.dirname, '../../..')

function log(level: 'info' | 'error', message: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message }))
}

loadRootEnv()
const env = process.env
startHealthListener((m) => { log('info', m) })
const anthropic = readAnthropicEnv()
const googleAvailable = readGoogleEnv().apiKey !== null
const cacheMode = (env.LLM_CACHE_MODE ?? 'readwrite') as CacheMode
const cacheDir = env.LLM_CACHE_DIR ?? join(REPO, 'data/llm-cache')
const secret = env.STORAGE_SIGNING_SECRET
if (!secret) {
  log('error', 'Falta STORAGE_SIGNING_SECRET')
  process.exit(2)
}
const limit = createLimiter(Number(env.WORKER_MODEL_CONCURRENCY ?? 3))
const business = connect(databaseUrl('worker'), { max: 5 })
// Every raw model exchange is stored in app.llm_exchanges to analyze a case.
// Outside the cache: responses served from it are recorded too.
const llm = new RecordingStructuredLlm(
  new CachingStructuredLlm(cacheMode !== 'read' && (anthropic.apiKey || googleAvailable) ? new MastraStructuredLlm(anthropic) : null, cacheDir, cacheMode),
  new DbLlmExchangeSink(business.db),
  { onError: (m) => { log('error', m) } },
)
// Prompts: each one's active version comes from the database and refreshes itself; without a database, from prompts/.
const prompts = await startPromptRefresh({ load: () => loadActivePrompts(business.db), logger: { info: (m) => { log('info', m) }, error: (m) => { log('error', m) } } })
const mastraStore = new PostgresStore({ id: 'gow-full', connectionString: databaseUrl('mastra'), schemaName: 'mastra' })
const boss = await startQueue(databaseUrl('queue'), { error: (m) => { log('error', m) } })
const email = env.RESEND_API_KEY && env.RESEND_FROM ? new ResendEmailTransport({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM }) : undefined
// By default, any WhatsApp number can register as a supplier by sending its bank statement:
// the system is a demo and the QR-linked number is the only channel.
// `WHATSAPP_SELF_REGISTRATION=false` turns it off.
const selfRegistration = env.WHATSAPP_SELF_REGISTRATION?.trim().toLowerCase() !== 'false'

const worker = await startWorker(
  {
    db: business.db,
    mastraStore,
    storage: new LocalDocumentStorage({ root: env.STORAGE_DIR ?? join(REPO, 'data/storage'), secret, publicBaseUrl: env.API_PUBLIC_URL ?? 'http://127.0.0.1:3000' }),
    llm,
    documentClassifier: new CachedClassifier(env.TYPESAFE_API_KEY ? 'jev' : 'haiku', cacheMode === 'read' ? null : createClassifier(llm), join(cacheDir, 'classifier')),
    transactionClassifier: createTransactionClassifier(llm, new JsonFileCache(join(cacheDir, 'transactions'), cacheMode)),
    writer: new Writer(llm, limit),
    limit,
    googleAvailable,
    selfRegistration,
    // Business "today" for the calculation date and due dates.
    today: () => calendarToday(env.GOW_TIME_ZONE ?? BUSINESS_TIME_ZONE),
    // Only with real calls: in cache mode there are no stored conversation responses and the
    // conversation continues with rules.
    ...(cacheMode !== 'read' && anthropic.apiKey ? { interpreter: new HaikuInterpreter(llm, { onError: (m) => { log('error', m) } }) } : {}),
    transports: email ? { email } : {},
    logger: { info: (m) => { log('info', m) }, error: (m) => { log('error', m) } },
  },
  boss,
)
log('info', `worker listo${selfRegistration ? ' · registro de proveedores por WhatsApp activo (demo)' : ''}${cacheMode !== 'read' && anthropic.apiKey ? ' · intérprete de mensajes con Haiku' : ''}`)

const shutdown = async () => {
  await worker.stop()
  prompts.stop()
  await boss.stop()
  await mastraStore.close()
  await business.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
