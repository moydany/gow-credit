/**
 * `full` mode of a scenario: the real system end to end on a fresh database in the docker compose
 * Postgres. The API (Express), queue (pg-boss), worker (Mastra workflow with state in Postgres)
 * and WhatsApp relay run; only the external parts are simulated:
 * - external sources: doubles fed with the YAML data;
 * - the supplier's phone: a transport that receives messages and answers the script;
 * - models: the fixed per-hash cache (data/llm-cache, or the versioned injection-eval one); never
 *   a paid call. Movements by rules only, wording from templates.
 * Synthetic statements are uploaded as a `.synthetic.json` document, which only the scenarios'
 * API and worker accept.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp, createTenant } from '@gow/api'
import { SimulatedTransport } from '@gow/channels'
import { Decision, StatementExtraction, type Policy, type Scenario, type ScenarioSupplier, type SupplierIdentity } from '@gow/contracts'
import { connect } from '@gow/db'
import { createTestDatabase } from '@gow/db/testing'
import { buildLedger, gatherExternal, simulatedPorts } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { ADVERSARIAL_CASES, adversarialPdf } from '@gow/evals/adversarial'
import { CachedClassifier, CachingStructuredLlm, createLimiter, ZERO_USAGE, type Classification, type Classifier } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage, startQueue } from '@gow/platform'
import { deliverPending, storeIncoming, type WhatsAppTransport } from '@gow/whatsapp'
import { startWorker, type SyntheticDocument } from '@gow/worker'
import { PostgresStore } from '@mastra/pg'
import pg from 'pg'
import { checkDecision, type Check } from './checks.ts'

const REPO = resolve(import.meta.dirname, '../..')
const TRANSIENT = new Set(['received', 'extracting', 'extracted', 'deciding'])
const STRANGER_DEFAULT = '+5215599990009'

export interface FullResult {
  scenario: Scenario
  skipped: string | null
  applicationStatus: string | null
  decision: Decision | null
  checks: Check[]
  ok: boolean
}

export type PolicyLoader = (ref: string) => { id: string; policy: Policy }

/** The supplier's phone in the scenario: stores what it receives. */
class ScenarioPhone implements WhatsAppTransport {
  readonly inbox = new SimulatedTransport('whatsapp')
  start(): Promise<void> {
    return Promise.resolve()
  }
  async send(to: string, text: string): Promise<void> {
    await this.inbox.send({ id: randomUUID(), channel: 'whatsapp', destination: to, body: text })
  }
  stop(): Promise<void> {
    return Promise.resolve()
  }
}

/** Document classifier from the cache; if absent, a fixed label (the label doesn't change the extraction). */
function scenarioClassifier(dir: string): Classifier {
  const cached = new CachedClassifier(process.env.TYPESAFE_API_KEY ? 'jev' : 'haiku', null, dir)
  const fixed: Classification = { documentType: 'bank_statement', confidence: 1, bank: 'other', textIsReadable: true, containsInstructionsToAi: false, implementation: 'claude', model: 'scenario', fallback: false, usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, promptId: null, responseCacheHit: true }
  return { classify: (input) => cached.classify(input).catch(() => fixed) }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== null) return v
    if (Date.now() > end) throw new Error(`tiempo agotado esperando ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

function documentBytes(name: string, devDir: string): Buffer | null {
  if (name.startsWith('adversarial:')) {
    const c = ADVERSARIAL_CASES.find((x) => x.id === name.slice('adversarial:'.length))
    return c ? adversarialPdf(c) : null
  }
  const path = join(devDir, name)
  return existsSync(path) ? readFileSync(path) : null
}

export async function runFull(scenario: Scenario, loadPolicy: PolicyLoader, opts: { devDir?: string } = {}): Promise<FullResult> {
  const devDir = opts.devDir ?? join(REPO, 'data/dev')
  const expect = scenario.expect
  const sup = scenario.suppliers.find((s) => s.id === (expect.supplier ?? scenario.suppliers[0]?.id)) as ScenarioSupplier
  const skip = (reason: string): FullResult => ({ scenario, skipped: reason, applicationStatus: null, decision: null, checks: [], ok: true })
  if (sup.documents.length + sup.statements.length !== 1) throw new Error(`${scenario.id}: en modo full, una solicitud lleva un documento`)
  const docName = sup.documents[0] ?? null
  const pdf = docName ? documentBytes(docName, devDir) : null
  if (docName && !pdf) return skip(`falta ${docName} (data/dev no se versiona; scripts/download-dev-data.sh)`)
  const adversarial = docName?.startsWith('adversarial:') ?? false
  const llmCache = adversarial ? join(REPO, 'evals/fixtures/llm-cache') : join(REPO, 'data/llm-cache')
  const classifierCache = adversarial ? join(REPO, 'evals/fixtures/classifier-cache') : join(REPO, 'data/llm-cache/classifier')

  const tdb = await createTestDatabase('gow_scn')
  const adminDb = connect(tdb.url('admin'), { max: 2 })
  const apiDb = connect(tdb.url('api'))
  const workerDb = connect(tdb.url('worker'))
  const waDb = connect(tdb.url('whatsapp'), { max: 1 })
  const admin = new pg.Client({ connectionString: tdb.url('admin') })
  await admin.connect()
  const store = new PostgresStore({ id: `gow-scn-${scenario.id}`, connectionString: tdb.url('mastra'), schemaName: 'mastra' })
  const boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
  const server = createServer()
  server.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-scn-')), secret: randomUUID(), publicBaseUrl: base })
  server.on('request', createApp({ db: apiDb.db, boss, storage, allowSynthetic: true }))
  const llm = new CachingStructuredLlm(null, llmCache, 'read')
  const identity: SupplierIdentity = { legal_name: sup.name, rfc: sup.rfc, clabes: sup.clabes }
  const worker = await startWorker(
    {
      db: workerDb.db,
      mastraStore: store,
      storage,
      llm,
      documentClassifier: scenarioClassifier(classifierCache),
      transactionClassifier: null,
      writer: new Writer(llm),
      limit: createLimiter(2),
      googleAvailable: true,
      transports: {},
      external: async (ctx, state) => {
        const ledger = buildLedger(state.statements, { request: state.input.request, minConfidence: 0.7 })
        const rfcs = [...new Set(ledger.rows.map((r) => r.classification.counterparty_rfc).filter((r): r is string => r !== null))]
        return gatherExternal(simulatedPorts(scenario.external, { asOf: scenario.as_of }), { supplierId: ctx.supplier.externalRef ?? '', supplier: identity, request: state.input.request, statements: state.statements }, rfcs)
      },
      synthetic: (d: SyntheticDocument) => syntheticStatement(d.input, d.holder, d.seed),
      today: () => scenario.as_of,
      logger: { info: () => undefined, error: () => undefined },
    },
    boss,
    { sweepMs: 150, pollingSeconds: 0.5 },
  )

  const checks: Check[] = []
  const phone = new ScenarioPhone()
  try {
    // ---------- Tenant onboarding (scenario 1): policy, number, key; suppliers with contacts.
    const { policy } = loadPolicy(scenario.tenant.policy)
    const tenant = await createTenant(adminDb.db, { name: scenario.tenant.name, whatsappNumber: scenario.tenant.whatsapp_number ?? null, policy })
    const call = async (method: string, path: string, body?: unknown, key = tenant.apiKey) => {
      const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const text = await res.text()
      return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
    }
    const created = await call('POST', '/v1/suppliers', { external_ref: sup.id, legal_name: sup.name, rfc: sup.rfc, clabes: sup.clabes, contacts: sup.contacts.map((c) => ({ channel: c.channel, address: c.address, verified_by_kyc: c.verified })) })
    if (created.status !== 201) throw new Error(`alta de proveedor: ${String(created.status)}`)

    // ---------- Document by signed URL and request.
    const synthetic = sup.statements[0]
    const bytes = synthetic ? Buffer.from(JSON.stringify({ input: synthetic, holder: { name: sup.name, rfc: sup.rfc, clabe: sup.clabes[0] ?? null }, seed: `${scenario.id}-${sup.id}-0` } satisfies SyntheticDocument)) : (pdf as Buffer)
    const up = await call('POST', '/v1/uploads', { synthetic: synthetic !== undefined })
    const put = await fetch(String(up.json.url), { method: 'PUT', body: new Uint8Array(bytes) })
    if (put.status !== 204) throw new Error(`subida: ${String(put.status)}`)
    const app = await call('POST', '/v1/applications', { supplier_id: created.json.id, document_path: up.json.path, request: sup.request, as_of: scenario.as_of })
    if (app.status !== 201) throw new Error(`solicitud: ${String(app.status)} ${JSON.stringify(app.json)}`)
    const appId = String(app.json.id)
    const settled = () => waitFor('el veredicto', async () => {
      const r = await call('GET', `/v1/applications/${appId}`)
      return TRANSIENT.has(String(r.json.status)) ? null : r.json
    })
    let view = await settled()

    // ---------- WhatsApp conversation: the phone receives and answers the script.
    const supplierPhone = sup.contacts.find((c) => c.channel === 'whatsapp' && c.verified)?.address ?? STRANGER_DEFAULT
    for (const step of scenario.conversation) {
      await deliverPending(waDb.db, tenant.tenantId, phone)
      const before = String(view.status)
      const inboundId = randomUUID()
      await storeIncoming(waDb.db, tenant.tenantId, { from: step.from ?? supplierPhone, id: inboundId, text: step.reply })
      const resolution = await waitFor('la resolución del mensaje', async () => {
        const r = await admin.query<{ resolution: string | null }>('SELECT resolution FROM app.inbound_messages WHERE external_id = $1 AND processed_at IS NOT NULL', [inboundId])
        return r.rows[0]?.resolution ?? null
      })
      if (resolution === 'completed') {
        view = await waitFor('la reanudación', async () => {
          const r = await call('GET', `/v1/applications/${appId}`)
          const s = String(r.json.status)
          return TRANSIENT.has(s) || (s === before && s === 'needs_clarification') ? null : r.json
        })
      }
    }
    await deliverPending(waDb.db, tenant.tenantId, phone)

    // ---------- What ended up in the database.
    const status = String(view.status)
    const d = await admin.query<{ payload: unknown }>("SELECT payload FROM app.decisions WHERE application_id = $1 AND kind = 'active' ORDER BY created_at DESC LIMIT 1", [appId])
    const decision = d.rows[0] ? Decision.parse(d.rows[0].payload) : null
    if (decision) checks.push(...checkDecision(decision, expect))
    else checks.push({ name: 'decision', ok: false, expected: expect.status, actual: `sin veredicto (${status})` })
    const full = expect.full
    if (full?.application_status !== undefined) checks.push({ name: 'application_status', ok: status === full.application_status, expected: full.application_status, actual: status })
    if (full?.inbound_resolutions !== undefined) {
      const r = await admin.query<{ resolution: string }>('SELECT resolution FROM app.inbound_messages ORDER BY received_at')
      const got = r.rows.map((x) => x.resolution)
      checks.push({ name: 'inbound_resolutions', ok: JSON.stringify(got) === JSON.stringify(full.inbound_resolutions), expected: full.inbound_resolutions, actual: got })
    }
    if (full?.extraction) {
      const e = full.extraction
      const r = await admin.query<{ payload: unknown }>('SELECT payload FROM app.extractions LIMIT 1')
      const ex = r.rows[0] ? StatementExtraction.parse(r.rows[0].payload) : null
      const txs = ex?.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions)) ?? []
      if (e.route !== undefined) checks.push({ name: 'extraction.route', ok: ex?.document.route === e.route, expected: e.route, actual: ex?.document.route ?? null })
      if (e.transactions !== undefined) checks.push({ name: 'extraction.transactions', ok: txs.length === e.transactions, expected: e.transactions, actual: txs.length })
      for (const f of e.flags_include) checks.push({ name: `extraction.flag ${f}`, ok: ex?.flags.includes(f as never) ?? false, expected: f, actual: ex?.flags ?? [] })
      for (const amount of e.amounts_absent) checks.push({ name: `extraction.sin ${String(amount)}`, ok: !txs.some((t) => t.amount === amount), expected: 'ausente', actual: txs.filter((t) => t.amount === amount).length })
    }
    if (full?.isolated_from_other_tenant) {
      const other = await createTenant(adminDb.db, { name: 'Otro prestamista' })
      const seen = await call('GET', `/v1/applications/${appId}`, undefined, other.apiKey)
      const versions = await call('GET', '/v1/policies/versions', undefined, other.apiKey)
      checks.push({ name: 'aislado de otro tenant', ok: seen.status === 404 && (versions.json as unknown as unknown[]).length === 1, expected: '404 y solo su política', actual: `${String(seen.status)}, ${String((versions.json as unknown as unknown[]).length)} versiones` })
    }
    return { scenario, skipped: null, applicationStatus: status, decision, checks, ok: checks.every((c) => c.ok) }
  } finally {
    await worker.stop()
    await boss.stop({ graceful: false })
    await new Promise((r) => server.close(r))
    await store.close()
    await admin.end()
    for (const c of [waDb, workerDb, apiDb, adminDb]) await c.close()
    await tdb.drop()
  }
}
