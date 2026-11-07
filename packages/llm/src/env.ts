import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Loads the repo root .env if it exists and the variable is not already in the environment. */
export function loadRootEnv(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (existsSync(path)) process.loadEnvFile(path)
}

export interface AnthropicEnv {
  apiKey: string | null
  /** Only for user keys without a workspace (the API requires the header). */
  workspaceId: string | null
  /** For tests against a local server; normally null. */
  baseURL: string | null
}

export interface GoogleEnv {
  apiKey: string | null
  baseURL: string | null
}

/** Experimental provider. Without this key, gemini-* models are unavailable. */
export function readGoogleEnv(env: NodeJS.ProcessEnv = process.env): GoogleEnv {
  const blank = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null)
  // GEMINI_API_KEY is the name in Google's docs; both are accepted.
  return { apiKey: blank(env.GOOGLE_GENERATIVE_AI_API_KEY) ?? blank(env.GEMINI_API_KEY), baseURL: blank(env.GOW_GOOGLE_BASE_URL) }
}

export function readAnthropicEnv(env: NodeJS.ProcessEnv = process.env): AnthropicEnv {
  const blank = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null)
  return {
    apiKey: blank(env.ANTHROPIC_API_KEY),
    workspaceId: blank(env.ANTHROPIC_WORKSPACE_ID),
    baseURL: blank(env.GOW_ANTHROPIC_BASE_URL),
  }
}
