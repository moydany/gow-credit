/* eslint-disable no-console -- CLI output */
/**
 * `pnpm -F @gow/db db:roles`: on a hosted Postgres (Supabase), gives each process role LOGIN with the
 * password in GOW_DB_PASSWORD_<ROLE>, creating the role if it doesn't exist, and lets `postgres` SET
 * the pg-boss and Mastra owners so migration 0001 can create their schemas (ADR 0034). Idempotent: on
 * Railway it runs before every migration (ADR 0068). It sends SCRAM verifiers, never the passwords,
 * and prints only role names.
 */
import pg from 'pg'
import { databaseUrl } from '../client.ts'
import { scramSha256Verifier } from '../scram.ts'

const ROLES = ['api', 'worker', 'whatsapp', 'readonly', 'queue', 'mastra'] as const
const envName = (role: string) => `GOW_DB_PASSWORD_${role.toUpperCase()}`

const missing = ROLES.filter((r) => !process.env[envName(r)]?.trim()).map(envName)
if (missing.length) {
  console.error(`faltan variables: ${missing.join(', ')}`)
  process.exit(2)
}
if (!process.env.DATABASE_ADMIN_URL?.trim()) {
  console.error('falta DATABASE_ADMIN_URL')
  process.exit(2)
}

const client = new pg.Client({ connectionString: databaseUrl('admin') })
await client.connect()
try {
  for (const r of ROLES) {
    const role = `gow_${r}`
    const verifier = scramSha256Verifier(process.env[envName(r)]?.trim() ?? '')
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(verifier)}`)
    console.log(`${role}: ${exists ? 'contraseña actualizada' : 'creado'}`)
  }
  await client.query('GRANT gow_queue, gow_mastra TO postgres WITH INHERIT FALSE, SET TRUE')
  console.log('postgres puede usar SET ROLE gow_queue y gow_mastra')
} finally {
  await client.end()
}
