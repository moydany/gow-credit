/* eslint-disable no-console -- CLI output */
/** `pnpm db:migrate`: applies migrations with DATABASE_ADMIN_URL (or the local docker compose Postgres). */
import { databaseUrl } from '../client.ts'
import { runMigrations } from '../migrate.ts'

const url = databaseUrl('admin')
const prompts = await runMigrations(url)
console.log(`migraciones aplicadas en ${new URL(url).host}${new URL(url).pathname}`)
if (prompts.inserted.length) console.log(`prompts sembrados desde prompts/: ${prompts.inserted.join(', ')}`)
if (prompts.activated.length) console.log(`prompts activos ahora: ${prompts.activated.join(', ')}`)
for (const w of prompts.warnings) console.log(`aviso: ${w}`)
