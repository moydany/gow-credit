/* eslint-disable no-console -- punto de entrada: una línea JSON por evento, sin PII */
/** pnpm api: la API del modo full sobre el Postgres de docker compose (o las URL del entorno). */
import { join, resolve } from 'node:path'
import { connect, databaseUrl } from '@gow/db'
import { loadRootEnv } from '@gow/llm'
import { LocalDocumentStorage, startQueue } from '@gow/platform'
import { createApp } from './app.ts'
import { supabaseAuthFromEnv } from './supabase-auth.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const log = (level: 'info' | 'error', message: string) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message }))
}

loadRootEnv()
const env = process.env
const secret = env.STORAGE_SIGNING_SECRET
if (!secret) {
  log('error', 'Falta STORAGE_SIGNING_SECRET')
  process.exit(2)
}
const port = Number(env.PORT ?? 3000)
// En local solo loopback; en Cloud Run el tráfico entra por la interfaz del contenedor (HOST=0.0.0.0).
const host = env.HOST ?? '127.0.0.1'
const publicUrl = env.API_PUBLIC_URL ?? `http://127.0.0.1:${String(port)}`
const db = connect(databaseUrl('api'), { max: 10 })
const boss = await startQueue(databaseUrl('queue'), { error: (m) => { log('error', m) } }, { supervise: false })
const auth = supabaseAuthFromEnv(env)
/** Horas de una variable del entorno (positivas); sin ella, el valor por defecto. */
const hours = (name: string, fallback: number): number => {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    log('error', `${name} debe ser un número de horas mayor que cero`)
    process.exit(2)
  }
  return n
}
const app = createApp({
  db: db.db,
  boss,
  storage: new LocalDocumentStorage({ root: env.STORAGE_DIR ?? join(REPO, 'data/storage'), secret, publicBaseUrl: publicUrl }),
  resendWebhookSecret: env.RESEND_WEBHOOK_SECRET ?? null,
  backofficeJwtSecret: env.BACKOFFICE_JWT_SECRET ?? null,
  secureCookies: publicUrl.startsWith('https://'),
  backofficeUrl: env.BACKOFFICE_URL ?? null,
  auth,
  sessionMaxHours: hours('BACKOFFICE_SESSION_MAX_HOURS', 12),
  sessionIdleHours: hours('BACKOFFICE_SESSION_IDLE_HOURS', 8),
  logger: { error: (m) => { log('error', m) } },
})
if (!env.BACKOFFICE_JWT_SECRET) log('info', 'BACKOFFICE_JWT_SECRET sin definir: /bo/v1 (backoffice) deshabilitado')
else if (auth) log('info', 'Supabase Auth configurado: el backoffice entra con enlace por correo y la sesión se renueva sola')
const server = app.listen(port, host, () => {
  log('info', `api escuchando en ${publicUrl}`)
})
const shutdown = () => {
  server.close(() => {
    void boss.stop().then(() => db.close()).then(() => process.exit(0))
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
