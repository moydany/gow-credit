/* eslint-disable no-console -- CLI: la llave se muestra una sola vez */
/**
 * pnpm tenant create --name "Fintech Demo" [--whatsapp +52...] [--email-from aclaraciones@...]
 * Alta de tenant con el rol administrador: clona la política base como activa y emite la primera
 * llave de API (solo se muestra aquí; se guarda como hash).
 */
import { parseArgs } from 'node:util'
import { connect, databaseUrl } from '@gow/db'
import { loadRootEnv } from '@gow/llm'
import { createTenant } from '../admin.ts'

loadRootEnv()
const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, whatsapp: { type: 'string' }, 'email-from': { type: 'string' } } })
if (positionals[0] !== 'create' || !values.name) {
  console.error('uso: pnpm tenant create --name "Fintech Demo" [--whatsapp +52...] [--email-from aclaraciones@...]')
  process.exit(64)
}
const admin = connect(databaseUrl('admin'), { max: 1 })
const t = await createTenant(admin.db, { name: values.name, whatsappNumber: values.whatsapp ?? null, emailFrom: values['email-from'] ?? null })
await admin.close()
console.log(`tenant ${t.tenantId}`)
console.log(`política base activa ${t.policyVersionId}`)
console.log(`llave de API (guárdala; no se vuelve a mostrar): ${t.apiKey}`)
