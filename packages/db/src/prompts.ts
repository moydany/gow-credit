/**
 * Prompts en la base (ADR 0065): siembra desde prompts/ y lectura de las versiones activas.
 *
 * La siembra corre con el dueño de la migración al final de cada `pnpm db:migrate` y es idempotente:
 * - cada `prompts/<nombre>.v<N>.md` del catálogo entra una sola vez como versión `file`;
 * - un prompt nuevo queda activo en la versión de archivo que usa el código (`PROMPT_CATALOG`);
 * - si el código cambió de versión por defecto y la activa era la anterior por defecto, la activa
 *   pasa a la nueva; si una persona eligió otra en el backoffice, se respeta y queda un aviso;
 * - un archivo ya sembrado que cambió de texto no se toca (las versiones son inmutables): aviso.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { filePromptId, PROMPT_CATALOG, PROMPT_NAMES, splitPromptFile, unknownPlaceholders, type PromptName } from '@gow/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import type { Db, Tx } from './client.ts'
import { promptVersions, prompts } from './schema.ts'

export const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url))

export interface PromptFile {
  name: PromptName
  fileVersion: number
  text: string
  sha256: string
  note: string
}

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** Los archivos de prompts/ que pertenecen al catálogo (`nombre.vN.md`). */
export function readPromptFiles(dir: string = PROMPTS_DIR): PromptFile[] {
  const out: PromptFile[] = []
  for (const file of readdirSync(dir)) {
    const m = /^([a-z_]+)\.v(\d+)\.md$/.exec(file)
    if (!m?.[1] || !m[2] || !(PROMPT_NAMES as readonly string[]).includes(m[1])) continue
    const { header, body } = splitPromptFile(readFileSync(`${dir}/${file}`, 'utf8'))
    const fileVersion = Number(m[2])
    out.push({
      name: m[1] as PromptName,
      fileVersion,
      text: body,
      sha256: sha256Hex(body),
      note: header.changes ?? header.note ?? (fileVersion === 1 ? 'primera versión' : `prompts/${file}`),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.fileVersion - b.fileVersion)
}

export interface PromptSyncReport {
  /** Ids de las versiones de archivo que entraron (`extract_summary.v3`). */
  inserted: string[]
  /** Prompts cuya versión activa cambió, con la versión de archivo que quedó. */
  activated: string[]
  warnings: string[]
}

type VersionRow = typeof promptVersions.$inferSelect
type PromptRow = typeof prompts.$inferSelect

/** Inserta los archivos que faltan, con el número siguiente de la base; devuelve todas las versiones. */
async function insertMissingFiles(tx: Tx, name: PromptName, files: PromptFile[], report: PromptSyncReport): Promise<VersionRow[]> {
  const versions = await tx.select().from(promptVersions).where(eq(promptVersions.promptName, name)).orderBy(asc(promptVersions.version))
  let next = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1
  for (const f of files) {
    const seeded = versions.find((v) => v.fileVersion === f.fileVersion)
    if (seeded) {
      if (seeded.sha256 !== f.sha256) report.warnings.push(`prompts/${filePromptId(name, f.fileVersion)}.md cambió después de sembrarse; la base conserva el texto original (crea una versión nueva del archivo)`)
      continue
    }
    const [row] = await tx
      .insert(promptVersions)
      .values({ promptName: name, version: next++, source: 'file', fileVersion: f.fileVersion, text: f.text, sha256: f.sha256, note: f.note, createdBy: 'seed' })
      .returning()
    if (row) versions.push(row)
    report.inserted.push(filePromptId(name, f.fileVersion))
  }
  return versions
}

/** ¿La activa debe pasar a la versión de archivo del código? */
function shouldMoveToDefault(name: PromptName, prompt: PromptRow, active: VersionRow | undefined, report: PromptSyncReport): boolean {
  const def = PROMPT_CATALOG[name].version
  if (!active) return true
  const defaultChanged = prompt.codeDefaultFileVersion !== def
  if (defaultChanged && active.fileVersion === prompt.codeDefaultFileVersion) return true
  if (unknownPlaceholders(name, active.text).length > 0) {
    report.warnings.push(`${name}: la versión activa v${String(active.version)} usa variables que el código ya no pasa; vuelve a la de archivo v${String(def)}`)
    return true
  }
  if (defaultChanged && active.fileVersion !== def) report.warnings.push(`${name}: el código pasó a la versión de archivo v${String(def)}, pero la activa la eligió una persona (v${String(active.version)}); se conserva`)
  return false
}

async function syncOne(tx: Tx, name: PromptName, files: PromptFile[], report: PromptSyncReport): Promise<void> {
  const def = PROMPT_CATALOG[name].version
  if (!files.some((f) => f.fileVersion === def)) {
    report.warnings.push(`falta prompts/${filePromptId(name, def)}.md, la versión que usa el código`)
    return
  }
  // El prompt se crea sin versión activa; la llave foránea compuesta acepta null.
  await tx.insert(prompts).values({ name, codeDefaultFileVersion: def }).onConflictDoNothing()
  const [prompt] = await tx.select().from(prompts).where(eq(prompts.name, name)).for('update')
  if (!prompt) return
  const versions = await insertMissingFiles(tx, name, files, report)
  const target = versions.find((v) => v.fileVersion === def)
  const active = versions.find((v) => v.id === prompt.activeVersionId)
  if (target && target.id !== active?.id && shouldMoveToDefault(name, prompt, active, report)) {
    await tx.update(prompts).set({ activeVersionId: target.id, activatedAt: sql`now()`, activatedBy: null }).where(eq(prompts.name, name))
    report.activated.push(filePromptId(name, def))
  }
  if (prompt.codeDefaultFileVersion !== def) await tx.update(prompts).set({ codeDefaultFileVersion: def }).where(eq(prompts.name, name))
}

/** Siembra idempotente; necesita el rol dueño de la migración (las versiones `file` solo las inserta él). */
export async function syncPromptFiles(db: Db, files: PromptFile[] = readPromptFiles()): Promise<PromptSyncReport> {
  const report: PromptSyncReport = { inserted: [], activated: [], warnings: [] }
  await db.transaction(async (tx) => {
    // Dos migraciones a la vez (la pila y una terminal) no deben numerar dos veces la misma versión.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('app.sync_prompt_files'))`)
    for (const name of PROMPT_NAMES) await syncOne(tx, name, files.filter((f) => f.name === name), report)
  })
  return report
}

export interface ActivePromptRow {
  name: string
  version: number
  source: string
  fileVersion: number | null
  text: string
  sha256: string
}

/** Versión activa de cada prompt. Global: no necesita `withTenant`. */
export async function loadActivePrompts(db: Db): Promise<ActivePromptRow[]> {
  return db
    .select({ name: promptVersions.promptName, version: promptVersions.version, source: promptVersions.source, fileVersion: promptVersions.fileVersion, text: promptVersions.text, sha256: promptVersions.sha256 })
    .from(prompts)
    .innerJoin(promptVersions, eq(promptVersions.id, prompts.activeVersionId))
}
