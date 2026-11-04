import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Carga el .env de la raíz del repo si existe y si la variable no está ya en el entorno. */
export function loadRootEnv(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (existsSync(path)) process.loadEnvFile(path)
}

export interface AnthropicEnv {
  apiKey: string | null
  /** Solo para llaves de usuario sin workspace (la API exige el header). */
  workspaceId: string | null
  /** Para pruebas contra un servidor local; normalmente null. */
  baseURL: string | null
}

export function readAnthropicEnv(env: NodeJS.ProcessEnv = process.env): AnthropicEnv {
  const blank = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null)
  return {
    apiKey: blank(env.ANTHROPIC_API_KEY),
    workspaceId: blank(env.ANTHROPIC_WORKSPACE_ID),
    baseURL: blank(env.GOW_ANTHROPIC_BASE_URL),
  }
}
