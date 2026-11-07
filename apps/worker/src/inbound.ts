/**
 * Resolución de cada mensaje entrante (docs/05 §2b):
 *
 * 1. Llega un mensaje de N por el canal del tenant T (el proceso de WhatsApp o el webhook de
 *    correo ya fijaron T).
 * 2. Vínculos verificados (T, canal, N). Sin vínculo: respuesta fija y registro; nada se encola.
 * 3. Con vínculo: solo las aclaraciones abiertas de esos proveedores con ese destino. El texto del
 *    mensaje nunca autoriza nada: citar un folio ajeno no abre esa solicitud.
 * 4. Se lee la respuesta contra la pregunta que se espera; ambigua → se repregunta con números. Un
 *    mensaje puede traer varias respuestas ("1, 3, 1"): van a la actual y a las siguientes.
 * 5. Contestadas las preguntas del chat, se manda un resumen; con "sí", la aclaración queda
 *    `answered` y se encola la reanudación; con un número o una corrección, se cambia esa respuesta
 *    y se vuelve al resumen (ADR 0051). Si quedan preguntas para el analista, se le avisa.
 *
 * Una foto, nota de voz, video o sticker no se lee: se contesta que hace falta el PDF y se repite lo
 * pendiente (ADR 0051).
 *
 * Un mensaje con documento (ADR 0037) no responde aclaraciones: con un solo proveedor en el vínculo
 * verificado y un PDF válido abre una solicitud, igual que la API con una llave de ingesta, y se
 * encola su procesamiento. Los bytes pasan del entrante al almacenamiento del tenant y la columna
 * queda vacía. A quien lo mandó solo se le contesta un texto fijo.
 *
 * Con `selfRegistration` (solo la demo, ADR 0038 y 0047), un número de WhatsApp sin vínculo no
 * recibe la respuesta fija: se le pide su estado de cuenta, que se analiza de inmediato; al leerlo,
 * confirma o corrige el titular y el RFC, completa lo que falte y, si es persona moral, da su
 * representante legal. Entonces queda como proveedor con su identidad y sale el resultado
 * (registration.ts).
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  AMOUNT_OFFER,
  ANALYST_NOTICE,
  CONFIRMATION_REPLIES,
  CONVERSATION_FALLBACKS,
  conversationalIndexes,
  describeInvoice,
  DOCUMENT_REPLIES,
  failureNotice,
  GENERIC_NO_PENDING,
  INVOICE_REPLIES,
  isComplete,
  isConversational,
  isSkip,
  MEDIA_UNSUPPORTED,
  parseAmount,
  parseConfirmation,
  parseLegalName,
  parseMaturity,
  parseMultipleReplies,
  parseReply,
  parseRfc,
  parseYesNo,
  personTypeOf,
  REGISTRATION_REPLIES,
  renderQuestionAt,
  renderReask,
  renderSummary,
} from '@gow/channels'
import { ApplicationRequest, calendarToday, describeFailure, OwnerAnswer, Question, type ApplicationRequest as ApplicationRequestT, type FailureInfo, type OwnerAnswer as OwnerAnswerT, type Question as QuestionT } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, clarifications, decisions, documents, inboundMessages, invoiceIntakes, outboundMessages, supplierContacts, supplierRegistrations, suppliers, tenants, withTenant, type Db, type Tx } from '@gow/db'
import { pdfProtection } from '@gow/extraction'
import { isPdf, MAX_DOCUMENT_BYTES, type DocumentStorage, type ProcessJob, type RedecideJob, type ResumeJob } from '@gow/platform'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { ExpectedField, MessageInterpreter } from './interpret.ts'
import { OFFER_STEP, offerAmount } from './offer.ts'
import { completeRegistration, completeRfc, registrationPrompt, rfcAskReason, verdictText } from './registration.ts'

export type Resolution =
  | 'matched'
  | 'completed'
  | 'no_link'
  | 'no_open_clarification'
  | 'unparsed'
  | 'already_processed'
  | 'document_received'
  | 'document_duplicate'
  | 'document_rejected'
  | 'document_ambiguous'
  | 'registration_started'
  | 'registration_step'
  | 'registration_invalid'
  | 'registration_completed'
  | 'registration_waiting'
  | 'registered_idle'
  | 'intake_step'
  | 'intake_invalid'
  | 'intake_completed'
  | 'offer_accepted'
  | 'offer_invalid'
  | 'offer_skipped'
  // Aclaración por el chat (ADR 0051).
  | 'summary'
  | 'revising'
  | 'corrected'
  | 'confirmed'
  | 'awaiting_confirmation'
  | 'awaiting_analyst'
  | 'media_unsupported'

export interface InboundOptions {
  /** Hace falta para aceptar documentos; sin él, un documento se rechaza. */
  storage?: DocumentStorage
  /**
   * Demo (ADR 0038): un número de WhatsApp sin vínculo se registra conversando y queda como
   * proveedor verificado por posesión del número. Apagado, un número sin vínculo no abre nada.
   */
  selfRegistration?: boolean
  /** "Hoy" (AAAA-MM-DD) para rechazar un vencimiento ya pasado. */
  today?: () => string
  /**
   * Haiku para lo que las reglas no leen (ADR 0040). Propone; el lector determinista valida. Sin él,
   * o si falla, la conversación sigue solo con las reglas.
   */
  interpreter?: MessageInterpreter
  /**
   * Pedir monto, comprador y vencimiento de la factura antes de analizar (ADR 0039). Apagado (lo de
   * la demo), el estado de cuenta se analiza al llegar y el resultado es la línea máxima.
   */
  askInvoice?: boolean
}

export interface InboundResult {
  resolution: Resolution
  resume: ResumeJob | null
  /** Solo si el mensaje trajo un documento que abrió una solicitud: el trabajo a encolar. */
  process?: { job: ProcessJob; sha256: string }
  /** Si el intérprete con Haiku intervino en este mensaje. */
  interpreted?: boolean
  /** El proveedor dijo cuánto quiere adelantar (ADR 0053): reevaluar con ese monto. */
  redecide?: RedecideJob
}

/** Lo que salió de leer un dato: el valor, que no lo quiere dar, o por qué no se entendió. */
type FieldRead<T> = { value: T } | { skip: true } | { invalid: 'not_understood' | 'off_topic' | null }

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)
const OfferDraft = z.object({ max: z.number().positive() })
const InvoiceDraft = z.object({ amount: z.number().nullable().optional(), buyer: z.string().nullable().optional() })

export async function resolveInbound(db: Db, tenantId: string, messageId: string, opts: InboundOptions = {}): Promise<InboundResult> {
  const { storage, selfRegistration = false, askInvoice = false } = opts
  const today = opts.today ?? (() => calendarToday())
  return withTenant(db, tenantId, async (tx) => {
    const [msg] = await tx.select().from(inboundMessages).where(and(eq(inboundMessages.id, messageId), isNull(inboundMessages.processedAt)))
    if (!msg) return { resolution: 'already_processed', resume: null }
    const finish = async (resolution: Resolution, clarificationId: string | null, reply: { body: string; kind: string } | null, details: Record<string, string> = {}) => {
      // El adjunto se vacía siempre: si se aceptó ya está en el almacenamiento; si no, no se guarda.
      await tx.update(inboundMessages).set({ processedAt: new Date(), resolution, clarificationId, attachment: null }).where(eq(inboundMessages.id, msg.id))
      if (reply && msg.channel !== 'manual') await tx.insert(outboundMessages).values({ tenantId, clarificationId, kind: reply.kind, channel: msg.channel, destination: msg.fromAddress, body: reply.body })
      // El número va solo en la fila del mensaje; la bitácora lleva ids y la resolución.
      await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: `inbound.${resolution}`, subject: msg.id, details: { clarification_id: clarificationId, ...details, ...(interpreted ? { interpreted: 'haiku' } : {}) } })
    }
    let interpreted = false
    const done = (r: InboundResult): InboundResult => (interpreted ? { ...r, interpreted } : r)
    /**
     * Lee un dato del mensaje (ADR 0040). Campos con formato (RFC, monto, fecha): primero la regla y,
     * si no alcanza, Haiku. Texto libre (`free`): primero Haiku, que distingue un nombre de "asdfg";
     * sin él, la regla. Lo que propone Haiku vuelve a pasar por `parse`.
     */
    const readField = async <T>(field: ExpectedField, question: string, parse: (text: string) => T | null, o: { free?: boolean; allowSkip?: boolean; options?: readonly string[] } = {}): Promise<FieldRead<T>> => {
      if (o.allowSkip && isSkip(msg.body)) return { skip: true }
      if (!o.free) {
        const direct = parse(msg.body)
        if (direct !== null) return { value: direct }
      }
      const r = opts.interpreter && msg.body.trim() ? await opts.interpreter.interpret({ field, question, message: msg.body, today: today(), ...(o.options ? { options: o.options } : {}) }) : null
      if (r) {
        interpreted = true
        if (r.intent === 'answer' && r.value !== null) {
          const v = parse(r.value)
          return v === null ? { invalid: null } : { value: v }
        }
        if (r.intent === 'skip') return o.allowSkip ? { skip: true } : { invalid: 'not_understood' }
        return { invalid: r.intent === 'question' ? 'off_topic' : 'not_understood' }
      }
      if (o.free) {
        const direct = parse(msg.body)
        if (direct !== null) return { value: direct }
      }
      return { invalid: null }
    }
    /** Texto de repregunta: por qué no se entendió y la pregunta pendiente, o el texto específico del campo. */
    const reask = (why: 'not_understood' | 'off_topic' | null, question: string, specific: string) => (why ? `${CONVERSATION_FALLBACKS[why]}\n\n${question}` : specific)

    /**
     * Guarda el PDF del mensaje y abre una solicitud del proveedor. Un PDF ya guardado en el tenant
     * se reutiliza. `rejected` si el adjunto no es un PDF aceptable: `password` si pide contraseña
     * para abrirse (ADR 0049), que se contesta con su propio mensaje; `invalid` en cualquier otro caso.
     */
    const openApplication = async (supplierId: string, bytes: Buffer): Promise<{ applicationId: string; sha256: string } | { rejected: 'password' | 'invalid' }> => {
      if (!storage || bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES || !isPdf(bytes)) return { rejected: 'invalid' }
      if ((await pdfProtection(bytes)) === 'password') return { rejected: 'password' }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const [existing] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.sha256, sha256))
      let documentId = existing?.id
      if (!documentId) {
        // Si la transacción se revierte después, queda un archivo huérfano; nunca una fila sin archivo.
        const path = `${tenantId}/${randomUUID()}.pdf`
        await storage.put(path, bytes)
        const [doc] = await tx.insert(documents).values({ tenantId, supplierId, storagePath: path, sha256, sizeBytes: bytes.length, mediaType: 'application/pdf' }).returning({ id: documents.id })
        documentId = doc?.id
      }
      const [created] = await tx.insert(applications).values({ tenantId, supplierId, request: null, asOf: null }).returning({ id: applications.id })
      if (!documentId || !created) throw new Error('no se creó la solicitud del documento recibido')
      await tx.insert(applicationDocuments).values({ tenantId, applicationId: created.id, documentId })
      await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: 'application.received', subject: created.id, details: { inbound_message_id: msg.id } })
      return { applicationId: created.id, sha256 }
    }

    const links = await tx
      .select({ supplierId: supplierContacts.supplierId })
      .from(supplierContacts)
      .where(and(eq(supplierContacts.channel, msg.channel), eq(supplierContacts.address, msg.fromAddress), isNotNull(supplierContacts.verifiedAt)))

    /** La aclaración abierta más vieja de los proveedores de este vínculo con este destino. */
    const openClarification = async () => {
      if (links.length === 0) return undefined
      const [row] = await tx
        .select()
        .from(clarifications)
        .where(and(eq(clarifications.status, 'open'), eq(clarifications.channel, msg.channel), eq(clarifications.destination, msg.fromAddress), inArray(clarifications.supplierId, links.map((l) => l.supplierId))))
        .orderBy(asc(clarifications.createdAt))
        .limit(1)
      return row
    }

    // Registro de la demo con el estado de cuenta primero (ADR 0038 y 0047): solo WhatsApp. Lo lleva
    // un número sin vínculo, o uno cuyo registro sigue abierto (su contacto ya quedó verificado).
    const [reg] =
      selfRegistration && msg.channel === 'whatsapp'
        ? await tx
            .select()
            .from(supplierRegistrations)
            .where(and(eq(supplierRegistrations.channel, msg.channel), eq(supplierRegistrations.address, msg.fromAddress)))
        : []

    // Foto, nota de voz, video o sticker (ADR 0051): no se lee ni se guarda. Se contesta que hace falta
    // el PDF y se repite lo pendiente (registro, factura o aclaración), sin cambiar ningún estado.
    if (msg.mediaKind !== null) {
      let pendingText: string | null = null
      let clarificationId: string | null = null
      if (selfRegistration && msg.channel === 'whatsapp' && (links.length === 0 || (reg && reg.step !== 'done'))) pendingText = registrationPrompt(reg)
      else if (links.length > 0) {
        const [intake] = await tx
          .select({ step: invoiceIntakes.step, draft: invoiceIntakes.draft })
          .from(invoiceIntakes)
          .where(and(eq(invoiceIntakes.channel, msg.channel), eq(invoiceIntakes.address, msg.fromAddress), ne(invoiceIntakes.step, 'done')))
          .orderBy(desc(invoiceIntakes.createdAt))
          .limit(1)
        const open = intake ? undefined : await openClarification()
        const offerMax = intake?.step === OFFER_STEP ? OfferDraft.safeParse(intake.draft) : null
        if (offerMax?.success) pendingText = AMOUNT_OFFER.ask(offerMax.data.max)
        else if (intake) pendingText = intake.step === 'buyer' ? INVOICE_REPLIES.ask_buyer : intake.step === 'maturity' ? INVOICE_REPLIES.ask_maturity : INVOICE_REPLIES.ask_amount
        else if (open) {
          clarificationId = open.id
          pendingText = clarificationPrompt(open)
        }
      }
      await finish('media_unsupported', clarificationId, { body: pendingText ? `${MEDIA_UNSUPPORTED}\n\n${pendingText}` : MEDIA_UNSUPPORTED, kind: 'media' }, { media_kind: msg.mediaKind })
      return { resolution: 'media_unsupported', resume: null }
    }

    if (selfRegistration && msg.channel === 'whatsapp' && (links.length === 0 || (reg && reg.step !== 'done'))) {
      const say = (body: string) => ({ body, kind: 'registration' })
      const reply = async (resolution: Resolution, body: string) => {
        await finish(resolution, null, say(body))
        return done({ resolution, resume: null })
      }
      if (!reg || reg.step === 'done') {
        // Sin registro, o con uno terminado cuyo contacto ya no está verificado: se empieza de nuevo.
        const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
        const fresh = { step: 'statement', legalName: null, rfc: null, holderName: null, holderRfc: null, corrected: false, supplierId: null, applicationId: null, updatedAt: new Date() }
        if (reg) await tx.update(supplierRegistrations).set(fresh).where(eq(supplierRegistrations.id, reg.id))
        else await tx.insert(supplierRegistrations).values({ tenantId, channel: msg.channel, address: msg.fromAddress, ...fresh })
        return reply('registration_started', REGISTRATION_REPLIES.welcome(tenant?.name ?? 'GOW Credit'))
      }
      const save = (set: Partial<typeof supplierRegistrations.$inferInsert>) => tx.update(supplierRegistrations).set({ ...set, updatedAt: new Date() }).where(eq(supplierRegistrations.id, reg.id))

      // Lo que sigue con el nombre y el RFC que hay; con todo, el registro termina y sale el resultado.
      const advance = async (data: { legalName: string | null; rfc: string | null; representative?: string }) => {
        if (!data.legalName) {
          await save({ step: 'name', legalName: null, rfc: data.rfc })
          return reply('registration_step', REGISTRATION_REPLIES.ask_name)
        }
        if (!data.rfc) {
          await save({ step: 'rfc', legalName: data.legalName, rfc: null })
          return reply('registration_step', REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg)))
        }
        if (personTypeOf(data.rfc) === 'moral' && !data.representative) {
          await save({ step: 'representative', legalName: data.legalName, rfc: data.rfc })
          return reply('registration_step', REGISTRATION_REPLIES.ask_representative)
        }
        const c = await completeRegistration(tx, tenantId, reg, { legalName: data.legalName, rfc: data.rfc, representative: data.representative ?? null })
        await finish('registration_completed', c.clarificationId, c.reply, { supplier_id: reg.supplierId ?? '' })
        return done({ resolution: 'registration_completed', resume: c.resume })
      }

      // Un registro que quedó a medias con el flujo anterior (razón social y RFC primero) vuelve al inicio.
      const step = reg.step === 'legal_name' || (reg.step === 'rfc' && !reg.applicationId) ? 'statement' : reg.step
      if (step === 'statement') {
        if (msg.attachment === null) return reply('registration_waiting', REGISTRATION_REPLIES.ask_statement)
        let supplierId = reg.supplierId
        if (!supplierId) {
          // Proveedor sin identidad hasta que confirme sus datos. Verificado por posesión: el mensaje
          // llegó desde ese número. No equivale a un KYC.
          const [created] = await tx.insert(suppliers).values({ tenantId, legalName: null, rfc: null }).returning({ id: suppliers.id })
          if (!created) throw new Error('no se creó el proveedor del registro')
          supplierId = created.id
          await tx.insert(supplierContacts).values({ tenantId, supplierId, channel: msg.channel, address: msg.fromAddress, verifiedAt: new Date(), verificationMethod: 'whatsapp_self_registration' })
          await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: 'supplier.created', subject: supplierId, details: { source: 'whatsapp_statement_first', inbound_message_id: msg.id } })
        }
        const opened = await openApplication(supplierId, msg.attachment)
        if ('rejected' in opened) {
          await save({ supplierId })
          await finish('document_rejected', null, { body: opened.rejected === 'password' ? DOCUMENT_REPLIES.password_protected : DOCUMENT_REPLIES.rejected, kind: 'document' }, { reason: opened.rejected })
          return { resolution: 'document_rejected', resume: null }
        }
        await save({ step: 'reading', supplierId, applicationId: opened.applicationId })
        await finish('document_received', null, say(REGISTRATION_REPLIES.reading), { application_id: opened.applicationId })
        return { resolution: 'document_received', resume: null, process: { job: { tenant_id: tenantId, application_id: opened.applicationId }, sha256: opened.sha256 } }
      }
      if (step === 'reading') return reply('registration_waiting', REGISTRATION_REPLIES.still_reading)

      const holderName = reg.holderName ?? ''
      const current =
        step === 'confirm'
          ? REGISTRATION_REPLIES.confirm(holderName, completeRfc(reg.holderRfc))
          : step === 'rfc'
            ? REGISTRATION_REPLIES.ask_rfc(rfcAskReason(reg))
            : step === 'representative'
              ? REGISTRATION_REPLIES.ask_representative
              : reg.corrected
                ? REGISTRATION_REPLIES.ask_name_corrected
                : REGISTRATION_REPLIES.ask_name
      if (msg.attachment !== null) return reply('registration_invalid', `${REGISTRATION_REPLIES.pending_first}\n\n${current}`)

      if (step === 'confirm') {
        const read = await readField('option', current, parseYesNo, { options: ['Sí, son correctos', 'No, no son correctos'] })
        if (!('value' in read)) return reply('registration_invalid', reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_yes_no))
        if (read.value) return advance({ legalName: holderName, rfc: completeRfc(reg.holderRfc) })
        await save({ step: 'name', corrected: true, legalName: null, rfc: null })
        return reply('registration_step', REGISTRATION_REPLIES.ask_name_corrected)
      }
      if (step === 'name') {
        const read = await readField('legal_name', current, parseLegalName, { free: true })
        if (!('value' in read)) return reply('registration_invalid', reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_name))
        // Sin corrección, un RFC completo del documento se conserva; corregido, se pide siempre.
        return advance({ legalName: read.value, rfc: reg.corrected ? null : completeRfc(reg.holderRfc) })
      }
      if (step === 'rfc') {
        const read = await readField('rfc', current, parseRfc)
        if (!('value' in read)) return reply('registration_invalid', reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_rfc))
        const why = rfcAskReason(reg)
        if (why.kind === 'root' && !read.value.startsWith(why.root)) return reply('registration_invalid', REGISTRATION_REPLIES.rfc_root_mismatch(why.root))
        return advance({ legalName: reg.legalName, rfc: read.value })
      }
      const read = await readField('legal_name', current, parseLegalName, { free: true })
      if (!('value' in read)) return reply('registration_invalid', reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_representative))
      return advance({ legalName: reg.legalName, rfc: reg.rfc, representative: read.value })
    }

    // Datos de la factura pendientes (ADR 0039): van antes que las aclaraciones porque la solicitud
    // todavía no se analiza. Solo para un número con vínculo verificado.
    const [intake] = links.length
      ? await tx
          .select()
          .from(invoiceIntakes)
          .where(and(eq(invoiceIntakes.channel, msg.channel), eq(invoiceIntakes.address, msg.fromAddress), ne(invoiceIntakes.step, 'done')))
          .orderBy(desc(invoiceIntakes.createdAt))
          .limit(1)
      : []
    // Monto que pide después de la oferta de la línea máxima (ADR 0053). Un PDF nuevo cierra la oferta
    // y sigue como cualquier documento.
    if (intake?.step === OFFER_STEP) {
      const offer = OfferDraft.safeParse(intake.draft)
      const close = () => tx.update(invoiceIntakes).set({ step: 'done', updatedAt: new Date() }).where(eq(invoiceIntakes.applicationId, intake.applicationId))
      if (msg.attachment !== null || !offer.success) await close()
      else {
        const max = offer.data.max
        const say = (body: string) => ({ body, kind: 'offer' })
        const current = AMOUNT_OFFER.ask(max)
        const read = await readField('amount', current, parseAmount, { allowSkip: true })
        if ('skip' in read) {
          await close()
          await finish('offer_skipped', null, say(AMOUNT_OFFER.skipped), { application_id: intake.applicationId })
          return done({ resolution: 'offer_skipped', resume: null })
        }
        if ('invalid' in read) {
          await finish('offer_invalid', null, say(reask(read.invalid, current, AMOUNT_OFFER.invalid(max))))
          return done({ resolution: 'offer_invalid', resume: null })
        }
        if (read.value > max + 0.005) {
          await finish('offer_invalid', null, say(AMOUNT_OFFER.over(max)))
          return done({ resolution: 'offer_invalid', resume: null })
        }
        // El monto entra a la solicitud y la reevaluación decide con él, sin modelos (redecide.ts).
        const request = ApplicationRequest.parse({ amount: read.value, maturity: null, buyer: null })
        await tx.update(applications).set({ request, status: 'deciding', updatedAt: new Date() }).where(eq(applications.id, intake.applicationId))
        await close()
        await finish('offer_accepted', null, say(AMOUNT_OFFER.reviewing(read.value)), { application_id: intake.applicationId })
        return done({ resolution: 'offer_accepted', resume: null, redecide: { tenant_id: tenantId, application_id: intake.applicationId, correction_batch: randomUUID() } })
      }
    }
    // Una conversación de factura que quedó abierta se termina aunque la opción ya esté apagada.
    if (intake && intake.step !== OFFER_STEP) {
      const ask = (body: string) => ({ body, kind: 'invoice' })
      const draft = InvoiceDraft.parse(intake.draft)
      const current = intake.step === 'buyer' ? INVOICE_REPLIES.ask_buyer : intake.step === 'maturity' ? INVOICE_REPLIES.ask_maturity : INVOICE_REPLIES.ask_amount
      const save = (step: string, next: z.infer<typeof InvoiceDraft>) => tx.update(invoiceIntakes).set({ step, draft: next, updatedAt: new Date() }).where(eq(invoiceIntakes.applicationId, intake.applicationId))
      const complete = async (request: ApplicationRequestT | null) => {
        await tx.update(applications).set({ request, updatedAt: new Date() }).where(eq(applications.id, intake.applicationId))
        await save('done', draft)
        await finish('intake_completed', null, ask(INVOICE_REPLIES.analyzing(describeInvoice(request))), { application_id: intake.applicationId })
        return { resolution: 'intake_completed' as const, resume: null, process: { job: { tenant_id: tenantId, application_id: intake.applicationId }, sha256: intake.documentSha256 } }
      }
      if (msg.attachment !== null) {
        await finish('intake_invalid', null, ask(`${INVOICE_REPLIES.pending_first}\n\n${current}`))
        return { resolution: 'intake_invalid', resume: null }
      }
      const invalid = async (text: string) => {
        await finish('intake_invalid', null, ask(text))
        return done({ resolution: 'intake_invalid', resume: null })
      }
      if (intake.step === 'amount') {
        const read = await readField('amount', current, parseAmount, { allowSkip: true })
        if ('skip' in read) return done(await complete(null))
        if ('invalid' in read) return invalid(reask(read.invalid, current, INVOICE_REPLIES.invalid_amount))
        await save('buyer', { ...draft, amount: read.value })
        await finish('intake_step', null, ask(INVOICE_REPLIES.ask_buyer))
        return done({ resolution: 'intake_step', resume: null })
      }
      if (intake.step === 'buyer') {
        const read = await readField('buyer', current, parseLegalName, { free: true, allowSkip: true })
        if ('invalid' in read) return invalid(reask(read.invalid, current, INVOICE_REPLIES.invalid_buyer))
        await save('maturity', { ...draft, buyer: 'value' in read ? read.value : null })
        await finish('intake_step', null, ask(INVOICE_REPLIES.ask_maturity))
        return done({ resolution: 'intake_step', resume: null })
      }
      // Una fecha pasada es una lectura válida que se rechaza: no se le pide a Haiku otra.
      const read = await readField('maturity', current, (t) => parseMaturity(t, today()), { allowSkip: true })
      if ('invalid' in read) return invalid(reask(read.invalid, current, INVOICE_REPLIES.invalid_maturity))
      if ('value' in read && 'past' in read.value) return invalid(INVOICE_REPLIES.past_maturity)
      const maturity = 'value' in read && 'date' in read.value ? read.value.date : null
      return done(await complete(ApplicationRequest.parse({ amount: draft.amount ?? null, maturity, buyer: draft.buyer ? { name: draft.buyer, rfc: null, aliases: [] } : null })))
    }

    if (msg.attachment !== null) {
      const reply = (key: keyof typeof DOCUMENT_REPLIES) => ({ body: DOCUMENT_REPLIES[key], kind: 'document' })
      const suppliers = [...new Set(links.map((l) => l.supplierId))]
      if (suppliers.length === 0) {
        await finish('no_link', null, reply('no_link'))
        return { resolution: 'no_link', resume: null }
      }
      const [supplierId] = suppliers
      if (suppliers.length > 1 || !supplierId) {
        await finish('document_ambiguous', null, reply('ambiguous'))
        return { resolution: 'document_ambiguous', resume: null }
      }
      const bytes = msg.attachment
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const [existing] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.sha256, sha256))
      if (existing) {
        // La solicitud más reciente de ese documento: la respuesta depende de cómo terminó.
        const [prev] = await tx
          .select({ id: applications.id, status: applications.status, failureReason: applications.failureReason, request: applications.request })
          .from(applicationDocuments)
          .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
          .where(eq(applicationDocuments.documentId, existing.id))
          .orderBy(desc(applications.createdAt))
          .limit(1)
        const failure = prev?.status === 'failed' ? describeFailure(prev.failureReason) : null
        // Un error nuestro se puede reintentar con el mismo archivo: se abre una solicitud nueva abajo.
        if (prev && failure?.kind !== 'internal') {
          const body = await duplicateReply(tx, prev, failure, msg.channel === 'whatsapp' ? { tenantId, address: msg.fromAddress } : null)
          await finish('document_duplicate', null, { body, kind: 'document' }, { application_id: prev.id, previous_status: prev.status })
          return { resolution: 'document_duplicate', resume: null }
        }
      }
      const opened = await openApplication(supplierId, bytes)
      if ('rejected' in opened) {
        await finish('document_rejected', null, reply(opened.rejected === 'password' ? 'password_protected' : 'rejected'), { reason: opened.rejected })
        return { resolution: 'document_rejected', resume: null }
      }
      const created = { id: opened.applicationId }
      if (askInvoice) {
        // Con preguntas de factura (ADR 0039), el análisis espera a los datos y se encola al terminar.
        await tx.insert(invoiceIntakes).values({ applicationId: created.id, tenantId, channel: msg.channel, address: msg.fromAddress, step: 'amount', documentSha256: sha256 })
        await finish('document_received', null, { body: INVOICE_REPLIES.ask_amount, kind: 'invoice' }, { application_id: created.id })
        return { resolution: 'document_received', resume: null }
      }
      // Sin preguntas (lo de la demo): se analiza ya y el resultado es la línea máxima.
      await finish('document_received', null, reply('received'), { application_id: created.id })
      return { resolution: 'document_received', resume: null, process: { job: { tenant_id: tenantId, application_id: created.id }, sha256 } }
    }

    if (links.length === 0) {
      await finish('no_link', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_link', resume: null }
    }
    const open = await openClarification()
    if (!open) {
      if (selfRegistration && msg.channel === 'whatsapp') {
        // En la demo, un proveedor registrado que saluda recibe qué hacer, no la respuesta genérica.
        const [s] = await tx.select({ legalName: suppliers.legalName }).from(suppliers).where(inArray(suppliers.id, links.map((l) => l.supplierId))).limit(1)
        await finish('registered_idle', null, { body: REGISTRATION_REPLIES.idle(s?.legalName ?? 'tu empresa'), kind: 'registration' })
        return { resolution: 'registered_idle', resume: null }
      }
      await finish('no_open_clarification', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_open_clarification', resume: null }
    }

    // Aclaración abierta (ADR 0051): pregunta por pregunta (`asking`), varias respuestas en un mensaje,
    // un resumen para confirmar (`confirming`), cambiar una respuesta (`revising`) y, confirmado, la
    // reanudación o, si quedan preguntas para el analista, el aviso (`confirmed`).
    const questions: QuestionT[] = Questions.parse(open.questions)
    let answers = Answers.parse(open.answers)
    const convo = conversationalIndexes(questions)
    const answer = async (resolution: Resolution, body: string, kind: string, set: PgUpdateSetSource<typeof clarifications> = {}, resume: ResumeJob | null = null) => {
      if (Object.keys(set).length > 0) await tx.update(clarifications).set(set).where(eq(clarifications.id, open.id))
      await finish(resolution, open.id, { body, kind })
      return done({ resolution, resume })
    }
    const withAnswers = (given: readonly OwnerAnswerT[]) => [...answers.filter((a) => !given.some((g) => g.question_id === a.question_id)), ...given]
    /** Lee una respuesta a la pregunta `q`: reglas y, si hay opciones y no alcanzan, Haiku (ADR 0040). */
    const readOne = async (q: QuestionT): Promise<{ answer: OwnerAnswerT | null; offTopic: boolean }> => {
      const direct = parseReply(msg.body, q)
      if (direct || q.options.length === 0) return { answer: direct, offTopic: false }
      // Haiku solo traduce la respuesta a una opción; parseReply sigue siendo quien la acepta.
      const read = await readField('option', q.text, (t) => parseReply(t, q), { options: q.options.map((o) => o.label) })
      return { answer: 'value' in read ? read.value : null, offTopic: 'invalid' in read && read.invalid === 'off_topic' }
    }
    const reaskText = (q: QuestionT, offTopic: boolean) => (offTopic ? `${CONVERSATION_FALLBACKS.off_topic}\n\n${renderReask(q)}` : renderReask(q))

    if (open.step === 'confirmed') return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst')

    if (open.step === 'confirming') {
      const summary = () => renderSummary(questions, answers)
      let read = parseConfirmation(msg.body, questions)
      if (!read) {
        // Sí o no con Haiku cuando las reglas no alcanzan; una corrección se pide con el número.
        const yes = await readField('option', summary(), parseYesNo, { options: ['Sí, es correcto', 'No, quiero cambiar una respuesta'] })
        if ('value' in yes) read = yes.value ? { kind: 'confirm' } : { kind: 'reject' }
      }
      if (!read) return answer('awaiting_confirmation', `${CONVERSATION_FALLBACKS.not_understood}\n\n${summary()}`, 'summary')
      if (read.kind === 'reject') return answer('awaiting_confirmation', CONFIRMATION_REPLIES.which, 'summary')
      if (read.kind === 'change' || read.kind === 'correct') {
        const index = convo[read.number - 1]
        if (index === undefined) return answer('awaiting_confirmation', `${CONFIRMATION_REPLIES.no_such(read.number, convo.length)}\n\n${summary()}`, 'summary')
        if (read.kind === 'change') return answer('revising', renderQuestionAt(questions, index), 'question', { step: 'revising', currentQuestion: index })
        answers = withAnswers([read.answer])
        return answer('corrected', `${CONFIRMATION_REPLIES.changed(read.number)}\n\n${summary()}`, 'summary', { answers })
      }
      // Confirmado: con todo contestado se reanuda; si quedan preguntas para el analista, se le avisa.
      if (isComplete(questions, answers)) return answer('completed', CONFIRMATION_REPLIES.sent, 'confirmation', { step: 'confirmed', status: 'answered', answeredAt: sql`now()` }, { tenant_id: tenantId, application_id: open.applicationId, clarification_id: open.id })
      return answer('confirmed', CONFIRMATION_REPLIES.sent_analyst, 'analyst', { step: 'confirmed' })
    }

    const current = questions[open.currentQuestion]
    if (!current || !isConversational(current)) return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst', { step: 'confirmed' })

    if (open.step === 'revising') {
      const read = await readOne(current)
      if (!read.answer) return answer('unparsed', reaskText(current, read.offTopic), 'reask')
      answers = withAnswers([read.answer])
      return answer('corrected', `${CONFIRMATION_REPLIES.changed(convo.indexOf(open.currentQuestion) + 1)}\n\n${renderSummary(questions, answers)}`, 'summary', { answers, step: 'confirming' })
    }

    // Varias respuestas en un mensaje: van a la actual y a las siguientes, en orden. Primero las reglas.
    const pending = convo.filter((i) => i >= open.currentQuestion).map((i) => questions[i] as QuestionT)
    const multi = parseMultipleReplies(msg.body, pending)
    let given: OwnerAnswerT[]
    if (multi?.kind === 'answers') given = multi.answers
    else if (multi) return answer('unparsed', `${multi.kind === 'too_many' ? CONFIRMATION_REPLIES.too_many(multi.given, multi.pending) : CONVERSATION_FALLBACKS.not_understood}\n\n${renderQuestionAt(questions, open.currentQuestion)}`, 'reask')
    else {
      const read = await readOne(current)
      if (!read.answer) return answer('unparsed', reaskText(current, read.offTopic), 'reask')
      given = [read.answer]
    }
    answers = withAnswers(given)
    const answered = new Set(answers.map((a) => a.question_id))
    const next = convo.find((i) => !answered.has((questions[i] as QuestionT).id))
    if (next !== undefined) return answer('matched', renderQuestionAt(questions, next), 'question', { answers, currentQuestion: next })
    // Contestadas todas las del chat: el resumen, antes de evaluar.
    return answer('summary', renderSummary(questions, answers), 'summary', { answers, step: 'confirming' })
  })
}

/** Lo que la aclaración está esperando: la pregunta actual, el resumen o, si ya confirmó, el aviso del analista. */
function clarificationPrompt(open: typeof clarifications.$inferSelect): string {
  const questions = Questions.parse(open.questions)
  if (open.step === 'confirming') return renderSummary(questions, Answers.parse(open.answers))
  const q = questions[open.currentQuestion]
  return open.step !== 'confirmed' && q && isConversational(q) ? renderQuestionAt(questions, open.currentQuestion) : ANALYST_NOTICE
}

/** Mensajes entrantes sin procesar de todos los tenants (función revisada, solo ids). */
export async function pendingInbound(db: Db, limit = 50): Promise<{ id: string; tenant_id: string }[]> {
  const res = await db.execute<{ id: string; tenant_id: string }>(sql`select id, tenant_id from app.pending_inbound(${limit})`)
  return res.rows
}

/**
 * Qué contestar a un PDF que ya se había mandado (ADR 0041): si sigue en análisis, que no hace falta
 * mandarlo; si falló, el mismo motivo; si ya tiene veredicto, el mismo aviso. Nunca "en revisión"
 * para algo que ya terminó.
 */
async function duplicateReply(tx: Tx, prev: { id: string; status: string; request: unknown }, failure: FailureInfo | null, whatsapp: { tenantId: string; address: string } | null): Promise<string> {
  if (failure) return failureNotice(failure)
  const verdict = await verdictText(tx, prev)
  if (!verdict) return DOCUMENT_REPLIES.duplicate
  // Si aún no dijo cuánto quiere adelantar, se le vuelve a preguntar (ADR 0053).
  const [d] = whatsapp ? await tx.select({ limit: decisions.limitAmount }).from(decisions).where(and(eq(decisions.applicationId, prev.id), eq(decisions.kind, 'active'))).orderBy(desc(decisions.createdAt)).limit(1) : []
  const offer = whatsapp ? await offerAmount(tx, { tenantId: whatsapp.tenantId, applicationId: prev.id, status: prev.status, limit: d?.limit == null ? null : Number(d.limit), request: prev.request, channel: 'whatsapp', address: whatsapp.address }) : null
  return `Ya habíamos revisado este estado de cuenta. ${verdict}${offer ? `\n\n${offer}` : ''}`
}
