/* eslint-disable no-console -- CLI: solo conteos y rutas, nunca valores */
/**
 * pnpm corrections:export --tenant <id> [--out data/corrections]
 *
 * Exporta las correcciones del analista (ADR 0020) al formato que lee la eval de correcciones
 * (`pnpm -F @gow/evals corrections`): un archivo por documento, `<sha256>.json`, con la última
 * corrección de cada valor. Corre con el rol de solo lectura y dentro del tenant (RLS). La salida
 * no lleva usuario, tenant ni solicitud; sí los valores, por eso va a `data/`, que no se versiona.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CorrectionsExport, CorrectionTarget } from '@gow/contracts'
import { connect, databaseUrl, withTenant } from '@gow/db'
import { loadRootEnv } from '@gow/llm'
import { sql } from 'drizzle-orm'

const REPO = resolve(import.meta.dirname, '../../../..')

loadRootEnv()
const { values, positionals } = parseArgs({ allowPositionals: true, options: { tenant: { type: 'string' }, out: { type: 'string', default: join(REPO, 'data/corrections') } } })
if (positionals[0] !== 'export' || !values.tenant) {
  console.error('uso: pnpm corrections:export --tenant <id> [--out data/corrections]')
  process.exit(64)
}
const tenantId = values.tenant
const outDir = resolve(process.env.INIT_CWD ?? process.cwd(), values.out)

const ro = connect(databaseUrl('readonly'), { max: 1 })
try {
  const rows = await withTenant(ro.db, tenantId, (tx) =>
    tx.execute<{ sha256: string; target: unknown; read_value: string | number | null; value: string | number; page: number | null }>(sql`
      select d.sha256, c.target, c.read_value, c.value, c.page
        from app.corrections c join app.documents d on d.id = c.document_id
       order by d.sha256, c.created_at`),
  )
  // La última corrección de cada valor gana; el valor leído es el de la primera (lo que leyó el modelo).
  const byDoc = new Map<string, Map<string, CorrectionsExport['corrections'][number]>>()
  for (const r of rows.rows) {
    const target = CorrectionTarget.parse(r.target)
    const key = JSON.stringify(target)
    const doc = byDoc.get(r.sha256) ?? new Map<string, CorrectionsExport['corrections'][number]>()
    const prev = doc.get(key)
    doc.set(key, { target, read_value: prev ? prev.read_value : r.read_value, value: r.value, page: r.page ?? prev?.page ?? null })
    byDoc.set(r.sha256, doc)
  }
  mkdirSync(outDir, { recursive: true })
  const exportedAt = new Date().toISOString()
  for (const [sha, fixes] of byDoc) {
    const file = CorrectionsExport.parse({ version: 1, document_sha256: sha, exported_at: exportedAt, corrections: [...fixes.values()] })
    writeFileSync(join(outDir, `${sha}.json`), `${JSON.stringify(file, null, 2)}\n`)
  }
  console.log(`${String(byDoc.size)} documento(s), ${String([...byDoc.values()].reduce((n, m) => n + m.size, 0))} corrección(es) en ${outDir}`)
} finally {
  await ro.close()
}
