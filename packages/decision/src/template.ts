/**
 * GOW template: each tenant starts by cloning the base policy. The JSON lives in `policies/` so
 * it is read and versioned as data, not code.
 */
import { parsePolicy, type Policy } from '@gow/contracts'
import base from '../../../policies/gow-base.v1.json' with { type: 'json' }

export const BASE_POLICY_ID = 'gow-base.v1'

function parsed(json: unknown, name: string): Policy {
  const res = parsePolicy(json)
  if (!res.ok) throw new Error(`${name}: ${res.message}`)
  return res.policy
}

const BASE = parsed(base, BASE_POLICY_ID)

/** Copy of the base policy: the tenant edits it without touching the template. */
export function basePolicyTemplate(): Policy {
  return structuredClone(BASE)
}

/** Clones a policy as a new tenant version (draft until activated). */
export function clonePolicy(template: Policy, changes: { version?: number; name?: string; description?: string } = {}): Policy {
  return parsed({ ...structuredClone(template), version: changes.version ?? 1, name: changes.name ?? template.name, description: changes.description ?? template.description }, 'política clonada')
}
