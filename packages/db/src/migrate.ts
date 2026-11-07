/**
 * Migraciones con el rol administrador (el único que puede crear esquemas, roles y políticas).
 * La carpeta drizzle/ tiene las generadas por drizzle-kit desde schema.ts y las escritas a mano
 * (roles, RLS, privilegios); se aplican en orden y una sola vez. Después siembra los prompts de
 * prompts/ en la base (ADR 0065), también idempotente.
 */
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { connect } from './client.ts'
import { syncPromptFiles, type PromptSyncReport } from './prompts.ts'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url))

export async function runMigrations(adminUrl: string): Promise<PromptSyncReport> {
  const conn = connect(adminUrl, { max: 1 })
  try {
    await migrate(conn.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: 'drizzle' })
    return await syncPromptFiles(conn.db)
  } finally {
    await conn.close()
  }
}
