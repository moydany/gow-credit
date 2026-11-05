/**
 * Alta de tenant (docs/06 escenario 1): la única operación con el rol administrador fuera de las
 * migraciones. Crea el tenant, clona la política base como versión activa y emite la primera llave
 * de API, que se muestra una sola vez y se guarda como hash (docs/05 §2).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Policy } from '@gow/contracts'
import { apiKeys, auditLog, policies, policyVersions, tenants, withTenant, type Db } from '@gow/db'
import { basePolicyTemplate } from '@gow/decision'

export const API_KEY_SCOPES = ['ingest', 'read', 'policies'] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** `gowk_<8 hex>.<secreto>`: el prefijo identifica la llave, el secreto solo existe en manos del tenant. */
export function newApiKey(): { prefix: string; secret: string; key: string } {
  const prefix = `gowk_${randomBytes(4).toString('hex')}`
  const secret = randomBytes(32).toString('base64url')
  return { prefix, secret, key: `${prefix}.${secret}` }
}

export interface NewTenant {
  name: string
  whatsappNumber?: string | null
  emailFrom?: string | null
  policy?: Policy
  scopes?: readonly ApiKeyScope[]
}

/** Con el rol administrador; todo lo demás se escribe ya dentro del tenant (RLS). */
export async function createTenant(admin: Db, input: NewTenant): Promise<{ tenantId: string; apiKey: string; policyVersionId: string }> {
  const tenantId = randomUUID()
  const key = newApiKey()
  const policyId = randomUUID()
  const policyVersionId = randomUUID()
  await withTenant(admin, tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: input.name, whatsappNumber: input.whatsappNumber ?? null, emailFrom: input.emailFrom ?? null })
    await tx.insert(policies).values({ id: policyId, tenantId, name: 'principal' })
    await tx.insert(policyVersions).values({ id: policyVersionId, tenantId, policyId, version: 1, status: 'active', document: input.policy ?? basePolicyTemplate(), activatedAt: new Date() })
    await tx.insert(apiKeys).values({ tenantId, prefix: key.prefix, keyHash: hashSecret(key.secret), scopes: [...(input.scopes ?? API_KEY_SCOPES)] })
    await tx.insert(auditLog).values({ tenantId, actor: 'admin', action: 'tenant.created', subject: tenantId, details: { policy_version_id: policyVersionId, api_key_prefix: key.prefix } })
  })
  return { tenantId, apiKey: key.key, policyVersionId }
}
