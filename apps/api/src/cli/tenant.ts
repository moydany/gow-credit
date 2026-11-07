/* eslint-disable no-console -- CLI: la llave y el enlace se muestran una sola vez */
/**
 * pnpm tenant create --name "Fintech Demo" [--whatsapp +52...] [--email-from aclaraciones@...] [--policy archivo.json]
 * pnpm tenant user add --tenant <id> --email persona@institucion.mx [--hours 8]
 *
 * Alta de tenant con el rol administrador: clona la política base como activa y emite la primera
 * llave de API (solo se muestra aquí; se guarda como hash). `user add` da de alta al usuario del
 * backoffice (un rol, varios usuarios por tenant, docs/08 §1) e imprime su enlace de acceso, firmado
 * con el JWT secret del proyecto. Con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (ADR 0035) además crea
 * o encuentra su cuenta de Supabase Auth y usa ese id: la persona puede entrar con su correo.
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
  // Con el rol administrador solo para esta alta; la pertenencia queda bajo RLS como cualquier fila.
  const existing = await withTenant(admin.db, tenantId, async (tx) => {
    const [t] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
    if (!t) throw new Error('no existe ese tenant')
    const [u] = await tx.select().from(tenantUsers).where(eq(tenantUsers.email, email))
    return u ?? null
  })
  let userId = existing?.userId ?? randomUUID()
  if (auth) {
    // Una pertenencia anterior a Supabase Auth conserva su id: la cuenta nueva se crea con él, así la
    // bitácora sigue apuntando a la misma persona.
    const authId = await auth.ensureUser(email, existing?.userId)
    if (existing && authId !== existing.userId) {
      await admin.close()
      console.error('ese correo ya tiene una cuenta de Supabase Auth con otro id que el de su pertenencia; revísalo en Studio (ADR 0035)')
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
