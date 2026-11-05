/* eslint-disable no-console -- CLI */
/** pnpm db:migrate: aplica las migraciones con DATABASE_ADMIN_URL (o el Postgres local de docker compose). */
import { databaseUrl } from '../client.ts'
import { runMigrations } from '../migrate.ts'

const url = databaseUrl('admin')
await runMigrations(url)
console.log(`migraciones aplicadas en ${new URL(url).host}${new URL(url).pathname}`)
