/**
 * Tenant creation: the only operation that uses the admin role outside migrations. Creates the
 * tenant, clones the base policy as the active version and issues the first API key, shown once
 * and stored as a hash.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ApiKeyScope, type Policy } from '@gow/contracts'
import { apiKeys, auditLog, policies, policyVersions, tenants, withTenant, type Db } from '@gow/db'
import { basePolicyTemplate } from '@gow/decision'

/** Key scopes; the contract lives in `@gow/contracts` (the backoffice uses it too). */
export const API_KEY_SCOPES = ApiKeyScope.options
export type { ApiKeyScope }

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** `gowk_<8 hex>.<secret>`: the prefix identifies the key; only the tenant holds the secret. */
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

/** Runs with the admin role; everything else is written inside the tenant (RLS). */
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
