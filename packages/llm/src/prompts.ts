/**
 * Model prompts. Without a database (standalone, evals, tests) they come from
 * prompts/<name>.v<N>.md at the version `PROMPT_CATALOG` pins. In full mode the worker loads each
 * prompt's active version from the database with `setActivePrompts` and refreshes it every few
 * seconds; anything missing from the database (or unusable) still comes from the file.
 *
 * The leading metadata block (HTML comment) is not sent to the model. Variables are {{name}}; a
 * missing one is an error.
 *
 * Response cache: the key already includes the rendered text (`system` and `instruction`) and the
 * prompt id. A backoffice version id carries the text fingerprint (`extract_summary.db3-1a2b3c4d`)
 * and that of a version identical to a file is the file's (`extract_summary.v2`): an edited
 * prompt never reuses old responses and an unchanged one keeps its usual cache.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dbPromptId, filePromptId, PROMPT_CATALOG, PROMPT_NAMES, renderPrompt, splitPromptFile, unknownPlaceholders, type PromptName } from '@gow/contracts'

const PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url))

export interface Prompt {
  /** `extract_summary.v1` (file) or `extract_summary.db3-1a2b3c4d` (backoffice). */
  id: string
  text: string
  /** sha256 of the template, before substituting variables. */
  sha256: string
  /** Where it came from: repository file or the active database version. */
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

/** Prompt at its active version: the database one if the worker loaded it, else the catalog file version. */
export function loadPrompt(name: PromptName, vars: Record<string, string | number> = {}): Prompt {
  return render(active.get(name) ?? fileTemplate(name, PROMPT_CATALOG[name].version), vars)
}

/** A specific file version, whichever is active (evals, comparisons). */
export function loadPromptFile(name: PromptName, version: number, vars: Record<string, string | number> = {}): Prompt {
  return render(fileTemplate(name, version), vars)
}

/**
 * Label for caches that do not see the prompt text (the document classification one): null while
 * the active prompt is the code's file version, to avoid invalidating what is stored; the id
 * otherwise.
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
  /** Prompts that come from the database. */
  loaded: string[]
  /** Those that were unusable and still come from the file, with the reason (no prompt text). */
  rejected: string[]
}

/**
 * Replaces the active versions (full mode). A prompt not in the catalog or using variables the
 * code does not pass is ignored: the file stays in effect and it lands in `rejected`.
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
    // A version with the same text as a file keeps the file id (and its cache).
    const sameAsFile = r.fileVersion !== null && r.source === 'file' && sha256Hex(r.text) === r.sha256
    const id = sameAsFile ? filePromptId(name, r.fileVersion as number) : dbPromptId(name, r.version, r.sha256)
    next.set(name, { id, template: r.text.trim(), sha256: r.sha256, source: 'db' })
    report.loaded.push(id)
  }
  active = next
  return report
}

/** Back to the files (tests). */
export function clearActivePrompts(): void {
  active = new Map()
}
