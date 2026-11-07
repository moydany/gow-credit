#!/bin/sh
# pnpm supabase:env [--force]
#
# Generates the dev secrets for the local Supabase (docker-compose.supabase.yml):
#   infra/supabase/.env     compose variables: JWT secret, anon and service_role keys signed with
#                           it (HS256), Postgres password, Studio user, etc.
#   infra/supabase/app.env  app environment (api, worker, whatsapp, tenant, tests) against that
#                           Supabase: one URL per role, BACKOFFICE_JWT_SECRET = JWT_SECRET.
# Both are git-ignored and only useful locally. An existing .env is kept (the keys would change
# and the already initialized database would reject the password); app.env is always rewritten
# from it. --force regenerates .env: run `pnpm supabase:down -v` first, because the Postgres
# password is fixed when the volume is created.
set -eu

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$ROOT/infra/supabase"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ROOT="$ROOT" DIR="$DIR" FORCE="$FORCE" node --input-type=module - <<'NODE'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { ROOT, DIR, FORCE } = process.env
const envPath = join(DIR, '.env')
const appEnvPath = join(DIR, 'app.env')

const parse = (text) => Object.fromEntries(
  text.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1')]
  }),
)
const b64url = (buf) => Buffer.from(buf).toString('base64url')
const hex = (n) => randomBytes(n).toString('hex')
const jwt = (secret, payload) => {
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`
  return `${head}.${b64url(createHmac('sha256', secret).update(head).digest())}`
}

if (!existsSync(envPath) || FORCE === '1') {
  const jwtSecret = hex(32)
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 5 * 365 * 24 * 3600
  const generated = {
    POSTGRES_PASSWORD: hex(16),
    JWT_SECRET: jwtSecret,
    ANON_KEY: jwt(jwtSecret, { role: 'anon', iss: 'supabase', iat, exp }),
    SERVICE_ROLE_KEY: jwt(jwtSecret, { role: 'service_role', iss: 'supabase', iat, exp }),
    DASHBOARD_PASSWORD: hex(12),
    PG_META_CRYPTO_KEY: hex(24),
    GOW_STORAGE_SIGNING_SECRET: hex(32),
  }
  // The versioned template carries the configuration; only the empty secrets are filled in here.
  const template = readFileSync(join(DIR, '.env.example'), 'utf8')
  const out = template.split('\n').map((line) => {
    const m = /^([A-Z0-9_]+)=$/.exec(line)
    return m && generated[m[1]] ? `${m[1]}=${generated[m[1]]}` : line
  }).join('\n')
  const missing = Object.keys(generated).filter((k) => !out.includes(`\n${k}=${generated[k]}`))
  if (missing.length) throw new Error(`faltan en .env.example: ${missing.join(', ')}`)
  writeFileSync(envPath, out, { mode: 0o600 })
  console.log(`escrito ${envPath}`)
} else {
  console.log(`se conserva ${envPath} (usa --force para regenerarlo)`)
}

const e = parse(readFileSync(envPath, 'utf8'))
const dbPort = e.GOW_SUPABASE_DB_PORT || '54340'
const db = (user, password) => `postgres://${user}:${password}@127.0.0.1:${dbPort}/postgres`
const role = (r) => db(`gow_${r}`, `gow_${r}_dev`)
const app = `# Generado por scripts/supabase-env.sh desde infra/supabase/.env: no se versiona ni se edita a mano.
# Uso: set -a; . infra/supabase/app.env; set +a   y luego pnpm db:migrate, pnpm api, pnpm test, ...
# Estas variables ganan sobre el .env de la raíz (loadRootEnv no sobreescribe el entorno).
GOW_MODE=full
# Migraciones con \`postgres\`, como en Supabase (no es superusuario; supabase_admin sí).
DATABASE_ADMIN_URL=${db('postgres', e.POSTGRES_PASSWORD)}
# Roles de la app con la contraseña de desarrollo de infra/postgres/init/00-roles.sql.
DATABASE_URL_API=${role('api')}
DATABASE_URL_WORKER=${role('worker')}
DATABASE_URL_WHATSAPP=${role('whatsapp')}
DATABASE_URL_READONLY=${role('readonly')}
DATABASE_URL_QUEUE=${role('queue')}
DATABASE_URL_MASTRA=${role('mastra')}
# El JWT secret del proyecto: tokens de Supabase Auth y de \`pnpm tenant user add\` son intercambiables.
BACKOFFICE_JWT_SECRET=${e.JWT_SECRET}
BACKOFFICE_URL=http://127.0.0.1:5173
SUPABASE_URL=${e.SUPABASE_PUBLIC_URL}
SUPABASE_ANON_KEY=${e.ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${e.SERVICE_ROLE_KEY}
# Documentos en disco, aparte de los del Postgres simple (el adaptador de Supabase Storage está pendiente).
STORAGE_SIGNING_SECRET=${e.GOW_STORAGE_SIGNING_SECRET}
STORAGE_DIR=${join(ROOT, 'data/storage-supabase')}
API_PUBLIC_URL=http://127.0.0.1:3000
# Solo respuestas en caché: un documento sin caché falla en vez de gastar. Cambia a readwrite para extraer de verdad.
LLM_CACHE_MODE=read
`
writeFileSync(appEnvPath, app, { mode: 0o600 })
console.log(`escrito ${appEnvPath}`)
NODE
