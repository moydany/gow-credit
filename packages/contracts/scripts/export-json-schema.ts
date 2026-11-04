/* eslint-disable no-console -- CLI */
/**
 * Escribe docs/schema/<nombre>.schema.json desde los esquemas Zod.
 * Uso: pnpm schema:export   (raíz)   |   pnpm -F @gow/contracts schema:export
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PUBLISHED_SCHEMAS, toPublishedJsonSchema } from '../src/json-schema.ts'

export const SCHEMA_DIR = fileURLToPath(new URL('../../../docs/schema/', import.meta.url))

export function renderSchema(name: keyof typeof PUBLISHED_SCHEMAS): string {
  return `${JSON.stringify(toPublishedJsonSchema(name), null, 2)}\n`
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  mkdirSync(SCHEMA_DIR, { recursive: true })
  for (const name of Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[]) {
    writeFileSync(`${SCHEMA_DIR}${name}.schema.json`, renderSchema(name))
    console.log(`docs/schema/${name}.schema.json`)
  }
}
