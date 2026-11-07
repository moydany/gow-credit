/* eslint-disable no-console -- CLI: the key and the link are shown only once */
/**
 * pnpm tenant create --name "Fintech Demo" [--whatsapp +52...] [--email-from aclaraciones@...] [--policy file.json]
 * pnpm tenant user add --tenant <id> --email persona@institucion.mx [--hours 8]
 *
 * Creates a tenant with the admin role: clones the base policy as active and issues the first API
 * key (shown only here; stored as a hash). `user add` creates a backoffice user (one role,
 * several users per tenant) and prints their access link, signed with the project's JWT secret.
 * With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY it also creates or finds their Supabase Auth
 * account and uses that id, so the person can sign in with their email.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parsePolicy } from '@gow/contracts'
import { connect, databaseUrl, tenants, tenantUsers, withTenant } from '@gow/db'
import { loadRootEnv } from '@gow/llm'
import { eq } from 'drizzle-orm'
import { createTenant } from '../admin.ts'
import { issueToken } from '../session.ts'
import { supabaseAuthFromEnv } from '../supabase-auth.ts'

loadRootEnv()
const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, whatsapp: { type: 'string' }, 'email-from': { type: 'string' }, policy: { type: 'string' }, tenant: { type: 'string' }, email: { type: 'string' }, hours: { type: 'string' } } })
const usage = () => {
  console.error('uso: pnpm tenant create --name "Fintech Demo" [--whatsapp +52...] [--email-from aclaraciones@...] [--policy archivo.json]')
  console.error('     pnpm tenant user add --tenant <id> --email persona@institucion.mx [--hours 8]')
  process.exit(64)
}

if (positionals[0] === 'create' && values.name) {
  let policy
  if (values.policy) {
    const parsed = parsePolicy(JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), values.policy), 'utf8')))
    if (!parsed.ok) {
      console.error(`política inválida: ${parsed.message}`)
      process.exit(65)
    }
    policy = parsed.policy
  }
  const admin = connect(databaseUrl('admin'), { max: 1 })
  const t = await createTenant(admin.db, { name: values.name, whatsappNumber: values.whatsapp ?? null, emailFrom: values['email-from'] ?? null, ...(policy ? { policy } : {}) })
  await admin.close()
  console.log(`tenant ${t.tenantId}`)
  console.log(`política base activa ${t.policyVersionId}`)
  console.log(`llave de API (guárdala; no se vuelve a mostrar): ${t.apiKey}`)
} else if (positionals[0] === 'user' && positionals[1] === 'add' && values.tenant && values.email) {
  const secret = process.env.BACKOFFICE_JWT_SECRET
  if (!secret) {
    console.error('Falta BACKOFFICE_JWT_SECRET en el entorno o en .env')
    process.exit(2)
  }
  const webUrl = process.env.BACKOFFICE_URL ?? 'http://127.0.0.1:5173'
  const admin = connect(databaseUrl('admin'), { max: 1 })
  const email = values.email.trim().toLowerCase()
  const tenantId = values.tenant
  const auth = supabaseAuthFromEnv(process.env)
  // Admin role only for this creation; the membership is under RLS like any row.
  const existing = await withTenant(admin.db, tenantId, async (tx) => {
    const [t] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
    if (!t) throw new Error('no existe ese tenant')
    const [u] = await tx.select().from(tenantUsers).where(eq(tenantUsers.email, email))
    return u ?? null
  })
  let userId = existing?.userId ?? randomUUID()
  if (auth) {
    // A membership from before Supabase Auth keeps its id: the new account is created with it, so the
    // audit log keeps pointing at the same person.
    const authId = await auth.ensureUser(email, existing?.userId)
    if (existing && authId !== existing.userId) {
      await admin.close()
      console.error('ese correo ya tiene una cuenta de Supabase Auth con otro id que el de su pertenencia; revísalo en Studio')
      process.exit(1)
    }
    userId = authId
  }
  if (!existing) await withTenant(admin.db, tenantId, (tx) => tx.insert(tenantUsers).values({ tenantId, userId, email }))
  await admin.close()
  const token = issueToken(secret, { sub: userId, email, tenant_id: tenantId }, Number(values.hours ?? 8) * 3600)
  console.log(`usuario ${email} en el tenant ${tenantId}`)
  if (auth) console.log(`cuenta de Supabase Auth ${userId}: entra con su correo en ${webUrl}/entrar`)
  console.log(`enlace de acceso (vigente ${values.hours ?? '8'} h): ${webUrl}/entrar#token=${token}`)
} else {
  usage()
}
