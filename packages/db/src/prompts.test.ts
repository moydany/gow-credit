/**
 * Siembra de prompts (ADR 0065) contra Postgres real: la migración deja cada prompt del catálogo
 * activo en la versión de archivo del código; volver a sembrar no duplica; un cambio de versión por
 * defecto mueve la activa solo si nadie eligió otra; un archivo editado después de sembrarse no
 * cambia la base. Necesita el Postgres de docker compose; sin él se salta.
 */
import { PROMPT_CATALOG, PROMPT_NAMES } from '@gow/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, type Database } from './client.ts'
import { loadActivePrompts, readPromptFiles, sha256Hex, syncPromptFiles } from './prompts.ts'
import { promptVersions, prompts } from './schema.ts'
import { createTestDatabase, postgresAvailable, type TestDatabase } from './testing.ts'

const available = await postgresAvailable()

describe.skipIf(!available)('siembra de prompts (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: Database
  let worker: Database

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = connect(tdb.url('admin'))
    worker = connect(tdb.url('worker'))
  }, 60_000)

  afterAll(async () => {
    await worker.close()
    await admin.close()
    await tdb.drop()
  })

  async function activeOf(name: string) {
    const [row] = await admin.db.select({ version: promptVersions.version, fileVersion: promptVersions.fileVersion, source: promptVersions.source }).from(prompts).innerJoin(promptVersions, eq(promptVersions.id, prompts.activeVersionId)).where(eq(prompts.name, name))
    return row
  }

  it('la migración siembra todos los archivos y deja activa la versión del código', async () => {
    const files = readPromptFiles()
    const rows = await admin.db.select().from(promptVersions)
    expect(rows).toHaveLength(files.length)
    for (const name of PROMPT_NAMES) expect(await activeOf(name)).toMatchObject({ fileVersion: PROMPT_CATALOG[name].version, source: 'file' })
    // Los números de la base siguen a los de los archivos al sembrar desde cero.
    expect(rows.every((r) => r.version === r.fileVersion)).toBe(true)
    // La nota sale del bloque de metadatos (`changes:`).
    expect(rows.find((r) => r.promptName === 'extract_summary' && r.fileVersion === 2)?.note).toMatch(/bloque fiscal/)
  })

  it('el worker lee las versiones activas sin tenant', async () => {
    const active = await loadActivePrompts(worker.db)
    expect(active.map((a) => a.name).sort()).toEqual([...PROMPT_NAMES].sort())
    for (const a of active) expect(sha256Hex(a.text)).toBe(a.sha256)
  })

  it('volver a sembrar no inserta ni activa nada', async () => {
    expect(await syncPromptFiles(admin.db)).toEqual({ inserted: [], activated: [], warnings: [] })
  })

  it('si el código cambió de versión y la activa era la anterior, pasa a la nueva', async () => {
    const [v1] = await admin.db.select().from(promptVersions).where(eq(promptVersions.promptName, 'extract_summary')).orderBy(promptVersions.version).limit(1)
    await admin.db.update(prompts).set({ codeDefaultFileVersion: 1, activeVersionId: v1?.id }).where(eq(prompts.name, 'extract_summary'))
    const report = await syncPromptFiles(admin.db)
    const def = PROMPT_CATALOG.extract_summary.version
    expect(report.activated).toEqual([`extract_summary.v${String(def)}`])
    expect(await activeOf('extract_summary')).toMatchObject({ fileVersion: def })
  })

  it('si una persona eligió otra versión, se respeta y queda un aviso', async () => {
    const text = 'Explica {{decision}} en dos oraciones.'
    const [mine] = await admin.db.insert(promptVersions).values({ promptName: 'explain_decision', version: 3, source: 'backoffice', text, sha256: sha256Hex(text), note: 'más corto', createdBy: 'user:x' }).returning()
    await admin.db.update(prompts).set({ codeDefaultFileVersion: 1, activeVersionId: mine?.id }).where(eq(prompts.name, 'explain_decision'))
    const report = await syncPromptFiles(admin.db)
    expect(report.activated).toEqual([])
    expect(report.warnings).toEqual([expect.stringMatching(/explain_decision: el código pasó a la versión de archivo v2.*se conserva/)])
    expect(await activeOf('explain_decision')).toMatchObject({ version: 3, source: 'backoffice' })
  })

  it('un archivo editado después de sembrarse no cambia la base: aviso', async () => {
    const files = readPromptFiles().map((f) => (f.name === 'next_steps' ? { ...f, text: `${f.text}\nUna regla más.`, sha256: 'otra' } : f))
    const report = await syncPromptFiles(admin.db, files)
    expect(report.inserted).toEqual([])
    expect(report.warnings).toEqual([expect.stringMatching(/next_steps\.v1\.md cambió después de sembrarse/)])
  })

  it('un archivo nuevo entra con el número siguiente de la base', async () => {
    const base = readPromptFiles()
    const v1 = base.find((f) => f.name === 'clarification_questions')
    if (!v1) throw new Error('falta clarification_questions.v1')
    const report = await syncPromptFiles(admin.db, [...base, { ...v1, fileVersion: 2, text: `${v1.text}\nOtra regla.`, sha256: sha256Hex(`${v1.text}\nOtra regla.`), note: 'otra regla' }])
    expect(report.inserted).toEqual(['clarification_questions.v2'])
    // El código sigue en v1: la activa no cambia.
    expect(report.activated).toEqual([])
    const rows = await admin.db.select().from(promptVersions).where(eq(promptVersions.promptName, 'clarification_questions')).orderBy(promptVersions.version)
    expect(rows.map((r) => [r.version, r.fileVersion])).toEqual([[1, 1], [2, 2]])
  })
})
