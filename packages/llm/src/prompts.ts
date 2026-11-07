/**
 * Prompts de los modelos (ADR 0065). Sin base (modo standalone, evals, pruebas) salen de
 * prompts/<nombre>.v<N>.md en la versión que fija `PROMPT_CATALOG`. En modo full el worker carga de
 * la base la versión activa de cada prompt con `setActivePrompts` y la refresca cada pocos segundos;
 * lo que no esté en la base (o no sirva) sigue saliendo del archivo.
 *
 * El bloque de metadatos inicial (comentario HTML) no se manda al modelo. Las variables son
 * {{nombre}}; falta una → error.
 *
 * Caché de respuestas: la llave ya incluye el texto ya renderizado (`system` e `instruction`) y la
 * id del prompt. La id de una versión del backoffice lleva la huella del texto
 * (`extract_summary.db3-1a2b3c4d`), y la de una versión idéntica a un archivo es la del archivo
 * (`extract_summary.v2`): un prompt editado nunca reutiliza respuestas viejas y uno sin cambios
 * conserva la caché de siempre.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dbPromptId, filePromptId, PROMPT_CATALOG, PROMPT_NAMES, renderPrompt, splitPromptFile, unknownPlaceholders, type PromptName } from '@gow/contracts'

const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url))

export interface Prompt {
  /** `extract_summary.v1` (archivo) o `extract_summary.db3-1a2b3c4d` (backoffice). */
  id: string
  text: string
  /** sha256 de la plantilla, antes de sustituir variables. */
  sha256: string
  /** De dónde salió: archivo del repositorio o versión activa de la base. */
  source: 'file' | 'db'
}

interface Template {
  id: string
  template: string
  sha256: string
  source: 'file' | 'db'
}

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')
const fileCache = new Map<string, Template>()
let active = new Map<string, Template>()

function fileTemplate(name: string, version: number): Template {
  const id = filePromptId(name, version)
  let t = fileCache.get(id)
  if (!t) {
    const { body } = splitPromptFile(readFileSync(`${PROMPTS_DIR}${id}.md`, 'utf8'))
    t = { id, template: body, sha256: sha256Hex(body), source: 'file' }
    fileCache.set(id, t)
  }
  return t
}

function render(t: Template, vars: Record<string, string | number>): Prompt {
  return { id: t.id, text: renderPrompt(t.id, t.template, vars).trim(), sha256: t.sha256, source: t.source }
}

/** Prompt en su versión activa: la de la base si el worker la cargó, si no la de archivo del catálogo. */
export function loadPrompt(name: PromptName, vars: Record<string, string | number> = {}): Prompt {
  return render(active.get(name) ?? fileTemplate(name, PROMPT_CATALOG[name].version), vars)
}

/** Una versión de archivo concreta, sin importar cuál esté activa (evals, comparaciones). */
export function loadPromptFile(name: PromptName, version: number, vars: Record<string, string | number> = {}): Prompt {
  return render(fileTemplate(name, version), vars)
}

/**
 * Etiqueta para las cachés que no ven el texto del prompt (la de clasificación de documentos):
 * null mientras el prompt activo sea la versión de archivo del código, para no invalidar lo ya
 * guardado; la id en cualquier otro caso.
 */
export function promptCacheTag(name: PromptName): string | null {
  const t = active.get(name)
  return !t || t.id === filePromptId(name, PROMPT_CATALOG[name].version) ? null : t.id
}

export interface ActivePromptInput {
  name: string
  version: number
  source: string
  fileVersion: number | null
  text: string
  sha256: string
}

export interface ActivePromptsReport {
  /** Prompts que salen de la base. */
  loaded: string[]
  /** Los que no sirvieron y siguen saliendo del archivo, con la razón (sin texto del prompt). */
  rejected: string[]
}

/**
 * Reemplaza las versiones activas (modo full). Un prompt que no es del catálogo o que usa variables
 * que el código no le pasa se ignora: sigue el archivo y queda en `rejected`.
 */
export function setActivePrompts(rows: readonly ActivePromptInput[]): ActivePromptsReport {
  const next = new Map<string, Template>()
  const report: ActivePromptsReport = { loaded: [], rejected: [] }
  for (const r of rows) {
    if (!(PROMPT_NAMES as readonly string[]).includes(r.name)) {
      report.rejected.push(`${r.name}: no está en el catálogo`)
      continue
    }
    const name = r.name as PromptName
    const unknown = unknownPlaceholders(name, r.text)
    if (unknown.length) {
      report.rejected.push(`${name}: usa {{${unknown.join('}}, {{')}}}`)
      continue
    }
    // Una versión con el mismo texto que un archivo conserva la id del archivo (y su caché).
    const sameAsFile = r.fileVersion !== null && r.source === 'file' && sha256Hex(r.text) === r.sha256
    const id = sameAsFile ? filePromptId(name, r.fileVersion as number) : dbPromptId(name, r.version, r.sha256)
    next.set(name, { id, template: r.text.trim(), sha256: r.sha256, source: 'db' })
    report.loaded.push(id)
  }
  active = next
  return report
}

/** Vuelve a los archivos (pruebas). */
export function clearActivePrompts(): void {
  active = new Map()
}
