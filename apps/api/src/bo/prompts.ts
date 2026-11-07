/**
 * Model prompts in the backoffice: list, detail with versions, comparison, new version and
 * activation. Prompts are global (the same for all lenders): every user sees them, but only
 * those listed in `BACKOFFICE_PROMPT_EDITORS` can create and activate versions, or, without that
 * variable, any user of a single-lender install (the local demo). Each change is logged to the
 * acting user's tenant audit log, without the prompt text.
 */
import { createHash } from 'node:crypto'
import { promptVersions, prompts, withTenant, type Tx } from '@gow/db'
import {
  dbPromptId,
  filePromptId,
  lineDiff,
  PROMPT_CATALOG,
  PROMPT_NAMES,
  PromptDiffQuery,
  PromptNameSchema,
  PromptVersionCreateBody,
  unknownPlaceholders,
  type PromptActivated,
  type PromptCatalogResponse,
  type PromptDetail,
  type PromptDiff,
  type PromptName,
  type PromptSummary,
  type PromptVersionItem,
} from '@gow/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, iso, uniqueViolation, who, type BackofficeDeps, type Who } from './shared.ts'

/** `*`: any user; list of emails; null: only on a single-lender install. */
export type PromptEditors = '*' | readonly string[] | null

/** `BACKOFFICE_PROMPT_EDITORS`: empty → null; `*` → everyone; otherwise comma-separated emails. */
export function parsePromptEditors(raw: string | undefined): PromptEditors {
  const v = raw?.trim()
  if (!v) return null
  if (v === '*') return '*'
  return v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
}

type VersionRow = typeof promptVersions.$inferSelect

const NOT_FOUND = 'prompt no encontrado'

function promptIdOf(v: Pick<VersionRow, 'promptName' | 'source' | 'fileVersion' | 'version' | 'sha256'>): string {
  return v.source === 'file' && v.fileVersion !== null ? filePromptId(v.promptName, v.fileVersion) : dbPromptId(v.promptName, v.version, v.sha256)
}

const isCodeDefault = (v: Pick<VersionRow, 'promptName' | 'source' | 'fileVersion'>) => v.source === 'file' && v.fileVersion === PROMPT_CATALOG[v.promptName as PromptName].version

function itemOf(v: VersionRow, activeId: string | null): PromptVersionItem {
  return {
    id: v.id,
    version: v.version,
    prompt_id: promptIdOf(v),
    source: v.source === 'file' ? 'file' : 'backoffice',
    file_version: v.fileVersion,
    note: v.note,
    sha256: v.sha256,
    text: v.text,
    created_by: v.createdByEmail,
    created_at: v.createdAt.toISOString(),
    active: v.id === activeId,
    is_code_default: isCodeDefault(v),
  }
}

async function canEdit(deps: BackofficeDeps, w: Who): Promise<boolean> {
  const editors = deps.promptEditors ?? null
  if (editors === '*') return true
  if (editors !== null) return editors.includes(w.email.toLowerCase())
  // With a single lender, it is the user's (the session already verified membership).
  const r = await deps.db.execute<{ single: boolean }>(sql`select app.single_tenant_installation() as single`)
  return r.rows[0]?.single === true
}

async function requireEditor(deps: BackofficeDeps, w: Who): Promise<void> {
  if (!(await canEdit(deps, w))) throw new HttpError(403, 'los prompts son globales: solo los editores de prompts pueden cambiarlos (BACKOFFICE_PROMPT_EDITORS)')
}

/** Summary of each prompt in the catalog, seeded or not. */
async function summaries(deps: BackofficeDeps): Promise<PromptSummary[]> {
  const rows = await deps.db.select().from(prompts)
  const versions = await deps.db.select().from(promptVersions)
  return PROMPT_NAMES.map((name) => {
    const c = PROMPT_CATALOG[name]
    const p = rows.find((x) => x.name === name)
    const mine = versions.filter((v) => v.promptName === name)
    const a = mine.find((v) => v.id === p?.activeVersionId)
    return {
      name,
      title: c.title,
      description: c.description,
      model: c.model,
      variables: [...c.variables],
      code_default_file_version: c.version,
      versions: mine.length,
      active: a ? { id: a.id, version: a.version, prompt_id: promptIdOf(a), source: a.source === 'file' ? 'file' : 'backoffice', is_code_default: isCodeDefault(a), activated_at: iso(p?.activatedAt ?? null), activated_by: p?.activatedBy ?? null } : null,
    } satisfies PromptSummary
  })
}

async function detail(deps: BackofficeDeps, name: PromptName, editable: boolean): Promise<PromptDetail> {
  const summary = (await summaries(deps)).find((s) => s.name === name)
  if (!summary) throw new HttpError(404, NOT_FOUND)
  const rows = await deps.db.select().from(promptVersions).where(eq(promptVersions.promptName, name)).orderBy(desc(promptVersions.version))
  return { ...summary, can_edit: editable, items: rows.map((v) => itemOf(v, summary.active?.id ?? null)) }
}

/** Locks the prompt row: serializes new versions and activations of the same prompt. */
async function lockPrompt(tx: Tx, name: PromptName) {
  const [p] = await tx.select().from(prompts).where(eq(prompts.name, name)).for('update')
  if (!p) throw new HttpError(409, 'el prompt aún no está en la base: corre pnpm db:migrate')
  return p
}

/** Inserts the next version with the prompt locked; the same text as another version is a 409. */
async function createVersion(deps: BackofficeDeps, w: Who, name: PromptName, body: PromptVersionCreateBody): Promise<PromptVersionItem> {
  const sha256 = createHash('sha256').update(body.text).digest('hex')
  try {
    return await withTenant(deps.db, w.tenantId, async (tx) => {
      const p = await lockPrompt(tx, name)
      const existing = await tx.select({ id: promptVersions.id, version: promptVersions.version, sha256: promptVersions.sha256 }).from(promptVersions).where(eq(promptVersions.promptName, name))
      const same = existing.find((v) => v.sha256 === sha256)
      if (same) throw new HttpError(409, `ese texto ya es la versión v${String(same.version)}`)
      const version = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1
      const [row] = await tx.insert(promptVersions).values({ promptName: name, version, source: 'backoffice', fileVersion: null, text: body.text, sha256, note: body.note, createdBy: actorOf(w), createdByEmail: w.email }).returning()
      if (!row) throw new HttpError(500, 'no se creó la versión')
      // No text: the audit log stores no content.
      await audit(tx, w.tenantId, actorOf(w), 'prompt.version_created', name, { version, prompt_id: promptIdOf(row) })
      return itemOf(row, p.activeVersionId)
    })
  } catch (e) {
    if (uniqueViolation(e)) throw new HttpError(409, 'otra persona creó una versión al mismo tiempo; vuelve a intentar')
    throw e
  }
}

export function promptsRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  const nameOf = (raw: string | string[] | undefined): PromptName => {
    const n = PromptNameSchema.safeParse(raw)
    if (!n.success) throw new HttpError(404, NOT_FOUND)
    return n.data
  }

  r.get('/prompts', async (_req, res) => {
    const out: PromptCatalogResponse = { can_edit: await canEdit(deps, who(res)), prompts: await summaries(deps) }
    res.json(out)
  })

  r.get('/prompts/:name', async (req, res) => {
    const name = nameOf(req.params.name)
    res.json(await detail(deps, name, await canEdit(deps, who(res))))
  })

  r.get('/prompts/:name/diff', async (req, res) => {
    const name = nameOf(req.params.name)
    const q = parse(PromptDiffQuery, { from: req.query.from, to: req.query.to })
    const rows = await deps.db.select().from(promptVersions).where(eq(promptVersions.promptName, name))
    const from = rows.find((v) => v.id === q.from)
    const to = rows.find((v) => v.id === q.to)
    if (!from || !to) throw new HttpError(404, 'versión no encontrada')
    const lines = lineDiff(from.text, to.text)
    const out: PromptDiff = {
      name,
      from: { id: from.id, version: from.version },
      to: { id: to.id, version: to.version },
      added: lines.filter((l) => l.op === 'add').length,
      removed: lines.filter((l) => l.op === 'del').length,
      lines,
    }
    res.json(out)
  })

  /** New, immutable version. It does not activate itself: activating is a separate, confirmed step. */
  r.post('/prompts/:name/versions', async (req, res) => {
    const w = who(res)
    const name = nameOf(req.params.name)
    await requireEditor(deps, w)
    const body = parse(PromptVersionCreateBody, req.body)
    const unknown = unknownPlaceholders(name, body.text)
    if (unknown.length) {
      throw new HttpError(400, 'el prompt usa variables que el código no le pasa', [{ path: 'text', message: `variables desconocidas: ${unknown.map((u) => `{{${u}}}`).join(', ')}; disponibles: ${PROMPT_CATALOG[name].variables.map((v) => `{{${v}}}`).join(', ') || 'ninguna'}` }])
    }
    res.status(201).json(await createVersion(deps, w, name, body))
  })

  r.post('/prompts/:name/versions/:id/activate', async (req, res) => {
    const w = who(res)
    const name = nameOf(req.params.name)
    const id = parse(z.uuid(), req.params.id)
    await requireEditor(deps, w)
    const out = await withTenant(deps.db, w.tenantId, async (tx) => {
      const p = await lockPrompt(tx, name)
      const [v] = await tx.select().from(promptVersions).where(eq(promptVersions.id, id))
      if (!v || v.promptName !== name) throw new HttpError(404, 'versión no encontrada')
      const [previous] = p.activeVersionId ? await tx.select({ version: promptVersions.version }).from(promptVersions).where(eq(promptVersions.id, p.activeVersionId)) : []
      const result: PromptActivated = { name, id: v.id, version: v.version, previous_version: previous?.version ?? null }
      if (p.activeVersionId === v.id) return result
      await tx.update(prompts).set({ activeVersionId: v.id, activatedAt: sql`now()`, activatedBy: w.email }).where(eq(prompts.name, name))
      await audit(tx, w.tenantId, actorOf(w), 'prompt.activated', name, { version: v.version, previous_version: result.previous_version, prompt_id: promptIdOf(v), source: v.source })
      return result
    })
    res.json(out)
  })

  return r
}
