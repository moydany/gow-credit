/* eslint-disable no-console -- CLI */
/** pnpm db:migrate: aplica las migraciones con DATABASE_ADMIN_URL (o el Postgres local de docker compose). */
import { databaseUrl } from '../client.ts'
import { runMigrations } from '../migrate.ts'

const url = databaseUrl('admin')
const prompts = await runMigrations(url)
console.log(`migraciones aplicadas en ${new URL(url).host}${new URL(url).pathname}`)
if (prompts.inserted.length) console.log(`prompts sembrados desde prompts/: ${prompts.inserted.join(', ')}`)
if (prompts.activated.length) console.log(`prompts activos ahora: ${prompts.activated.join(', ')}`)
for (const w of prompts.warnings) console.log(`aviso: ${w}`)
