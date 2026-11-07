/**
 * El worker contra Postgres real (docker compose), sin modelos: estado de cuenta sintético,
 * redacción con plantillas y Mastra con estado en el esquema `mastra`. Recorre el ciclo de
 * docs/02 §3: procesar → pausar con una aclaración por WhatsApp → respuesta → reanudar en otra
 * instancia de Mastra → veredicto. Y docs/05 §2b: un número ajeno no abre nada.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOCUMENT_REPLIES } from '@gow/channels'
import { multipleStatementsReason, notBankStatementReason, Question } from '@gow/contracts'
import { connect, withTenant, type Database } from '@gow/db'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { basePolicyTemplate } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { CachingStructuredLlm, createLimiter, type Classifier } from '@gow/llm'
import { Writer } from '@gow/mastra'
import { LocalDocumentStorage } from '@gow/platform'
import { PostgresStore } from '@mastra/pg'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbClarificationChannel } from './channel.ts'
import { resolveInbound } from './inbound.ts'
import { handleRedecide } from './redecide.ts'
import { startConfirmation } from './registration.ts'
import { loadContext, queueVerdict } from './store.ts'
import type { Interpretation, InterpretInput, MessageInterpreter } from './interpret.ts'
import { handleProcess, handleResume, SYNTHETIC_SUFFIX, type SyntheticDocument, type WorkerServices } from './worker.ts'

const available = await postgresAvailable()

const SUPPLIER_PHONE = '+5215511110001'
const STRANGER_PHONE = '+5215599990009'

const noClassifier: Classifier = { classify: () => Promise.reject(new Error('sin clasificador en esta prueba')) }

describe.skipIf(!available)('worker del modo full (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let admin: pg.Client
  let worker: Database
  let whatsapp: pg.Client
  let store: PostgresStore
  let services: WorkerServices
  const tenant = randomUUID()
  const supplierId = randomUUID()
  const applicationId = randomUUID()

  beforeAll(async () => {
    tdb = await createTestDatabase()
    admin = new pg.Client({ connectionString: tdb.url('admin') })
    await admin.connect()
    worker = connect(tdb.url('worker'))
    whatsapp = new pg.Client({ connectionString: tdb.url('whatsapp') })
    await whatsapp.connect()
    store = new PostgresStore({ id: 'gow-test', connectionString: tdb.url('mastra'), schemaName: 'mastra' })
    const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-wk-')), secret: 's', publicBaseUrl: 'http://x' })

    // Alta como administrador: tenant, política activa, proveedor con WhatsApp verificado, documento y solicitud.
    const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
    const doc: SyntheticDocument = {
      input: { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }, { kind: 'cash_deposit', amount: 150000 }] },
      holder,
      seed: 'wk1',
    }
    const path = `${tenant}/${randomUUID()}${SYNTHETIC_SUFFIX}`
    await storage.put(path, Buffer.from(JSON.stringify(doc)))
    const sha = syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256
    const policyId = randomUUID()
    const docId = randomUUID()
    await admin.query("INSERT INTO app.tenants (id, name, whatsapp_number) VALUES ($1, 'Fintech Demo', '+5215500000001')", [tenant])
    await admin.query("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policyId, tenant])
    await admin.query("INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document) VALUES ($1, $2, 1, 'active', $3)", [tenant, policyId, JSON.stringify(basePolicyTemplate())])
    await admin.query('INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, $3, $4)', [supplierId, tenant, holder.name, holder.rfc])
    await admin.query("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [tenant, supplierId, SUPPLIER_PHONE])
    await admin.query("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/json')", [docId, tenant, supplierId, path, sha])
    await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, request, as_of) VALUES ($1, $2, $3, $4, '2026-10-05')", [applicationId, tenant, supplierId, JSON.stringify({ amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } })])
    await admin.query('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [tenant, applicationId, docId])

    services = {
      db: worker.db,
      mastraStore: store,
      storage,
      llm: new CachingStructuredLlm(null, mkdtempSync(join(tmpdir(), 'gow-cache-')), 'read'),
      documentClassifier: noClassifier,
      transactionClassifier: null,
      writer: new Writer(null),
      limit: createLimiter(2),
      googleAvailable: false,
      transports: {},
      synthetic: (d) => syntheticStatement(d.input, d.holder, d.seed),
      logger: { info: () => undefined, error: () => undefined },
    }
  }, 60_000)

  afterAll(async () => {
    await whatsapp.end()
    await admin.end()
    await worker.close()
    await store.close()
    await tdb.drop()
  })

  /** Una foto o nota de voz tal como la guarda el proceso de WhatsApp: solo el tipo (ADR 0051). */
  async function inboundMedia(from: string, kind: string): Promise<string> {
    await whatsapp.query('BEGIN')
    await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    const r = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, media_kind) VALUES ($1, 'whatsapp', $2, '', $3) RETURNING id", [tenant, from, kind])
    await whatsapp.query('COMMIT')
    return r.rows[0]?.id ?? ''
  }

  async function inbound(from: string, body: string, attachment: Buffer | null = null): Promise<string> {
    await whatsapp.query('BEGIN')
    await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
    const r = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, attachment) VALUES ($1, 'whatsapp', $2, $3, $4) RETURNING id", [tenant, from, body, attachment])
    await whatsapp.query('COMMIT')
    return r.rows[0]?.id ?? ''
  }

  it('procesa, pausa y deja la pregunta en el buzón de WhatsApp del proveedor', async () => {
    expect(await handleProcess(services, { tenant_id: tenant, application_id: applicationId })).toBe('needs_clarification')
    const clar = await admin.query<{ status: string; channel: string; destination: string }>('SELECT status, channel, destination FROM app.clarifications WHERE application_id = $1', [applicationId])
    expect(clar.rows).toEqual([{ status: 'open', channel: 'whatsapp', destination: SUPPLIER_PHONE }])
    const out = await admin.query<{ destination: string; status: string; body: string }>("SELECT destination, status, body FROM app.outbound_messages WHERE tenant_id = $1 AND kind = 'question'", [tenant])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.destination).toBe(SUPPLIER_PHONE)
    expect(out.rows[0]?.body).toMatch(/Responde con el número:\n1\)/)
    const app = await admin.query<{ status: string; run_id: string | null }>('SELECT status, run_id FROM app.applications WHERE id = $1', [applicationId])
    expect(app.rows[0]).toMatchObject({ status: 'needs_clarification' })
    expect(app.rows[0]?.run_id).not.toBeNull()
    // Reintento del mismo trabajo: no repite nada.
    expect(await handleProcess(services, { tenant_id: tenant, application_id: applicationId })).toBe('needs_clarification')
    expect((await admin.query('SELECT 1 FROM app.clarifications WHERE application_id = $1', [applicationId])).rowCount).toBe(1)
  })

  it('un número sin vínculo que cita la solicitud recibe la respuesta fija y no abre nada', async () => {
    const id = await inbound(STRANGER_PHONE, `Respondo a la solicitud ${applicationId}: es pago de cliente`)
    expect(await resolveInbound(worker.db, tenant, id)).toEqual({ resolution: 'no_link', resume: null })
    const reply = await admin.query<{ kind: string; destination: string }>('SELECT kind, destination FROM app.outbound_messages WHERE destination = $1', [STRANGER_PHONE])
    expect(reply.rows).toEqual([{ kind: 'generic', destination: STRANGER_PHONE }])
    expect((await admin.query("SELECT status FROM app.clarifications WHERE application_id = $1 AND status = 'open'", [applicationId])).rowCount).toBe(1)
  })

  it('una respuesta ambigua se repregunta; la buena lleva al resumen, el sí completa la aclaración y la reanudación decide', async () => {
    const vague = await inbound(SUPPLIER_PHONE, 'hola, buenas tardes')
    expect((await resolveInbound(worker.db, tenant, vague)).resolution).toBe('unparsed')
    const good = await inbound(SUPPLIER_PHONE, '1')
    // Antes de evaluar, el resumen para confirmar (ADR 0051).
    expect(await resolveInbound(worker.db, tenant, good)).toEqual({ resolution: 'summary', resume: null })
    const summary = await admin.query<{ body: string }>("SELECT body FROM app.outbound_messages WHERE destination = $1 AND kind = 'summary'", [SUPPLIER_PHONE])
    expect(summary.rows[0]?.body).toMatch(/^Esto es lo que entendí:\n1\) abono de \$150,000\.00 pesos del \d+ de septiembre: Pago de un cliente o venta\n\n¿Es correcto\? Responde sí/)
    const r = await resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, 'Sí'))
    expect(r.resolution).toBe('completed')
    expect(r.resume?.application_id).toBe(applicationId)
    // Otra instancia de Mastra sobre el mismo store: es lo que hace el worker al tomar el trabajo.
    expect(await handleResume(services, r.resume ?? { tenant_id: tenant, application_id: applicationId, clarification_id: randomUUID() })).toBe('qualified_with_limit')
    const decisions = await admin.query<{ status: string }>('SELECT status FROM app.decisions WHERE application_id = $1 ORDER BY created_at', [applicationId])
    expect(decisions.rows.map((d) => d.status)).toEqual(['needs_clarification', 'qualified_with_limit'])
    expect((await admin.query('SELECT 1 FROM app.extractions WHERE tenant_id = $1', [tenant])).rowCount).toBe(1)
  })

  it('el veredicto final se avisa al WhatsApp verificado, con plantilla y sin datos del documento (ADR 0039)', async () => {
    const v = await admin.query<{ body: string; status: string }>("SELECT body, status FROM app.outbound_messages WHERE destination = $1 AND kind = 'verdict'", [SUPPLIER_PHONE])
    // Una sola vez: needs_clarification no avisa (ahí salió la pregunta); la reanudación sí.
    expect(v.rows).toHaveLength(1)
    expect(v.rows[0]?.body).toMatch(/^Revisamos tu factura de \$100,000\.00 pesos a Cadena Norte SA de CV\. Califica con un límite: podemos adelantarte hasta \$[\d,]+\.\d{2} pesos\./)
    expect(v.rows[0]?.body).not.toContain('DFI150304AB1')
  })

  it('una reanudación con una aclaración de otra solicitud no hace nada', async () => {
    const otherClar = randomUUID()
    expect(await handleResume(services, { tenant_id: tenant, application_id: applicationId, clarification_id: otherClar })).toBe('qualified_with_limit')
  })

  describe('aclaración por el chat: varias respuestas, resumen, correcciones y aviso del analista (ADR 0051)', () => {
    const PHONE = '+5215533330003'
    const supplier = randomUUID()
    const application = randomUUID()
    const clarification = randomUUID()
    const deposit = (id: string, amount: number, day: string) => ({
      id,
      topic: 'deposit_classification',
      kind: 'deposit',
      transaction: { document_sha256: 'b'.repeat(64), transaction_id: id },
      facts: [{ name: 'fecha', value: `2026-09-${day}` }, { name: 'monto', value: amount }, { name: 'concepto', value: 'DEPOSITO' }],
      options: [
        { value: 'customer_payment', label: 'Pago de un cliente o venta' },
        { value: 'loan_disbursement', label: 'Préstamo o crédito' },
        { value: 'own_transfer', label: 'Traspaso desde otra cuenta mía' },
        { value: 'interest', label: 'Intereses o rendimientos' },
        { value: 'other', label: 'Otra cosa' },
      ],
      text: '¿Qué fue este abono?',
      text_source: 'template',
    })
    const identity = { id: 'q4', topic: 'identity_fields', kind: 'identity', transaction: null, facts: [], options: [], text: 'Confirma la razón social y el RFC del titular.', text_source: 'template' }
    const say = async (body: string) => resolveInbound(worker.db, tenant, await inbound(PHONE, body))
    const last = async () => (await admin.query<{ body: string; kind: string }>('SELECT body, kind FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1', [PHONE])).rows[0] ?? { body: '', kind: '' }
    const row = async () => (await admin.query<{ step: string; status: string; current_question: number; answers: { question_id: string; kind: string; category?: string }[] }>('SELECT step, status, current_question, answers FROM app.clarifications WHERE id = $1', [clarification])).rows[0]

    beforeAll(async () => {
      await admin.query("INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, 'Abarrotes Tres SA de CV', 'ATR150304AB1')", [supplier, tenant])
      await admin.query("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [tenant, supplier, PHONE])
      await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'needs_clarification')", [application, tenant, supplier])
      const questions = [deposit('q1', 150000, '15'), deposit('q2', 30000, '20'), deposit('q3', 8000, '25'), identity]
      await admin.query("INSERT INTO app.clarifications (id, tenant_id, application_id, supplier_id, round, channel, destination, questions) VALUES ($1, $2, $3, $4, 1, 'whatsapp', $5, $6)", [clarification, tenant, application, supplier, PHONE, JSON.stringify(questions)])
    })

    it('"1 3" contesta la actual y la siguiente; una foto repite la pendiente; la última lleva al resumen', async () => {
      expect((await say('1 3')).resolution).toBe('matched')
      expect(await row()).toMatchObject({ step: 'asking', current_question: 2 })
      expect((await last()).body).toMatch(/^Pregunta 3 de 3\. ¿Qué fue este abono\?/)
      expect((await say('1, 2, 3')).resolution).toBe('unparsed')
      expect((await last()).body).toMatch(/^Recibí 3 respuestas, pero solo queda una pregunta\.\n\nPregunta 3 de 3/)

      const photo = await inboundMedia(PHONE, 'image')
      expect(await resolveInbound(worker.db, tenant, photo)).toEqual({ resolution: 'media_unsupported', resume: null })
      const reply = await last()
      expect(reply.kind).toBe('media')
      expect(reply.body).toMatch(/^Solo puedo leer el estado de cuenta en PDF, tal como lo descargas de tu banco\.\n\nPregunta 3 de 3/)
      expect(await row()).toMatchObject({ step: 'asking', current_question: 2 })

      expect((await say('no sé')).resolution).toBe('summary')
      expect((await last()).body).toBe(
        'Esto es lo que entendí:\n1) abono de $150,000.00 pesos del 15 de septiembre: Pago de un cliente o venta\n2) abono de $30,000.00 pesos del 20 de septiembre: Traspaso desde otra cuenta mía\n3) abono de $8,000.00 pesos del 25 de septiembre: No lo sé\n\n¿Es correcto? Responde sí para enviarlo a evaluación, o el número de la respuesta que quieres cambiar.',
      )
      expect((await row())?.step).toBe('confirming')
    })

    it('una corrección libre se aplica y vuelve el resumen; un número repregunta esa', async () => {
      expect((await say('me equivoqué, el 2 era préstamo')).resolution).toBe('corrected')
      expect((await last()).body).toMatch(/^Listo, cambié la respuesta 2\.\n\nEsto es lo que entendí:[\s\S]*2\) abono de \$30,000\.00 pesos del 20 de septiembre: Préstamo o crédito/)
      expect((await say('3')).resolution).toBe('revising')
      expect(await row()).toMatchObject({ step: 'revising', current_question: 2 })
      expect((await last()).body).toMatch(/^Pregunta 3 de 3\./)
      expect((await say('mmm')).resolution).toBe('unparsed')
      expect((await say('otra cosa')).resolution).toBe('corrected')
      expect((await last()).body).toMatch(/3\) abono de \$8,000\.00 pesos del 25 de septiembre: Otra cosa/)
      expect((await say('9')).resolution).toBe('awaiting_confirmation')
      expect((await last()).body).toMatch(/^No hay una respuesta 9: son 3\./)
      expect((await say('no')).resolution).toBe('awaiting_confirmation')
      expect((await last()).body).toBe('¿Qué respuesta quieres cambiar? Responde con su número.')
    })

    it('confirmado con una pregunta para el analista: no se reanuda y se le avisa', async () => {
      expect(await say('sí')).toEqual({ resolution: 'confirmed', resume: null })
      expect((await last()).body).toBe('Gracias, quedaron guardadas tus respuestas. Un analista revisará tu estado de cuenta y te avisaremos el resultado por este chat.')
      const r = await row()
      expect(r).toMatchObject({ step: 'confirmed', status: 'open' })
      expect(r?.answers.map((a) => [a.question_id, a.category ?? a.kind]).sort()).toEqual([
        ['q1', 'customer_payment'],
        ['q2', 'loan_disbursement'],
        ['q3', 'other'],
      ])
      expect((await say('¿ya?')).resolution).toBe('awaiting_analyst')
      expect((await last()).body).toMatch(/^Un analista revisará/)
    })

    it('una aclaración solo con preguntas para el analista avisa una vez al WhatsApp verificado; en registro, nada', async () => {
      const app2 = randomUUID()
      await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, status) VALUES ($1, $2, $3, 'extracting')", [app2, tenant, supplier])
      const ctx = await loadContext(worker.db, tenant, app2)
      const channel = new DbClarificationChannel(worker.db, ctx)
      const q = Question.parse(identity)
      await channel.send(app2, 1, [q])
      // Reintento del trabajo: la ronda ya existe y no se repite el aviso.
      await channel.send(app2, 1, [q])
      const notices = await admin.query<{ body: string; clarification_id: string | null }>("SELECT body, clarification_id FROM app.outbound_messages WHERE destination = $1 AND kind = 'analyst' AND clarification_id IN (SELECT id FROM app.clarifications WHERE application_id = $2)", [PHONE, app2])
      expect(notices.rows.map((n) => n.body)).toEqual(['Un analista revisará tu estado de cuenta y te avisaremos el resultado por este chat.'])
      const clar = await admin.query<{ channel: string; destination: string | null }>('SELECT channel, destination FROM app.clarifications WHERE application_id = $1', [app2])
      expect(clar.rows).toEqual([{ channel: 'manual', destination: null }])

      // Proveedor sin identidad (registro de la demo, ADR 0047): no sale nada.
      const outbox = async () => (await admin.query('SELECT 1 FROM app.outbound_messages WHERE destination = $1', [PHONE])).rowCount
      const before = await outbox()
      await new DbClarificationChannel(worker.db, { ...ctx, supplier: { ...ctx.supplier, legalName: null } }).send(app2, 2, [q])
      expect(await outbox()).toBe(before)
    })
  })

  describe('fotos, notas de voz y stickers (ADR 0051)', () => {
    const lastTo = async (to: string) => (await admin.query<{ body: string; kind: string }>('SELECT body, kind FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1', [to])).rows[0]

    it('un número sin vínculo recibe que solo se lee el PDF; en el registro de la demo, también la petición del estado de cuenta', async () => {
      const r = await resolveInbound(worker.db, tenant, await inboundMedia('+5215544440004', 'audio'))
      expect(r).toEqual({ resolution: 'media_unsupported', resume: null })
      expect(await lastTo('+5215544440004')).toEqual({ kind: 'media', body: 'Solo puedo leer el estado de cuenta en PDF, tal como lo descargas de tu banco.' })

      const NEW = '+5215544440014'
      const opts = { storage: services.storage, selfRegistration: true }
      expect((await resolveInbound(worker.db, tenant, await inbound(NEW, 'Hola'), opts)).resolution).toBe('registration_started')
      expect((await resolveInbound(worker.db, tenant, await inboundMedia(NEW, 'sticker'), opts)).resolution).toBe('media_unsupported')
      expect((await lastTo(NEW))?.body).toMatch(/^Solo puedo leer el estado de cuenta en PDF[^\n]*\n\nPara empezar, mándame por este chat tu estado de cuenta/)
      // El registro sigue esperando el PDF; nada cambió.
      const reg = await admin.query<{ step: string }>('SELECT step FROM app.supplier_registrations WHERE address = $1', [NEW])
      expect(reg.rows).toEqual([{ step: 'statement' }])
    })
  })

  describe('estado de cuenta por WhatsApp (ADR 0037)', () => {
    const pdf = Buffer.from('%PDF-1.7\n% estado de cuenta de prueba\n%%EOF\n')
    const replies = async (to: string) => (await admin.query<{ kind: string; body: string }>("SELECT kind, body FROM app.outbound_messages WHERE destination = $1 AND kind = 'document' ORDER BY created_at", [to])).rows
    const attachmentOf = async (id: string) => (await admin.query<{ attachment: Buffer | null; resolution: string }>('SELECT attachment, resolution FROM app.inbound_messages WHERE id = $1', [id])).rows[0]

    it('un número sin vínculo no abre nada y el adjunto no se queda guardado', async () => {
      const id = await inbound(STRANGER_PHONE, '', pdf)
      expect(await resolveInbound(worker.db, tenant, id, { storage: services.storage })).toEqual({ resolution: 'no_link', resume: null })
      expect(await attachmentOf(id)).toEqual({ attachment: null, resolution: 'no_link' })
      expect((await replies(STRANGER_PHONE)).map((r) => r.body)).toEqual([expect.stringMatching(/no está registrado para recibir documentos/)])
    })

    it('lo que no es PDF se rechaza con una respuesta fija', async () => {
      const id = await inbound(SUPPLIER_PHONE, 'foto', Buffer.from('\x89PNG\r\n'))
      expect((await resolveInbound(worker.db, tenant, id, { storage: services.storage })).resolution).toBe('document_rejected')
      const empty = await inbound(SUPPLIER_PHONE, '', Buffer.alloc(0))
      expect((await resolveInbound(worker.db, tenant, empty, { storage: services.storage })).resolution).toBe('document_rejected')
      expect(await attachmentOf(id)).toEqual({ attachment: null, resolution: 'document_rejected' })
    })

    it('un PDF del vínculo verificado abre la solicitud, pide la factura y al terminar encola el análisis (ADR 0039)', async () => {
      const opts = { storage: services.storage, today: () => '2026-11-06', askInvoice: true }
      const say = async (body: string, attachment: Buffer | null = null) => resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, body, attachment), opts)
      const lastInvoiceReply = async () => (await admin.query<{ body: string }>("SELECT body FROM app.outbound_messages WHERE destination = $1 AND kind = 'invoice' ORDER BY created_at DESC LIMIT 1", [SUPPLIER_PHONE])).rows[0]?.body ?? ''

      const id = await inbound(SUPPLIER_PHONE, 'mi estado de cuenta', pdf)
      const r = await resolveInbound(worker.db, tenant, id, opts)
      // Sin factura todavía no se analiza nada.
      expect(r).toEqual({ resolution: 'document_received', resume: null })
      const created = await admin.query<{ id: string; supplier_id: string; status: string; request: unknown; storage_path: string; size_bytes: string; step: string }>(
        'SELECT a.id::text, a.supplier_id::text, a.status, a.request, d.storage_path, d.size_bytes, i.step FROM app.invoice_intakes i JOIN app.applications a ON a.id = i.application_id JOIN app.application_documents ad ON ad.application_id = a.id JOIN app.documents d ON d.id = ad.document_id WHERE i.address = $1',
        [SUPPLIER_PHONE],
      )
      expect(created.rows[0]).toMatchObject({ supplier_id: supplierId, status: 'received', request: null, size_bytes: String(pdf.length), step: 'amount' })
      expect(created.rows[0]?.storage_path.startsWith(`${tenant}/`)).toBe(true)
      expect(await services.storage.read(created.rows[0]?.storage_path ?? '')).toEqual(pdf)
      expect(await attachmentOf(id)).toEqual({ attachment: null, resolution: 'document_received' })
      expect(await lastInvoiceReply()).toMatch(/Recibimos tu estado de cuenta[\s\S]*tres datos[\s\S]*monto/)
      // Reintento del barrido: el mensaje ya se procesó y no abre otra solicitud.
      expect((await resolveInbound(worker.db, tenant, id, opts)).resolution).toBe('already_processed')

      // Otro PDF a medio camino no se recibe; se repite la pregunta pendiente.
      expect((await say('', Buffer.from('%PDF-1.7\n% otro\n'))).resolution).toBe('intake_invalid')
      expect(await lastInvoiceReply()).toMatch(/Antes de recibir otro documento[\s\S]*monto/)
      expect((await say('mucho')).resolution).toBe('intake_invalid')
      expect((await say('$180,000')).resolution).toBe('intake_step')
      expect(await lastInvoiceReply()).toMatch(/cadena o empresa/)
      expect((await say('Cadena Norte SA de CV')).resolution).toBe('intake_step')
      expect((await say('01/01/2020')).resolution).toBe('intake_invalid')
      expect(await lastInvoiceReply()).toMatch(/ya pasó/)
      const done = await say('20/12/2026')
      expect(done.resolution).toBe('intake_completed')
      const appId = created.rows[0]?.id ?? ''
      expect(done.process).toEqual({ job: { tenant_id: tenant, application_id: appId }, sha256: createHash('sha256').update(pdf).digest('hex') })
      const app = await admin.query<{ request: unknown }>('SELECT request FROM app.applications WHERE id = $1', [appId])
      expect(app.rows[0]?.request).toEqual({ amount: 180000, maturity: '2026-12-20', buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } })
      expect(await lastInvoiceReply()).toMatch(/Reviso tu factura de \$180,000\.00 pesos a Cadena Norte SA de CV con vencimiento el 20\/12\/2026/)
      // Ya sin preguntas pendientes, un texto vuelve al flujo normal.
      expect((await say('hola')).resolution).toBe('no_open_clarification')
    })

    it('"omitir" en el monto analiza sin factura (línea máxima)', async () => {
      const other = Buffer.from('%PDF-1.7\n% estado de cuenta sin factura\n%%EOF\n')
      const opts = { storage: services.storage, askInvoice: true }
      expect((await resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, '', other), opts)).resolution).toBe('document_received')
      const r = await resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, 'omitir'), opts)
      expect(r.resolution).toBe('intake_completed')
      const app = await admin.query<{ request: unknown }>('SELECT request FROM app.applications WHERE id = $1', [r.process?.job.application_id])
      expect(app.rows[0]?.request).toBeNull()
    })

    it('el mismo PDF otra vez no abre una segunda solicitud', async () => {
      const before = (await admin.query('SELECT 1 FROM app.applications WHERE tenant_id = $1', [tenant])).rowCount
      const id = await inbound(SUPPLIER_PHONE, '', pdf)
      expect(await resolveInbound(worker.db, tenant, id, { storage: services.storage })).toEqual({ resolution: 'document_duplicate', resume: null })
      expect((await admin.query('SELECT 1 FROM app.applications WHERE tenant_id = $1', [tenant])).rowCount).toBe(before)
      expect((await replies(SUPPLIER_PHONE)).map((r) => r.body)).toEqual([
        expect.stringMatching(/No pudimos recibir/),
        expect.stringMatching(/No pudimos recibir/),
        expect.stringMatching(/Ya habíamos recibido/),
      ])
    })

    it('un duplicado contesta según cómo terminó la primera vez (ADR 0041)', async () => {
      const appOfPdf = async () =>
        (await admin.query<{ id: string }>('SELECT a.id::text FROM app.applications a JOIN app.application_documents ad ON ad.application_id = a.id JOIN app.documents d ON d.id = ad.document_id WHERE d.sha256 = $1 ORDER BY a.created_at DESC LIMIT 1', [createHash('sha256').update(pdf).digest('hex')])).rows[0]?.id ?? ''
      const send = async () => resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, '', pdf), { storage: services.storage })
      const lastDoc = async () => (await admin.query<{ body: string }>("SELECT body FROM app.outbound_messages WHERE destination = $1 AND kind IN ('document', 'invoice') ORDER BY created_at DESC LIMIT 1", [SUPPLIER_PHONE])).rows[0]?.body ?? ''
      const first = await appOfPdf()

      // Falló por ser tarjeta de crédito: se repite el motivo, no "sigue en revisión".
      await admin.query("UPDATE app.applications SET status = 'failed', failure_reason = $2 WHERE id = $1", [first, notBankStatementReason('credit_card_statement')])
      expect((await send()).resolution).toBe('document_duplicate')
      expect(await lastDoc()).toMatch(/^Lo que mandaste es un estado de cuenta de tarjeta de crédito/)

      // Ya tiene veredicto: "ya lo revisamos" y el mismo aviso.
      await admin.query("UPDATE app.applications SET status = 'not_qualified', failure_reason = NULL WHERE id = $1", [first])
      expect((await send()).resolution).toBe('document_duplicate')
      expect(await lastDoc()).toMatch(/^Ya habíamos revisado este estado de cuenta\. Revisamos tu factura de \$180,000\.00 pesos[\s\S]*no califica/)

      // Falló por un error nuestro: el mismo archivo abre una solicitud nueva.
      await admin.query("UPDATE app.applications SET status = 'failed', failure_reason = 'el workflow terminó sin veredicto' WHERE id = $1", [first])
      const retry = await send()
      expect(retry.resolution).toBe('document_received')
      expect(retry.process?.job.application_id).toBe(await appOfPdf())
      expect(await appOfPdf()).not.toBe(first)
      expect(await lastDoc()).toMatch(/^Recibimos tu estado de cuenta\. Lo estoy revisando/)
    })

    it('sin preguntas de factura (la demo), el PDF se analiza al llegar y no abre conversación', async () => {
      const fresh = Buffer.from('%PDF-1.7\n% estado de cuenta sin preguntas\n%%EOF\n')
      const r = await resolveInbound(worker.db, tenant, await inbound(SUPPLIER_PHONE, '', fresh), { storage: services.storage })
      expect(r.resolution).toBe('document_received')
      expect(r.process?.sha256).toBe(createHash('sha256').update(fresh).digest('hex'))
      const app = await admin.query<{ request: unknown }>('SELECT request FROM app.applications WHERE id = $1', [r.process?.job.application_id])
      expect(app.rows[0]?.request).toBeNull()
      expect((await admin.query('SELECT 1 FROM app.invoice_intakes WHERE application_id = $1', [r.process?.job.application_id])).rowCount).toBe(0)
    })
  })

  /**
   * Manda el saludo y el PDF desde `phone` y analiza la solicitud con un estado de cuenta sintético a
   * nombre de `holder` en lugar del PDF (el worker no extrae en estas pruebas).
   */
  async function registerWithStatement(phone: string, holder: SyntheticDocument['holder'], seed: string, opts: Parameters<typeof resolveInbound>[3]) {
    // Un número que ya saludó recibe de nuevo la petición del PDF.
    expect(['registration_started', 'registration_waiting']).toContain((await resolveInbound(worker.db, tenant, await inbound(phone, 'Hola'), opts)).resolution)
    const r = await resolveInbound(worker.db, tenant, await inbound(phone, '', Buffer.from(`%PDF-1.7\n% ${seed}\n%%EOF\n`)), opts)
    expect(r.resolution).toBe('document_received')
    const appId = r.process?.job.application_id ?? ''
    const doc: SyntheticDocument = { input: { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 80000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] }, holder, seed }
    const path = `${tenant}/${randomUUID()}${SYNTHETIC_SUFFIX}`
    await services.storage.put(path, Buffer.from(JSON.stringify(doc)))
    const sha = syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256
    await admin.query('UPDATE app.documents SET storage_path = $2, sha256 = $3 WHERE id = (SELECT document_id FROM app.application_documents WHERE application_id = $1)', [appId, path, sha])
    const status = await handleProcess(services, { tenant_id: tenant, application_id: appId })
    return { appId, status }
  }

  describe('registro por WhatsApp con el estado de cuenta primero (ADR 0038 y 0047)', () => {
    const NEWCOMER = '+5215577770007'
    const opts = () => ({ storage: services.storage, selfRegistration: true })
    const step = async (body: string, attachment: Buffer | null = null, from = NEWCOMER) => resolveInbound(worker.db, tenant, await inbound(from, body, attachment), opts())
    const lastReply = async (to = NEWCOMER) => (await admin.query<{ body: string; kind: string }>('SELECT body, kind FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1', [to])).rows[0] ?? { body: '', kind: '' }
    const kinds = async (to: string) => (await admin.query<{ kind: string }>('SELECT kind FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at', [to])).rows.map((r) => r.kind)
    const supplierOf = async (phone: string) =>
      (await admin.query<{ legal_name: string | null; rfc: string | null; representative_name: string | null; verified: boolean; method: string }>("SELECT s.legal_name, s.rfc, s.representative_name, c.verified_at IS NOT NULL AS verified, c.verification_method AS method FROM app.supplier_contacts c JOIN app.suppliers s ON s.id = c.supplier_id WHERE c.address = $1 AND c.channel = 'whatsapp'", [phone])).rows

    it('sin la bandera, un número nuevo sigue recibiendo la respuesta fija', async () => {
      const id = await inbound('+5215566660006', 'hola')
      expect((await resolveInbound(worker.db, tenant, id, { storage: services.storage })).resolution).toBe('no_link')
    })

    it('saludar pide el estado de cuenta; un texto lo vuelve a pedir', async () => {
      expect((await step('Hola')).resolution).toBe('registration_started')
      expect((await lastReply()).body).toMatch(/asistente de Fintech Demo[\s\S]*estado de cuenta bancario más reciente en PDF/)
      expect((await step('¿qué necesito?')).resolution).toBe('registration_waiting')
      expect((await lastReply()).body).toMatch(/^Para empezar, mándame por este chat tu estado de cuenta/)
      // Lo que no es PDF se rechaza y no crea solicitud.
      expect((await step('foto', Buffer.from('\x89PNG\r\n'))).resolution).toBe('document_rejected')
    })

    it('persona moral: el PDF se analiza al llegar, el resultado espera a que confirme sus datos y al representante legal', async () => {
      const { status } = await registerWithStatement(NEWCOMER, { name: 'Comercializadora Nueva SA de CV', rfc: 'CNU150304AB1', clabe: null }, 'reg-moral', opts())
      // La identidad no decide (ADR 0052): ya hay veredicto, pero no sale hasta que confirme sus datos.
      expect(['qualified', 'qualified_with_limit', 'not_qualified']).toContain(status)
      expect(await supplierOf(NEWCOMER)).toEqual([{ legal_name: null, rfc: null, representative_name: null, verified: true, method: 'whatsapp_self_registration' }])
      expect(await kinds(NEWCOMER)).not.toContain('verdict')
      expect(await kinds(NEWCOMER)).not.toContain('question')
      expect((await lastReply()).body).toMatch(/Está a nombre de Comercializadora Nueva SA de CV, con RFC CNU150304AB1\.\n\n¿Son correctos\? Responde sí o no\./)

      // Mientras tanto, otro PDF no se recibe.
      expect((await step('', Buffer.from('%PDF-1.7\n% otro\n'))).resolution).toBe('registration_invalid')
      expect((await lastReply()).body).toMatch(/^Antes de recibir otro documento[\s\S]*¿Son correctos\?/)
      expect((await step('quizá')).resolution).toBe('registration_invalid')
      expect((await step('Sí')).resolution).toBe('registration_step')
      expect((await lastReply()).body).toMatch(/persona moral[\s\S]*representante legal/)
      const done = await step('Ana María López Pérez')
      expect(done.resolution).toBe('registration_completed')
      expect(await supplierOf(NEWCOMER)).toEqual([{ legal_name: 'Comercializadora Nueva SA de CV', rfc: 'CNU150304AB1', representative_name: 'Ana María López Pérez', verified: true, method: 'whatsapp_self_registration' }])
      // El veredicto retenido sale con el agradecimiento, sin reanudar nada.
      expect(done.resume).toBeNull()
      const verdict = await lastReply()
      expect(verdict.kind).toBe('verdict')
      expect(verdict.body).toMatch(/^Gracias, quedaron registrados los datos de Comercializadora Nueva SA de CV\.\n\n(Buenas noticias|Revisamos tu estado de cuenta)/)
      expect(verdict.body).not.toContain('CNU150304AB1')
      expect(await kinds(NEWCOMER)).toEqual(expect.arrayContaining(['verdict']))
      expect((await kinds(NEWCOMER)).filter((k) => k === 'verdict')).toHaveLength(1)
    })

    it('ya registrado, un saludo dice qué hacer y un PDF abre la solicitud de su proveedor', async () => {
      // El aviso anterior pudo preguntar cuánto quiere adelantar (ADR 0053): "omitir" cierra esa pregunta.
      expect(['offer_skipped', 'registered_idle']).toContain((await step('omitir')).resolution)
      expect((await step('hola de nuevo')).resolution).toBe('registered_idle')
      expect((await lastReply()).body).toMatch(/Ya tienes registrada a Comercializadora Nueva SA de CV/)
      const r = await step('', Buffer.from('%PDF-1.7\n% otro estado de cuenta\n%%EOF\n'))
      expect(r.resolution).toBe('document_received')
      const owner = await admin.query<{ legal_name: string }>('SELECT s.legal_name FROM app.applications a JOIN app.suppliers s ON s.id = a.supplier_id WHERE a.id = $1', [r.process?.job.application_id])
      expect(owner.rows).toEqual([{ legal_name: 'Comercializadora Nueva SA de CV' }])
    })

    it('persona física con RFC sin homoclave: confirma el nombre y se le pide el RFC completo', async () => {
      const PHONE = '+5215577770017'
      const { status } = await registerWithStatement(PHONE, { name: 'Ana López Pérez', rfc: 'LOPA800101', clabe: null }, 'reg-fisica', opts())
      expect(['qualified', 'qualified_with_limit', 'not_qualified']).toContain(status)
      expect((await lastReply(PHONE)).body).toMatch(/Está a nombre de Ana López Pérez\.\n\n¿Es correcto\?/)
      expect((await lastReply(PHONE)).body).not.toContain('LOPA800101')
      expect((await step('si', null, PHONE)).resolution).toBe('registration_step')
      expect((await lastReply(PHONE)).body).toMatch(/sin homoclave \(LOPA800101\)/)
      expect((await step('LOPB800101AB1', null, PHONE)).resolution).toBe('registration_invalid')
      expect((await lastReply(PHONE)).body).toMatch(/no empieza como el de tu estado de cuenta/)
      const done = await step('lopa800101h2a', null, PHONE)
      // Persona física: no se pide representante.
      expect(done.resolution).toBe('registration_completed')
      expect(await supplierOf(PHONE)).toEqual([{ legal_name: 'Ana López Pérez', rfc: 'LOPA800101H2A', representative_name: null, verified: true, method: 'whatsapp_self_registration' }])
      expect(done.resume).toBeNull()
      expect((await lastReply(PHONE)).kind).toBe('verdict')
    })

    it('sin monto, el aviso ofrece la línea máxima y pregunta cuánto; con el monto se decide de nuevo (ADR 0053)', async () => {
      const PHONE = '+5215577770047'
      const { appId, status } = await registerWithStatement(PHONE, { name: 'Ríos y Vega SA de CV', rfc: 'RVE150304AB1', clabe: null }, 'reg-oferta', opts())
      expect(['qualified', 'qualified_with_limit']).toContain(status)
      expect((await step('si', null, PHONE)).resolution).toBe('registration_step')
      expect((await step('Laura Ríos Vega', null, PHONE)).resolution).toBe('registration_completed')
      const offer = await lastReply(PHONE)
      expect(offer.kind).toBe('verdict')
      const max = /hasta \$([\d,]+\.\d{2}) pesos\. Si por ahora no quieres/.exec(offer.body)?.[1]
      expect(offer.body).toMatch(/¿Cuánto quieres adelantar\? Escribe el monto en pesos, hasta \$[\d,]+\.\d{2} pesos\./)
      const maxValue = Number((max ?? '0').replace(/,/g, ''))
      expect(maxValue).toBeGreaterThan(1000)
      // Más que la línea: se repregunta. Algo ilegible: también.
      expect((await step(String(Math.ceil(maxValue + 1000)), null, PHONE)).resolution).toBe('offer_invalid')
      expect((await lastReply(PHONE)).body).toMatch(/pasa del máximo/)
      expect((await step('mucho', null, PHONE)).resolution).toBe('offer_invalid')
      const amount = Math.floor(maxValue / 2)
      const r = await step(String(amount), null, PHONE)
      expect(r.resolution).toBe('offer_accepted')
      expect(r.redecide?.application_id).toBe(appId)
      const app = await admin.query<{ request: unknown; status: string }>('SELECT request, status FROM app.applications WHERE id = $1', [appId])
      expect(app.rows[0]).toEqual({ request: { amount, maturity: null, buyer: null }, status: 'deciding' })
      const final = await handleRedecide(services, r.redecide ?? { tenant_id: tenant, application_id: appId, correction_batch: randomUUID() })
      expect(['qualified', 'qualified_with_limit']).toContain(final)
      const verdict = await lastReply(PHONE)
      expect(verdict.kind).toBe('verdict')
      expect(verdict.body).toMatch(/tu solicitud de adelanto de \$[\d,]+\.00 pesos/)
      // Ya con monto, no se vuelve a ofrecer.
      expect(verdict.body).not.toMatch(/¿Cuánto quieres adelantar/)
      expect((await step('hola', null, PHONE)).resolution).toBe('registered_idle')
    })

    it('si los datos leídos no son suyos, se piden nombre y RFC', async () => {
      const PHONE = '+5215577770027'
      await registerWithStatement(PHONE, { name: 'Otra Empresa SA de CV', rfc: 'OEM150304AB1', clabe: null }, 'reg-no', opts())
      expect((await step('no', null, PHONE)).resolution).toBe('registration_step')
      expect((await lastReply(PHONE)).body).toMatch(/¿A nombre de quién está la cuenta\?/)
      expect((await step('Luis Gómez Ruiz', null, PHONE)).resolution).toBe('registration_step')
      expect((await lastReply(PHONE)).body).toMatch(/^Ahora escribe el RFC del titular/)
      expect((await step('GORL800101H2A', null, PHONE)).resolution).toBe('registration_completed')
      expect(await supplierOf(PHONE)).toEqual([{ legal_name: 'Luis Gómez Ruiz', rfc: 'GORL800101H2A', representative_name: null, verified: true, method: 'whatsapp_self_registration' }])
    })

    it('si el estado de cuenta falla, se avisa por qué y se espera otro PDF', async () => {
      const PHONE = '+5215577770037'
      const { appId } = await registerWithStatement(PHONE, { name: 'Ana López Pérez', rfc: 'LOPA800101H2A', clabe: null }, 'reg-fail', opts())
      // Un fallo al terminar la lectura (no era estado de cuenta): se simula sobre lo que dejó la corrida.
      const ctx = await loadContext(worker.db, tenant, appId)
      await admin.query("UPDATE app.supplier_registrations SET step = 'reading', application_id = $2 WHERE address = $1", [PHONE, appId])
      await withTenant(worker.db, tenant, async (tx) => {
        await queueVerdict(tx, ctx, 'failed', null, notBankStatementReason('credit_card_statement'))
        await startConfirmation(tx, ctx, null, 'failed')
      })
      expect((await lastReply(PHONE)).body).toMatch(/^Lo que mandaste es un estado de cuenta de tarjeta de crédito/)
      expect((await step('hola', null, PHONE)).resolution).toBe('registration_waiting')
    })
  })
  describe('intérprete de mensajes con Haiku (ADR 0040)', () => {
    const PHONE = '+5215588880008'
    const calls: InterpretInput[] = []
    const answers: Record<string, Interpretation> = {
      asdfgh: { intent: 'nonsense', value: null },
      '¿cuánto cobran de comisión?': { intent: 'question', value: null },
      'Somos Abarrotes La Esperanza, gracias': { intent: 'answer', value: 'Abarrotes La Esperanza' },
      'mi rfc es ale 150304 ab1': { intent: 'answer', value: 'ALE150304AB1' },
      'ciento ochenta mil pesitos': { intent: 'answer', value: '180000' },
      'no sé, inventa uno': { intent: 'answer', value: 'XYZ' },
    }
    const fake: MessageInterpreter = {
      interpret: (input) => {
        calls.push(input)
        return Promise.resolve(answers[input.message] ?? null)
      },
    }
    const opts = () => ({ storage: services.storage, selfRegistration: true, interpreter: fake, askInvoice: true })
    const say = async (body: string, attachment: Buffer | null = null) => resolveInbound(worker.db, tenant, await inbound(PHONE, body, attachment), opts())
    const lastReply = async () => (await admin.query<{ body: string }>('SELECT body FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1', [PHONE])).rows[0]?.body ?? ''

    it('texto sin sentido o consultas se repreguntan; lo que propone Haiku pasa por el lector', async () => {
      await registerWithStatement(PHONE, { name: 'Abarrotes Esperanza SA de CV', rfc: 'AES150304AB1', clabe: null }, 'haiku', opts())
      calls.length = 0
      expect(await say('asdfgh')).toEqual({ resolution: 'registration_invalid', resume: null, interpreted: true })
      expect(await lastReply()).toMatch(/^No entendí tu respuesta\.\n\nYa leí tu estado de cuenta/)
      expect((await say('¿cuánto cobran de comisión?')).resolution).toBe('registration_invalid')
      expect(await lastReply()).toMatch(/^Por este chat solo puedo pedirte los datos de tu solicitud[\s\S]*¿Son correctos\?/)
      expect((await say('no')).resolution).toBe('registration_step')
      expect((await say('Somos Abarrotes La Esperanza, gracias')).resolution).toBe('registration_step')
      // Un RFC que propone Haiku y no tiene formato no se acepta.
      expect((await say('no sé, inventa uno')).resolution).toBe('registration_invalid')
      expect(await lastReply()).toMatch(/formato correcto/)
      expect((await say('mi rfc es ale 150304 ab1')).resolution).toBe('registration_step')
      expect(await lastReply()).toMatch(/representante legal/)
      expect((await say('Juan Pérez Soto')).resolution).toBe('registration_completed')
      const rfc = await admin.query<{ legal_name: string; rfc: string }>('SELECT s.legal_name, s.rfc FROM app.supplier_contacts c JOIN app.suppliers s ON s.id = c.supplier_id WHERE c.address = $1', [PHONE])
      expect(rfc.rows).toEqual([{ legal_name: 'Abarrotes La Esperanza', rfc: 'ALE150304AB1' }])
      // Sí/no y RFC con formato no llaman a Haiku; los nombres siempre.
      expect(calls.map((c) => c.field)).toEqual(['option', 'option', 'legal_name', 'rfc', 'rfc', 'legal_name'])
    })

    it('un monto en palabras entra por Haiku; uno con formato no lo llama', async () => {
      expect((await say('', Buffer.from('%PDF-1.7\n% abarrotes\n%%EOF\n'))).resolution).toBe('document_received')
      const before = calls.length
      expect(await say('ciento ochenta mil pesitos')).toEqual({ resolution: 'intake_step', resume: null, interpreted: true })
      const draft = await admin.query<{ draft: unknown }>('SELECT draft FROM app.invoice_intakes WHERE address = $1 ORDER BY created_at DESC LIMIT 1', [PHONE])
      expect(draft.rows[0]?.draft).toEqual({ amount: 180000 })
      expect(calls.length).toBe(before + 1)
    })

    it('si Haiku no responde, la conversación sigue con las reglas', async () => {
      const down: MessageInterpreter = { interpret: () => Promise.resolve(null) }
      const id = await inbound(PHONE, 'Cadena Comercial Oxxo')
      const r = await resolveInbound(worker.db, tenant, id, { storage: services.storage, selfRegistration: true, interpreter: down })
      expect(r).toEqual({ resolution: 'intake_step', resume: null })
    })
  })
  it('una solicitud que falla avisa al proveedor por qué, sin datos del documento (ADR 0041)', async () => {
    const ctx = await loadContext(worker.db, tenant, applicationId)
    await withTenant(worker.db, tenant, (tx) => queueVerdict(tx, ctx, 'failed', null, notBankStatementReason('credit_card_statement')))
    const last = await admin.query<{ body: string }>("SELECT body FROM app.outbound_messages WHERE destination = $1 AND kind = 'verdict' ORDER BY created_at DESC LIMIT 1", [SUPPLIER_PHONE])
    expect(last.rows[0]?.body).toMatch(/^Lo que mandaste es un estado de cuenta de tarjeta de crédito/)
    const audit = await admin.query<{ details: { failure?: string } }>("SELECT details FROM app.audit_log WHERE subject = $1 AND action = 'verdict.queued' ORDER BY at DESC LIMIT 1", [applicationId])
    expect(audit.rows[0]?.details.failure).toBe('not_bank_statement')
  })

  it('un PDF con varios estados de cuenta avisa que se manda cada uno en su archivo (robustez documental, sección W)', async () => {
    const ctx = await loadContext(worker.db, tenant, applicationId)
    await withTenant(worker.db, tenant, (tx) => queueVerdict(tx, ctx, 'failed', null, multipleStatementsReason(2)))
    const last = await admin.query<{ body: string }>("SELECT body FROM app.outbound_messages WHERE destination = $1 AND kind = 'verdict' ORDER BY created_at DESC LIMIT 1", [SUPPLIER_PHONE])
    expect(last.rows[0]?.body).toBe('Tu PDF trae más de un estado de cuenta. Mándanos cada estado de cuenta en un PDF aparte, tal como lo descargaste de tu banco.')
    const audit = await admin.query<{ details: { failure?: string } }>("SELECT details FROM app.audit_log WHERE subject = $1 AND action = 'verdict.queued' ORDER BY at DESC LIMIT 1", [applicationId])
    expect(audit.rows[0]?.details.failure).toBe('multiple_statements')
  })

  describe('páginas faltantes: el PDF completo por WhatsApp contesta la pregunta (robustez documental, sección W)', () => {
    const TENANT = randomUUID()
    const SUPPLIER = randomUUID()
    const APPLICATION = randomUUID()
    const PHONE = '+5215512340012'
    const holder = { name: 'Refaccionaria Ficticia SA de CV', rfc: 'RFI150304AB1', clabe: null }
    // Lo que el estado de cuenta incompleto trae de la extracción: la bandera y el hueco en la paginación.
    const incomplete = (d: SyntheticDocument) => {
      const s = syntheticStatement(d.input, d.holder, d.seed)
      const issue = { id: 'pm1', code: 'page_missing', severity: 'warning', message: 'Faltan páginas', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: { missing: [2], total: 3 } } as const
      return d.seed === 'incompleto' ? { ...s, flags: [...s.flags, 'pages_missing' as const], issues: [...s.issues, issue] } : s
    }
    const complete = Buffer.from('%PDF-1.7\n% estado de cuenta completo\n%%EOF\n')
    let svc: WorkerServices

    const say = async (body: string, attachment: Buffer | null = null) => {
      await whatsapp.query('BEGIN')
      await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT])
      const r = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, attachment) VALUES ($1, 'whatsapp', $2, $3, $4) RETURNING id", [TENANT, PHONE, body, attachment])
      await whatsapp.query('COMMIT')
      return resolveInbound(worker.db, TENANT, r.rows[0]?.id ?? '', { storage: svc.storage })
    }
    const lastBody = async () => (await admin.query<{ body: string; kind: string }>('SELECT body, kind FROM app.outbound_messages WHERE destination = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [PHONE])).rows[0]
    const clar = async () => (await admin.query<{ id: string; status: string; step: string; current_question: number; answers: { question_id: string; kind: string; paths?: string[] }[] }>('SELECT id, status, step, current_question, answers FROM app.clarifications WHERE application_id = $1', [APPLICATION])).rows[0]

    beforeAll(async () => {
      // La compuerta de páginas completas del motor (sección M) pregunta `missing_pages`; aquí la hace una de
      // meses de historia sobre un documento que la respuesta completa: lo que importa es el canal.
      const policy = basePolicyTemplate()
      const gate = { id: 'pages_complete', description: 'Prueba', when: { feature: 'months_of_history', op: '>=', value: 2 }, onFail: { status: 'needs_clarification', ask: 'missing_pages' } } as const
      const doc: SyntheticDocument = { input: { start: '2026-08-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] }, holder, seed: 'incompleto' }
      const path = `${TENANT}/${randomUUID()}${SYNTHETIC_SUFFIX}`
      await services.storage.put(path, Buffer.from(JSON.stringify(doc)))
      const sha = syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256
      const policyId = randomUUID()
      const docId = randomUUID()
      await admin.query("INSERT INTO app.tenants (id, name, whatsapp_number) VALUES ($1, 'Fintech Faltantes', '+5215500000002')", [TENANT])
      await admin.query("INSERT INTO app.policies (id, tenant_id, name) VALUES ($1, $2, 'base')", [policyId, TENANT])
      await admin.query("INSERT INTO app.policy_versions (tenant_id, policy_id, version, status, document) VALUES ($1, $2, 1, 'active', $3)", [TENANT, policyId, JSON.stringify({ ...policy, gates: [gate, ...policy.gates] })])
      await admin.query('INSERT INTO app.suppliers (id, tenant_id, legal_name, rfc) VALUES ($1, $2, $3, $4)', [SUPPLIER, TENANT, holder.name, holder.rfc])
      await admin.query("INSERT INTO app.supplier_contacts (tenant_id, supplier_id, channel, address, verified_at, verification_method) VALUES ($1, $2, 'whatsapp', $3, now(), 'kyc')", [TENANT, SUPPLIER, PHONE])
      await admin.query("INSERT INTO app.documents (id, tenant_id, supplier_id, storage_path, sha256, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5, 10, 'application/json')", [docId, TENANT, SUPPLIER, path, sha])
      await admin.query("INSERT INTO app.applications (id, tenant_id, supplier_id, request, as_of) VALUES ($1, $2, $3, $4, '2026-10-05')", [APPLICATION, TENANT, SUPPLIER, JSON.stringify({ amount: 50000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } })])
      await admin.query('INSERT INTO app.application_documents (tenant_id, application_id, document_id) VALUES ($1, $2, $3)', [TENANT, APPLICATION, docId])
      svc = { ...services, synthetic: (d) => incomplete(d) }
    }, 60_000)

    it('la pregunta de páginas faltantes sale por WhatsApp con el pedido del PDF, no el aviso del analista', async () => {
      expect(await handleProcess(svc, { tenant_id: TENANT, application_id: APPLICATION })).toBe('needs_clarification')
      expect(await clar()).toMatchObject({ status: 'open', step: 'asking', current_question: 0, answers: [] })
      const out = await admin.query<{ kind: string; body: string }>('SELECT kind, body FROM app.outbound_messages WHERE destination = $1', [PHONE])
      expect(out.rows).toEqual([{ kind: 'question', body: 'Al estado de cuenta que mandaste le faltan páginas (por ejemplo la 2 de 3). ¿Nos mandas el PDF completo?\n\nMándalo por este chat como PDF, tal como lo descargaste de tu banco.' }])
    })

    it('un texto o una foto no lo contestan: se repite el pedido y nada cambia', async () => {
      expect((await say('ya te lo mandé')).resolution).toBe('awaiting_document')
      expect(await lastBody()).toEqual({ kind: 'reask', body: DOCUMENT_REPLIES.send_pdf })
      await whatsapp.query('BEGIN')
      await whatsapp.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT])
      const photo = await whatsapp.query<{ id: string }>("INSERT INTO app.inbound_messages (tenant_id, channel, from_address, body, media_kind) VALUES ($1, 'whatsapp', $2, '', 'image') RETURNING id", [TENANT, PHONE])
      await whatsapp.query('COMMIT')
      expect((await resolveInbound(worker.db, TENANT, photo.rows[0]?.id ?? '')).resolution).toBe('media_unsupported')
      expect((await lastBody())?.body).toMatch(/^Solo puedo leer el estado de cuenta en PDF[^\n]*\n\nAl estado de cuenta que mandaste le faltan páginas/)
      expect(await clar()).toMatchObject({ status: 'open', step: 'asking', answers: [] })
    })

    it('un archivo que no es PDF se rechaza y la pregunta sigue abierta; el mismo archivo incompleto no sirve', async () => {
      expect((await say('', Buffer.from('\x89PNG\r\n'))).resolution).toBe('document_rejected')
      expect(await clar()).toMatchObject({ status: 'open', answers: [] })
      // El archivo que ya está en la solicitud (al que le faltan páginas) tampoco contesta. El de la prueba es
      // sintético: por un momento se le pone el hash de un PDF para volver a mandarlo.
      const incompletePdf = Buffer.from('%PDF-1.7\n% estado de cuenta incompleto\n%%EOF\n')
      const original = (await admin.query<{ id: string; sha256: string }>('SELECT d.id, d.sha256 FROM app.documents d JOIN app.application_documents ad ON ad.document_id = d.id WHERE ad.application_id = $1', [APPLICATION])).rows[0]
      await admin.query('UPDATE app.documents SET sha256 = $2 WHERE id = $1', [original?.id, createHash('sha256').update(incompletePdf).digest('hex')])
      const r = await say('', incompletePdf)
      await admin.query('UPDATE app.documents SET sha256 = $2 WHERE id = $1', [original?.id, original?.sha256])
      expect(r).toEqual({ resolution: 'document_duplicate', resume: null })
      expect(await lastBody()).toEqual({ kind: 'document', body: DOCUMENT_REPLIES.answer_same_file })
      expect(await clar()).toMatchObject({ status: 'open', answers: [] })
      expect((await admin.query('SELECT 1 FROM app.application_documents WHERE application_id = $1', [APPLICATION])).rowCount).toBe(1)
    })

    it('el PDF completo contesta la pregunta, se agrega a la misma solicitud y se encola la reanudación', async () => {
      const before = (await admin.query('SELECT 1 FROM app.applications WHERE tenant_id = $1', [TENANT])).rowCount
      const r = await say('aquí está completo', complete)
      const c = await clar()
      expect(r).toEqual({ resolution: 'document_answer', resume: { tenant_id: TENANT, application_id: APPLICATION, clarification_id: c?.id } })
      expect(await lastBody()).toEqual({ kind: 'document', body: DOCUMENT_REPLIES.answer_received })
      // No abrió otra solicitud: el documento quedó ligado a la misma, como respuesta del proveedor.
      expect((await admin.query('SELECT 1 FROM app.applications WHERE tenant_id = $1', [TENANT])).rowCount).toBe(before)
      const linked = await admin.query<{ origin: string; storage_path: string; sha256: string }>('SELECT ad.origin, d.storage_path, d.sha256 FROM app.application_documents ad JOIN app.documents d ON d.id = ad.document_id WHERE ad.application_id = $1 ORDER BY ad.origin', [APPLICATION])
      expect(linked.rows.map((x) => x.origin)).toEqual(['submitted', 'owner_answer'])
      const added = linked.rows[1]
      expect(added?.sha256).toBe(createHash('sha256').update(complete).digest('hex'))
      expect(await services.storage.read(added?.storage_path ?? '')).toEqual(complete)
      expect(c).toMatchObject({ status: 'answered', step: 'confirmed', answers: [{ question_id: 'q1', kind: 'documents', paths: [added?.storage_path] }] })
      // El adjunto no se queda en el entrante.
      expect((await admin.query('SELECT 1 FROM app.inbound_messages WHERE tenant_id = $1 AND attachment IS NOT NULL', [TENANT])).rowCount).toBe(0)
    })

    it('la reanudación extrae el PDF nuevo, decide otra vez y avisa el resultado', async () => {
      // El worker de la prueba no extrae PDFs reales: el documento nuevo se sustituye por un estado de cuenta
      // sintético del mes siguiente, como hacen las demás pruebas.
      const added = await admin.query<{ id: string; storage_path: string }>("SELECT d.id, d.storage_path FROM app.documents d JOIN app.application_documents ad ON ad.document_id = d.id WHERE ad.application_id = $1 AND ad.origin = 'owner_answer'", [APPLICATION])
      const doc: SyntheticDocument = { input: { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 60000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 30000 }] }, holder, seed: 'completo' }
      const path = `${TENANT}/${randomUUID()}${SYNTHETIC_SUFFIX}`
      await services.storage.put(path, Buffer.from(JSON.stringify(doc)))
      await admin.query('UPDATE app.documents SET storage_path = $2, sha256 = $3 WHERE id = $1', [added.rows[0]?.id, path, syntheticStatement(doc.input, doc.holder, doc.seed).document.sha256])
      await admin.query("UPDATE app.clarifications SET answers = jsonb_build_array(jsonb_build_object('question_id', 'q1', 'kind', 'documents', 'paths', jsonb_build_array($2::text))) WHERE application_id = $1", [APPLICATION, path])
      const c = await clar()
      const status = await handleResume(svc, { tenant_id: TENANT, application_id: APPLICATION, clarification_id: c?.id ?? '' })
      expect(['qualified', 'qualified_with_limit', 'not_qualified', 'human_review']).toContain(status)
      const app = await admin.query<{ status: string }>('SELECT status FROM app.applications WHERE id = $1', [APPLICATION])
      expect(app.rows[0]?.status).toBe(status)
      // Las dos extracciones quedaron guardadas, la del PDF completo con su documento.
      expect((await admin.query('SELECT 1 FROM app.extractions e JOIN app.application_documents ad ON ad.document_id = e.document_id WHERE ad.application_id = $1', [APPLICATION])).rowCount).toBe(2)
      expect((await lastBody())?.kind).toBe('verdict')
    })

    it('si el proveedor manda el PDF cuando no se le pidió nada, abre una solicitud nueva como siempre (ADR 0037)', async () => {
      const r = await say('otro mes', Buffer.from('%PDF-1.7\n% otro mes\n%%EOF\n'))
      expect(r.resolution).toBe('document_received')
      expect(r.process?.job.application_id).not.toBe(APPLICATION)
    })
  })
})
