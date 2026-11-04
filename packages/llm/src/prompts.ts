/**
 * Carga prompts versionados de prompts/<nombre>.v<N>.md. El bloque de metadatos inicial
 * (comentario HTML) no se manda al modelo. Las variables son {{nombre}}; falta una → error.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url))

export interface Prompt {
  /** `extract_summary.v1` */
  id: string
  text: string
}

const cache = new Map<string, string>()

export function loadPrompt(name: string, version: number, vars: Record<string, string | number> = {}): Prompt {
  const id = `${name}.v${String(version)}`
  let raw = cache.get(id)
  if (raw === undefined) {
    raw = readFileSync(`${PROMPTS_DIR}${id}.md`, 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '')
    cache.set(id, raw)
  }
  const text = raw.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key]
    if (v === undefined) throw new Error(`el prompt ${id} usa {{${key}}} y no se le pasó`)
    return String(v)
  })
  return { id, text: text.trim() }
}
