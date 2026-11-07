/* eslint-disable no-console -- punto de entrada: una línea JSON por evento, solo ids y códigos (sin PII) */
/**
 * pnpm worker: proceso de larga vida del modo full. Roles de base separados para negocio
 * (gow_worker), cola (gow_queue) y Mastra (gow_mastra); las URL salen del entorno o, sin él, del
 * Postgres local de docker compose.
 */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { ResendEmailTransport } from '@gow/channels'
import { BUSINESS_TIME_ZONE, calendarToday } from '@gow/contracts'
import { connect, databaseUrl } from '@gow/db'
import { CachedClassifier, CachingStructuredLlm, createClassifier, createLimiter, createTransactionClassifier, JsonFileCache, loadRootEnv, MastraStructuredLlm, readAnthropicEnv, readGoogleEnv, type CacheMode } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage, startQueue } from '@gow/platform'
import { PostgresStore } from '@mastra/pg'
import { HaikuInterpreter } from './interpret.ts'
import { startWorker } from './worker.ts'

const REPO = resolve(import.meta.dirname, '../../..')

function log(level: 'info' | 'error', message: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message }))
}

/**
 * Cloud Run exige que un servicio escuche en PORT aunque no reciba tráfico: con la variable, un
 * listener mínimo de salud en todas las interfaces; sin ella (local), nada.
 */
function startHealthListener(log: (message: string) => void): void {
  const port = process.env.PORT
  if (!port) return
  createServer((_req, res) => {
    res.statusCode = 200
    res.end('ok')
  }).listen(Number(port), '0.0.0.0', () => {
    log(`listener de salud en el puerto ${port}`)
  })
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
const llm = new CachingStructuredLlm(cacheMode !== 'read' && (anthropic.apiKey || googleAvailable) ? new MastraStructuredLlm(anthropic) : null, cacheDir, cacheMode)
const business = connect(databaseUrl('worker'), { max: 5 })
const mastraStore = new PostgresStore({ id: 'gow-full', connectionString: databaseUrl('mastra'), schemaName: 'mastra' })
const boss = await startQueue(databaseUrl('queue'), { error: (m) => { log('error', m) } })
const email = env.RESEND_API_KEY && env.RESEND_FROM ? new ResendEmailTransport({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM }) : undefined
// Solo para demos (ADR 0038): cualquier número de WhatsApp puede registrarse como proveedor.
const selfRegistration = env.WHATSAPP_SELF_REGISTRATION === 'true'

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
    // "Hoy" del negocio para la fecha de cálculo y los vencimientos (ADR 0046).
    today: () => calendarToday(env.GOW_TIME_ZONE ?? BUSINESS_TIME_ZONE),
    // Solo con llamadas reales: en modo caché no hay respuestas guardadas de conversaciones y la
    // conversación sigue con reglas (ADR 0040).
    ...(cacheMode !== 'read' && anthropic.apiKey ? { interpreter: new HaikuInterpreter(llm, { onError: (m) => { log('error', m) } }) } : {}),
    transports: email ? { email } : {},
    logger: { info: (m) => { log('info', m) }, error: (m) => { log('error', m) } },
  },
  boss,
)
log('info', `worker listo${selfRegistration ? ' · registro de proveedores por WhatsApp activo (demo, ADR 0038)' : ''}${cacheMode !== 'read' && anthropic.apiKey ? ' · intérprete de mensajes con Haiku' : ''}`)

const shutdown = async () => {
  await worker.stop()
  await boss.stop()
  await mastraStore.close()
  await business.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
