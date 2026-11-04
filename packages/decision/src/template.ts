/**
 * Plantilla GOW (docs/03 §4 y §5): cada tenant arranca clonando la política base. El JSON vive
 * en `policies/` para que se lea y se versione como dato, no como código.
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

/** Copia de la política base: el tenant la modifica sin tocar la plantilla. */
export function basePolicyTemplate(): Policy {
  return structuredClone(BASE)
}

/** Clona una política como versión nueva de un tenant (borrador hasta que se activa). */
export function clonePolicy(template: Policy, changes: { version?: number; name?: string; description?: string } = {}): Policy {
  return parsed({ ...structuredClone(template), version: changes.version ?? 1, name: changes.name ?? template.name, description: changes.description ?? template.description }, 'política clonada')
}
