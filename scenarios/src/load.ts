/** Lectura de escenarios YAML y de políticas desde la raíz del repo. */
import { parsePolicy, Scenario, type Policy } from '@gow/contracts'
import { BASE_POLICY_ID, basePolicyTemplate } from '@gow/decision'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CATALOG_DIR = join(REPO_ROOT, 'scenarios', 'catalog')

export function loadScenarioFile(path: string): Scenario {
  const res = Scenario.safeParse(parse(readFileSync(path, 'utf8')))
  if (!res.success) throw new Error(`${basename(path)}: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return res.data
}

export function loadCatalog(dir = CATALOG_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => loadScenarioFile(join(dir, f)))
}

/** `base` es la plantilla GOW; cualquier otra cosa es una ruta a un JSON desde la raíz del repo. */
export function loadPolicy(ref: string): { id: string; policy: Policy } {
  if (ref === 'base') return { id: BASE_POLICY_ID, policy: basePolicyTemplate() }
  const path = resolve(REPO_ROOT, ref)
  const res = parsePolicy(JSON.parse(readFileSync(path, 'utf8')))
  if (!res.ok) throw new Error(`${ref}: ${res.message}`)
  return { id: basename(ref, '.json'), policy: res.policy }
}
