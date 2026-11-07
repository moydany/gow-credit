/* eslint-disable no-console -- CLI */
/**
 * pnpm demo:reset [--tenant <id>] --yes
 *
 * Wipes the lender (the only one, or `--tenant`) with everything it owns and leaves the backoffice
 * at the first-run wizard, to hand a demo over clean (`reset.ts`). Keeps prompts and the WhatsApp
 * session on its volume. With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY it also deletes the
 * members' Supabase Auth accounts. On Railway: `railway run --service app -- pnpm demo:reset --yes`,
 * then restart the `whatsapp` service so it waits for the new lender.
 */
import { parseArgs } from 'node:util'
import { connect, databaseUrl } from '@gow/db'
import { loadRootEnv } from '@gow/llm'
import { startQueue } from '@gow/platform'
import { ResetBlocked, resetTenant, soleTenant } from '../reset.ts'
import { supabaseAuthFromEnv } from '../supabase-auth.ts'

loadRootEnv()
const { values } = parseArgs({ options: { tenant: { type: 'string' }, yes: { type: 'boolean', default: false } } })
const admin = connect(databaseUrl('admin'), { max: 1 })
const tenantId = values.tenant ?? (await soleTenant(admin.db))
if (!tenantId) {
  await admin.close()
  console.log(values.tenant ? 'no existe ese tenant' : 'no hay una sola institución que borrar (ninguna, o varias: indica --tenant)')
  process.exit(values.tenant ? 1 : 0)
}
if (!values.yes) {
  await admin.close()
  console.error(`Esto borra la institución ${tenantId} con todos sus proveedores, solicitudes, estados de cuenta, usuarios, políticas y bitácora. No se puede deshacer.`)
  console.error('Vuelve a correrlo con --yes para confirmar.')
  process.exit(1)
}
const boss = await startQueue(databaseUrl('queue'), { error: (m) => { console.error(m) } }, { supervise: false })
try {
  const r = await resetTenant(admin.db, boss, tenantId)
  const auth = supabaseAuthFromEnv(process.env)
  let accounts = 0
  if (auth?.deleteUser) {
    for (const id of r.userIds) {
      await auth.deleteUser(id)
      accounts++
    }
  }
  console.log(`institución ${r.tenantId} borrada: ${String(r.suppliers)} proveedores (sus PDFs los borra el worker), ${String(r.rows.tenant_users ?? 0)} usuarios, ${String(r.rows.audit_log ?? 0)} movimientos de bitácora`)
  console.log(auth ? `${String(accounts)} cuentas de Supabase Auth borradas` : 'sin Supabase Auth configurado: no se borraron cuentas')
  console.log('El backoffice vuelve al primer inicio. Reinicia el proceso de WhatsApp para que espere a la nueva institución; su sesión se conserva.')
} catch (e) {
  console.error(e instanceof ResetBlocked ? e.message : e)
  process.exitCode = 1
} finally {
  await boss.stop({ graceful: true })
  await admin.close()
}
