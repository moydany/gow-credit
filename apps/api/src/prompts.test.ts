/**
 * Prompts en el backoffice (ADR 0065) contra Postgres real: lista y detalle sembrados desde prompts/,
 * permiso de edición (lista de editores o, sin ella, una sola institución crediticia), versión nueva
 * inmutable con validación de variables, comparación, activación global con bitácora y lo que el
 * worker carga después.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptActivated, PromptCatalogResponse, PromptDetail, PromptDiff, PromptVersionItem } from '@gow/contracts'
import { connect, loadActivePrompts, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { clearActivePrompts, loadPrompt, setActivePrompts } from '@gow/llm'
import { LocalDocumentStorage, startQueue, type PgBoss } from '@gow/platform'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { createTenant } from './admin.ts'
import { createApp, type ApiDeps } from './app.ts'
import { issueToken } from './session.ts'

const available = await postgresAvailable()
const SECRET = 'secreto-de-pruebas-de-prompts-0000'

interface Harness {
  tdb: TestDatabase
  admin: pg.Client
  adminDb: Database
  apiDb: Database
  boss: PgBoss
  servers: Server[]
}

async function listen(deps: ApiDeps): Promise<{ server: Server; base: string }> {
  const server = createServer(createApp(deps))
  server.listen(0)
  await new Promise((r) => server.once('listening', r))
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }
}

async function start(): Promise<Harness> {
  const tdb = await createTestDatabase()
  const admin = new pg.Client({ connectionString: tdb.url('admin') })
  await admin.connect()
  const adminDb = connect(tdb.url('admin'))
  const apiDb = connect(tdb.url('api'))
  const boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
  return { tdb, admin, adminDb, apiDb, boss, servers: [] }
}

async function stop(h: Harness): Promise<void> {
  for (const s of h.servers) await new Promise((r) => s.close(r))
  await h.boss.stop({ graceful: false })
  await h.admin.end()
  await h.apiDb.close()
  await h.adminDb.close()
  await h.tdb.drop()
}

/** Cliente con sesión de un usuario del backoffice contra un servidor. */
async function session(base: string, user: { id: string; tenant: string; email: string }) {
  const raw = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = { 'x-gow-backoffice': '1' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}/bo/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as unknown }
  }
  const login = await raw('POST', '/session', { token: issueToken(SECRET, { sub: user.id, email: user.email, tenant_id: user.tenant }, 600) })
  expect(login.status).toBe(200)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const send = (method: string, path: string, body?: unknown) => raw(method, path, body, cookie)
  /** Respuesta exitosa validada contra su contrato Zod. */
  const typed = async <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const r = await send(method, path, body)
    return { status: r.status, json: schema.parse(r.json) }
  }
  return { send, get: <T>(schema: z.ZodType<T>, path: string) => typed(schema, 'GET', path), post: <T>(schema: z.ZodType<T>, path: string, body?: unknown) => typed(schema, 'POST', path, body) }
}

describe.skipIf(!available)('Prompts en el backoffice (necesita el Postgres de docker compose)', () => {
  let h: Harness
  let editorA: Awaited<ReturnType<typeof session>>
  let viewerA: Awaited<ReturnType<typeof session>>
  let viewerB: Awaited<ReturnType<typeof session>>
  let tenantA = ''

  beforeAll(async () => {
    h = await start()
    tenantA = (await createTenant(h.adminDb.db, { name: 'Fintech A' })).tenantId
    const tenantB = (await createTenant(h.adminDb.db, { name: 'Fintech B' })).tenantId
    const users = { editor: randomUUID(), viewer: randomUUID(), b: randomUUID() }
    await h.admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3), ($1, $4, $5), ($6, $7, $8)', [tenantA, users.editor, 'editora@a.test', users.viewer, 'analista@a.test', tenantB, users.b, 'b@b.test'])
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-prompts-')), secret: 'firma-local', publicBaseUrl: 'http://127.0.0.1' })
    const { server, base } = await listen({ db: h.apiDb.db, boss: h.boss, storage, backofficeJwtSecret: SECRET, promptEditors: ['editora@a.test'] })
    h.servers.push(server)
    editorA = await session(base, { id: users.editor, tenant: tenantA, email: 'editora@a.test' })
    viewerA = await session(base, { id: users.viewer, tenant: tenantA, email: 'analista@a.test' })
    viewerB = await session(base, { id: users.b, tenant: tenantB, email: 'b@b.test' })
  }, 60_000)

  afterAll(async () => {
    clearActivePrompts()
    await stop(h)
  })

  it('lista los prompts del catálogo sembrados desde prompts/, activos en la versión del código', async () => {
    const r = await viewerA.get(PromptCatalogResponse, '/prompts')
    expect(r.status).toBe(200)
    expect(r.json.can_edit).toBe(false)
    const summary = r.json.prompts.find((p) => p.name === 'extract_summary')
    expect(summary).toMatchObject({ code_default_file_version: 2, versions: 2, variables: ['page_count'], active: { version: 2, prompt_id: 'extract_summary.v2', source: 'file', is_code_default: true, activated_by: null } })
    expect((await editorA.get(PromptCatalogResponse, '/prompts')).json.can_edit).toBe(true)
  })

  it('quien no es editor no crea ni activa versiones', async () => {
    const r = await viewerA.send('POST', '/prompts/next_steps/versions', { text: 'Pasos {{steps}}', note: 'prueba' })
    expect(r.status).toBe(403)
    const detail = await viewerA.get(PromptDetail, '/prompts/next_steps')
    expect((await viewerA.send('POST', `/prompts/next_steps/versions/${detail.json.items[0]?.id ?? ''}/activate`)).status).toBe(403)
  })

  it('valida la versión nueva: variables que el código no pasa, nota vacía, texto repetido y prompt inexistente', async () => {
    const unknown = await editorA.send('POST', '/prompts/extract_summary/versions', { text: 'Lee {{page_count}} páginas de {{banco}}.', note: 'prueba' })
    expect(unknown.status).toBe(400)
    expect((unknown.json as { issues: { message: string }[] }).issues[0]?.message).toMatch(/\{\{banco\}\}.*\{\{page_count\}\}/)
    expect((await editorA.send('POST', '/prompts/extract_summary/versions', { text: 'Lee {{page_count}} páginas.', note: '' })).status).toBe(400)
    const detail = await editorA.get(PromptDetail, '/prompts/extract_summary')
    const v2 = detail.json.items.find((i) => i.version === 2)
    const dup = await editorA.send('POST', '/prompts/extract_summary/versions', { text: v2?.text, note: 'copia' })
    expect(dup).toMatchObject({ status: 409, json: { error: 'ese texto ya es la versión v2' } })
    expect((await editorA.send('GET', '/prompts/no_existe')).status).toBe(404)
  })

  it('crea una versión inmutable sin activarla, la compara y la activa para todas las instituciones', async () => {
    const before = await editorA.get(PromptDetail, '/prompts/extract_summary')
    const v2 = before.json.items.find((i) => i.version === 2)
    if (!v2) throw new Error('falta v2')
    const text = `${v2.text}\nNo inventes movimientos.`
    const created = await editorA.post(PromptVersionItem, '/prompts/extract_summary/versions', { text, note: 'regla contra invención' })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ version: 3, source: 'backoffice', file_version: null, active: false, is_code_default: false, created_by: 'editora@a.test', note: 'regla contra invención' })
    expect(created.json.prompt_id).toMatch(/^extract_summary\.db3-[0-9a-f]{8}$/)

    const diff = await viewerA.get(PromptDiff, `/prompts/extract_summary/diff?from=${v2.id}&to=${created.json.id}`)
    expect(diff.json).toMatchObject({ from: { version: 2 }, to: { version: 3 }, added: 1, removed: 0 })
    expect(diff.json.lines.filter((l) => l.op === 'add')).toEqual([{ op: 'add', text: 'No inventes movimientos.' }])
    expect((await viewerA.send('GET', `/prompts/extract_summary/diff?from=${v2.id}&to=${randomUUID()}`)).status).toBe(404)

    const activated = await editorA.post(PromptActivated, `/prompts/extract_summary/versions/${created.json.id}/activate`)
    expect(activated).toMatchObject({ status: 200, json: { version: 3, previous_version: 2 } })
    // Global: la otra institución ve la misma versión activa.
    const seenByB = await viewerB.get(PromptCatalogResponse, '/prompts')
    expect(seenByB.json.prompts.find((p) => p.name === 'extract_summary')?.active).toMatchObject({ version: 3, source: 'backoffice', activated_by: 'editora@a.test' })

    // Bitácora del tenant de quien cambió, sin el texto.
    const log = await h.admin.query<{ action: string; subject: string; details: Record<string, unknown> }>("SELECT action, subject, details FROM app.audit_log WHERE tenant_id = $1 AND action LIKE 'prompt.%' ORDER BY at", [tenantA])
    expect(log.rows).toEqual([
      { action: 'prompt.version_created', subject: 'extract_summary', details: { version: 3, prompt_id: created.json.prompt_id } },
      { action: 'prompt.activated', subject: 'extract_summary', details: { version: 3, previous_version: 2, prompt_id: created.json.prompt_id, source: 'backoffice' } },
    ])

    // Lo que el worker carga: la versión activa con su id de huella.
    const worker = connect(h.tdb.url('worker'))
    try {
      setActivePrompts(await loadActivePrompts(worker.db))
      expect(loadPrompt('extract_summary', { page_count: 3 })).toMatchObject({ id: created.json.prompt_id, source: 'db' })
      expect(loadPrompt('extract_system')).toMatchObject({ id: 'extract_system.v1' })
    } finally {
      clearActivePrompts()
      await worker.close()
    }

    // Volver a la de archivo: también es una activación.
    expect((await editorA.send('POST', `/prompts/extract_summary/versions/${v2.id}/activate`)).json).toMatchObject({ version: 2, previous_version: 3 })
  })

  it('una versión de otro prompt no se activa por la ruta equivocada', async () => {
    const other = await editorA.get(PromptDetail, '/prompts/next_steps')
    expect((await editorA.send('POST', `/prompts/extract_summary/versions/${other.json.items[0]?.id ?? ''}/activate`)).status).toBe(404)
  })
})

describe.skipIf(!available)('Prompts sin BACKOFFICE_PROMPT_EDITORS (necesita el Postgres de docker compose)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await start()
  }, 60_000)

  afterAll(async () => {
    await stop(h)
  })

  it('con una sola institución crediticia sus usuarios editan; con dos, nadie', async () => {
    const a = (await createTenant(h.adminDb.db, { name: 'Única' })).tenantId
    const user = randomUUID()
    await h.admin.query('INSERT INTO app.tenant_users (tenant_id, user_id, email) VALUES ($1, $2, $3)', [a, user, 'duena@unica.test'])
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-prompts-')), secret: 'firma-local', publicBaseUrl: 'http://127.0.0.1' })
    const { server, base } = await listen({ db: h.apiDb.db, boss: h.boss, storage, backofficeJwtSecret: SECRET })
    h.servers.push(server)
    const owner = await session(base, { id: user, tenant: a, email: 'duena@unica.test' })
    expect((await owner.get(PromptCatalogResponse, '/prompts')).json.can_edit).toBe(true)
    await createTenant(h.adminDb.db, { name: 'Segunda' })
    expect((await owner.get(PromptCatalogResponse, '/prompts')).json.can_edit).toBe(false)
    expect((await owner.send('POST', '/prompts/next_steps/versions', { text: 'Pasos {{steps}}', note: 'prueba' })).status).toBe(403)
  })
})
