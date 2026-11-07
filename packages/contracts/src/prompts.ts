/**
 * Model prompts. The text lives in `prompts/<name>.v<N>.md` and, in full mode, also in the
 * database (`app.prompts` and `app.prompt_versions`), where the backoffice creates new versions
 * and picks the active one. This catalog is the source of truth for which prompts exist, which
 * file version the code uses by default and which variables each takes; seeding, the loader and
 * the API read it.
 *
 * Pure functions (no `node:`): the browser uses them too.
 */
import { z } from 'zod'

interface CatalogEntry {
  /** Version of `prompts/<name>.v<N>.md` the code uses and seeding leaves active. */
  version: number
  title: string
  description: string
  model: string
  /** `{{name}}` variables the code passes to the prompt; a version cannot use others. */
  variables: readonly string[]
}

const HAIKU = 'claude-haiku-5-5'
const EXTRACTION = 'gemini-3.8-flash (Opus como emergencia)'

export const PROMPT_CATALOG = {
  extract_system: {
    version: 1,
    title: 'Extracción: instrucciones de sistema',
    description: 'System prompt de todas las llamadas de extracción sobre un documento. Es parte del prefijo cacheado: idéntico en todas las pasadas.',
    model: EXTRACTION,
    variables: [],
  },
  extract_summary: {
    version: 3,
    title: 'Extracción: portada y resumen',
    description: 'Pasada 1: titular y su domicilio, cuentas, periodos, saldos, totales y bloque fiscal (CFDI impreso).',
    model: EXTRACTION,
    variables: ['page_count'],
  },
  extract_transactions: {
    version: 2,
    title: 'Extracción: movimientos por bloque',
    description: 'Pasada 2: los movimientos de un bloque de páginas, con página y fragmento citado.',
    model: EXTRACTION,
    variables: ['first_page', 'last_page', 'accounts'],
  },
  extract_retry_page: {
    version: 1,
    title: 'Extracción: reintento de una página',
    description: 'Vuelve a leer una página cuyo saldo corrido no cuadra, con el problema detectado.',
    model: 'claude-opus-5-5 (doble lectura)',
    variables: ['page', 'accounts', 'problem'],
  },
  classify_document: {
    version: 2,
    title: 'Clasificación del documento',
    description: 'Tipo de documento, banco, legibilidad del texto y texto dirigido a un sistema automatizado. Respaldo de Jev o lectura por visión.',
    model: HAIKU,
    variables: ['banks', 'text_sample'],
  },
  classify_transactions: {
    version: 1,
    title: 'Clasificación de movimientos',
    description: 'Categoría de los movimientos que las reglas no resuelven, en lotes, cuando no hay Jev.',
    model: HAIKU,
    variables: ['bank', 'rows'],
  },
  explain_decision: {
    version: 2,
    title: 'Explicación del resultado',
    description: 'Tres a cinco oraciones para el analista sobre el resultado de una solicitud. Pasa por el filtro de cifras.',
    model: HAIKU,
    variables: ['decision'],
  },
  next_steps: {
    version: 1,
    title: 'Siguientes pasos',
    description: 'Qué cambiaría el resultado, redactado desde los contrafactuales del motor. Pasa por el filtro de cifras.',
    model: HAIKU,
    variables: ['steps'],
  },
  clarification_questions: {
    version: 1,
    title: 'Preguntas de aclaración',
    description: 'Redacción de las preguntas al proveedor desde un borrador correcto. Pasa por el filtro de cifras.',
    model: HAIKU,
    variables: ['questions'],
  },
  interpret_whatsapp_reply: {
    version: 1,
    title: 'Respuestas por WhatsApp',
    description: 'Clasifica una respuesta del proveedor que las reglas no leen y propone el dato; el lector determinista lo valida.',
    model: HAIKU,
    variables: ['field', 'question', 'options', 'today', 'message'],
  },
} as const satisfies Record<string, CatalogEntry>

export type PromptName = keyof typeof PROMPT_CATALOG
export const PROMPT_NAMES = Object.keys(PROMPT_CATALOG) as [PromptName, ...PromptName[]]
export const PromptNameSchema = z.enum(PROMPT_NAMES)

export function promptCatalogEntry(name: PromptName): CatalogEntry {
  return PROMPT_CATALOG[name]
}

/** Stable id of a file version: `extract_summary.v2`. Traces and cache store this one. */
export function filePromptId(name: string, fileVersion: number): string {
  return `${name}.v${String(fileVersion)}`
}

/**
 * Id of a version created in the backoffice: database number plus text fingerprint
 * (`extract_summary.db3-1a2b3c4d`). The fingerprint keeps two different texts from sharing an id
 * or cache key.
 */
export function dbPromptId(name: string, version: number, sha256: string): string {
  return `${name}.db${String(version)}-${sha256.slice(0, 8)}`
}

/**
 * Splits the leading metadata block (HTML comment) from the text sent to the model. The text is
 * returned trimmed.
 */
export function splitPromptFile(raw: string): { header: Record<string, string>; body: string } {
  const m = /^<!--([\s\S]*?)-->\s*/.exec(raw)
  const header: Record<string, string> = {}
  if (m?.[1]) {
    for (const line of m[1].split('\n')) {
      const kv = /^\s*([a-z_]+):\s*(.*)$/.exec(line)
      if (kv?.[1] && kv[2] !== undefined) header[kv[1]] = kv[2].trim()
    }
  }
  return { header, body: (m ? raw.slice(m[0].length) : raw).trim() }
}

/** `{{name}}` variables a text uses, deduplicated, in order of appearance. */
export function promptPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) if (m[1] && !out.includes(m[1])) out.push(m[1])
  return out
}

/** Variables in a text that the code does not pass to that prompt. */
export function unknownPlaceholders(name: PromptName, text: string): string[] {
  const allowed: readonly string[] = PROMPT_CATALOG[name].variables
  return promptPlaceholders(text).filter((v) => !allowed.includes(v))
}

/** Replaces `{{name}}`; a variable without a value is an error (the prompt would be incomplete). */
export function renderPrompt(id: string, template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key]
    if (v === undefined) throw new Error(`el prompt ${id} usa {{${key}}} y no se le pasó`)
    return String(v)
  })
}

export type DiffOp = 'same' | 'add' | 'del'
export interface DiffLine {
  op: DiffOp
  text: string
}

/**
 * Line diff (longest common subsequence). Prompts have hundreds of lines, not thousands, so the
 * quadratic table is fine.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[]
    const next = lcs[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] as string })
      i++
      j++
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ op: 'del', text: a[i++] as string })
    } else {
      out.push({ op: 'add', text: b[j++] as string })
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] as string })
  while (j < m) out.push({ op: 'add', text: b[j++] as string })
  return out
}

// ---- Backoffice API (`/bo/v1/prompts`) ----

export const PromptVersionSource = z.enum(['file', 'backoffice']).describe('file: sembrada desde prompts/ (pasa por el changelog y las evals del repositorio); backoffice: creada en el backoffice, sin evals')
export type PromptVersionSource = z.infer<typeof PromptVersionSource>

export const PromptVersionItem = z.strictObject({
  id: z.uuid(),
  version: z.int().positive().describe('Número de versión en la base, consecutivo por prompt'),
  prompt_id: z.string().describe('Id que queda en las trazas y en la llave de caché: `nombre.vN` para un archivo, `nombre.dbN-huella` para el backoffice'),
  source: PromptVersionSource,
  file_version: z.int().positive().nullable().describe('N de prompts/<nombre>.vN.md; null si se creó en el backoffice'),
  note: z.string().describe('Qué cambió'),
  sha256: z.string(),
  text: z.string(),
  created_by: z.string().nullable().describe('Correo de quien la creó; null si vino de la siembra'),
  created_at: z.string(),
  active: z.boolean(),
  is_code_default: z.boolean().describe('Es la versión de archivo que usa el código sin base (modo standalone y evals)'),
})
export type PromptVersionItem = z.infer<typeof PromptVersionItem>

export const PromptSummary = z.strictObject({
  name: PromptNameSchema,
  title: z.string(),
  description: z.string(),
  model: z.string(),
  variables: z.array(z.string()),
  code_default_file_version: z.int().positive(),
  versions: z.int(),
  active: z
    .strictObject({
      id: z.uuid(),
      version: z.int(),
      prompt_id: z.string(),
      source: PromptVersionSource,
      is_code_default: z.boolean(),
      activated_at: z.string().nullable(),
      activated_by: z.string().nullable(),
    })
    .nullable(),
})
export type PromptSummary = z.infer<typeof PromptSummary>

export const PromptCatalogResponse = z.strictObject({
  can_edit: z.boolean().describe('Quien consulta puede crear y activar versiones (los prompts son globales)'),
  prompts: z.array(PromptSummary),
})
export type PromptCatalogResponse = z.infer<typeof PromptCatalogResponse>

export const PromptDetail = PromptSummary.extend({
  can_edit: z.boolean(),
  items: z.array(PromptVersionItem).describe('Versiones de la más nueva a la más vieja'),
})
export type PromptDetail = z.infer<typeof PromptDetail>

export const PromptVersionCreateBody = z.strictObject({
  text: z.string().trim().min(1, 'el prompt no puede quedar vacío').max(100_000, 'el prompt pasa de 100,000 caracteres'),
  note: z.string().trim().min(3, 'escribe qué cambió').max(500),
})
export type PromptVersionCreateBody = z.infer<typeof PromptVersionCreateBody>

export const PromptDiffQuery = z.strictObject({ from: z.uuid(), to: z.uuid() })
export type PromptDiffQuery = z.infer<typeof PromptDiffQuery>

export const PromptDiff = z.strictObject({
  name: PromptNameSchema,
  from: z.strictObject({ id: z.uuid(), version: z.int() }),
  to: z.strictObject({ id: z.uuid(), version: z.int() }),
  added: z.int(),
  removed: z.int(),
  lines: z.array(z.strictObject({ op: z.enum(['same', 'add', 'del']), text: z.string() })),
})
export type PromptDiff = z.infer<typeof PromptDiff>

export const PromptActivated = z.strictObject({
  name: PromptNameSchema,
  id: z.uuid(),
  version: z.int(),
  previous_version: z.int().nullable(),
})
export type PromptActivated = z.infer<typeof PromptActivated>
