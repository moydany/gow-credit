/**
 * Resolution of each inbound message:
 *
 * 1. A message arrives from N on tenant T's channel (the WhatsApp process or the email webhook
 *    already fixed T).
 * 2. Verified links (T, channel, N). No link: fixed reply and a log entry; nothing is enqueued.
 * 3. With a link: only the open clarifications of those suppliers with that destination. The
 *    message text never authorizes anything: quoting someone else's folio does not open that request.
 * 4. The reply is read against the expected question; ambiguous -> re-ask with numbers. One
 *    message may carry several answers ("1, 3, 1"): they go to the current question and the next ones.
 * 5. Once the chat questions are answered, a summary is sent; on "yes", the clarification becomes
 *    `answered` and the resume is enqueued; with a number or a correction, that answer is changed
 *    and it returns to the summary. If analyst questions remain, the analyst is notified.
 *
 * A photo, voice note, video or sticker is not read: the reply says the PDF is needed and repeats
 * what is pending.
 *
 * A message with a document does not answer clarifications, with one exception: if the full PDF
 * was requested because of missing pages (`isDocumentRequest`), the new PDF answers that question,
 * is added to the same request and its resume is enqueued. Otherwise, with a single supplier on
 * the verified link and a valid PDF, it opens a request, like the API with an ingest key, and
 * its processing is enqueued. The bytes move from the inbound row to the tenant's storage and the
 * column is emptied. The sender only gets a fixed text reply.
 *
 * With `selfRegistration` (demo only), an unlinked WhatsApp number does not get the fixed reply:
 * it is asked its name and the amount it wants, then its bank statement, which is analyzed
 * immediately with that amount; once read, it confirms or
 * corrects the holder and RFC, fills in what is missing and, for a persona moral, gives its legal
 * representative. Then it becomes a supplier with its identity and the result goes out
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
  documentRequestReplies,
  GENERIC_NO_PENDING,
  INVOICE_REPLIES,
  isComplete,
  isConversational,
  isDocumentRequest,
  isSkip,
  MEDIA_UNSUPPORTED,
  parseAmount,
  parseConfirmation,
  parseContactName,
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
import { ApplicationRequest, calendarToday, describeFailure, OwnerAnswer, Question, type ApplicationRequest as ApplicationRequestT, type OwnerAnswer as OwnerAnswerT, type Question as QuestionT } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, clarifications, documents, inboundMessages, invoiceIntakes, outboundMessages, supplierContacts, supplierRegistrations, suppliers, tenants, withTenant, type Db } from '@gow/db'
import { pdfProtection } from '@gow/extraction'
import { isPdf, MAX_DOCUMENT_BYTES, type ResumeJob } from '@gow/platform'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { ExpectedField } from './interpret.ts'
import type { InboundOptions, InboundResult, Resolution } from './inbound-types.ts'
import { OFFER_STEP } from './offer.ts'
import { documentRequestOf, duplicateReply, pendingChatPrompt } from './inbound-replies.ts'
import { completeRegistration, completeRfc, pendingStatement, registrationPrompt, registrationSupplier, rfcAskReason } from './registration.ts'

/** What came out of reading a value: the value, that they will not give it, or why it was not understood. */
type FieldRead<T> = { value: T } | { skip: true } | { invalid: 'not_understood' | 'off_topic' | null }

const Questions = z.array(Question)
const Answers = z.array(OwnerAnswer)
const OfferDraft = z.object({ max: z.number().positive() })
type Registration = typeof supplierRegistrations.$inferSelect
const InvoiceDraft = z.object({ amount: z.number().nullable().optional(), buyer: z.string().nullable().optional() })

export type { InboundOptions, InboundResult, Resolution }

export async function resolveInbound(db: Db, tenantId: string, messageId: string, opts: InboundOptions = {}): Promise<InboundResult> {
  const { storage, selfRegistration = false, askInvoice = false } = opts
  const today = opts.today ?? (() => calendarToday())
  return withTenant(db, tenantId, async (tx) => {
    const [msg] = await tx.select().from(inboundMessages).where(and(eq(inboundMessages.id, messageId), isNull(inboundMessages.processedAt)))
    if (!msg) return { resolution: 'already_processed', resume: null }
    const finish = async (resolution: Resolution, clarificationId: string | null, reply: { body: string; kind: string } | null, details: Record<string, string> = {}) => {
      // The attachment is always emptied: if accepted it is already in storage; if not, it is not kept.
      await tx.update(inboundMessages).set({ processedAt: new Date(), resolution, clarificationId, attachment: null }).where(eq(inboundMessages.id, msg.id))
      if (reply && msg.channel !== 'manual') await tx.insert(outboundMessages).values({ tenantId, clarificationId, kind: reply.kind, channel: msg.channel, destination: msg.fromAddress, body: reply.body })
      // The number goes only in the message row; the audit log carries ids and the resolution.
      await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: `inbound.${resolution}`, subject: msg.id, details: { clarification_id: clarificationId, ...details, ...(interpreted ? { interpreted: 'haiku' } : {}) } })
    }
    let interpreted = false
    const done = (r: InboundResult): InboundResult => (interpreted ? { ...r, interpreted } : r)
    /**
     * Reads a value from the message. Formatted fields (RFC, amount, date): rule first and, if it
     * falls short, Haiku. Free text (`free`): Haiku first, which tells a name from "asdfg"; without
     * it, the rule. What Haiku proposes goes back through `parse`.
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
    /** Re-ask text: why it was not understood and the pending question, or the field's specific text. */
    const reask = (why: 'not_understood' | 'off_topic' | null, question: string, specific: string) => (why ? `${CONVERSATION_FALLBACKS[why]}\n\n${question}` : specific)

    /**
     * Validates and stores the message's PDF in the tenant's storage. A PDF already stored in the
     * tenant is reused. `rejected`: `password` if it needs a password to open, answered with its
     * own message; `invalid` otherwise. `supplier` may be a function: it is called only once the PDF
     * is valid (registration creates the supplier then, not for a rejected file).
     */
    const storeDocument = async (supplier: string | (() => Promise<string>), bytes: Buffer): Promise<{ documentId: string; storagePath: string; sha256: string } | { rejected: 'password' | 'invalid' }> => {
      if (!storage || bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES || !isPdf(bytes)) return { rejected: 'invalid' }
      if ((await pdfProtection(bytes)) === 'password') return { rejected: 'password' }
      const supplierId = typeof supplier === 'string' ? supplier : await supplier()
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const [existing] = await tx.select({ id: documents.id, storagePath: documents.storagePath }).from(documents).where(eq(documents.sha256, sha256))
      if (existing) return { documentId: existing.id, storagePath: existing.storagePath, sha256 }
      // If the transaction rolls back later, an orphan file remains; never a row without a file.
      const storagePath = `${tenantId}/${randomUUID()}.pdf`
      await storage.put(storagePath, bytes)
      const [doc] = await tx.insert(documents).values({ tenantId, supplierId, storagePath, sha256, sizeBytes: bytes.length, mediaType: 'application/pdf' }).returning({ id: documents.id })
      if (!doc) throw new Error('no se guardó el documento recibido')
      return { documentId: doc.id, storagePath, sha256 }
    }

    /**
     * Stores the message's PDF and opens a request for the supplier. A PDF already stored in the
     * tenant is reused. `rejected` if the attachment is not an acceptable PDF: `password` if it
     * needs a password to open, answered with its own message; `invalid` otherwise.
     */
    const openApplication = async (supplierId: string, bytes: Buffer): Promise<{ applicationId: string; sha256: string } | { rejected: 'password' | 'invalid' }> => {
      const stored = await storeDocument(supplierId, bytes)
      if ('rejected' in stored) return stored
      return openWithDocument(supplierId, stored)
    }

    /** Opens a request with a document already stored. `inboundId`: the message that brought the PDF, if not this one. */
    const openWithDocument = async (supplierId: string, doc: { documentId: string; sha256: string }, request: ApplicationRequestT | null = null, inboundId = msg.id): Promise<{ applicationId: string; sha256: string }> => {
      const [created] = await tx.insert(applications).values({ tenantId, supplierId, request, asOf: null }).returning({ id: applications.id })
      if (!created) throw new Error('no se creó la solicitud del documento recibido')
      await tx.insert(applicationDocuments).values({ tenantId, applicationId: created.id, documentId: doc.documentId })
      await tx.insert(auditLog).values({ tenantId, actor: `inbound:${msg.channel}`, action: 'application.received', subject: created.id, details: { inbound_message_id: inboundId } })
      return { applicationId: created.id, sha256: doc.sha256 }
    }

    const links = await tx
      .select({ supplierId: supplierContacts.supplierId })
      .from(supplierContacts)
      .where(and(eq(supplierContacts.channel, msg.channel), eq(supplierContacts.address, msg.fromAddress), isNotNull(supplierContacts.verifiedAt)))

    /** The oldest open clarification of this link's suppliers with this destination. */
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

    // Demo registration with the bank statement first: WhatsApp only. Carried by an unlinked
    // number, or one whose registration is still open (its contact is already verified).
    const [reg] =
      selfRegistration && msg.channel === 'whatsapp'
        ? await tx
            .select()
            .from(supplierRegistrations)
            .where(and(eq(supplierRegistrations.channel, msg.channel), eq(supplierRegistrations.address, msg.fromAddress)))
        : []

    // Photo, voice note, video or sticker: neither read nor stored. The reply says the PDF is needed
    // and repeats what is pending (registration, invoice or clarification), changing no state.
    if (msg.mediaKind !== null) {
      let pendingText: string | null = null
      let clarificationId: string | null = null
      if (selfRegistration && msg.channel === 'whatsapp' && (links.length === 0 || (reg && reg.step !== 'done'))) pendingText = registrationPrompt(reg)
      else if (links.length > 0) ({ text: pendingText, clarificationId } = await pendingChatPrompt(tx, msg, openClarification))
      await finish('media_unsupported', clarificationId, { body: pendingText ? `${MEDIA_UNSUPPORTED}\n\n${pendingText}` : MEDIA_UNSUPPORTED, kind: 'media' }, { media_kind: msg.mediaKind })
      return { resolution: 'media_unsupported', resume: null }
    }

    if (selfRegistration && msg.channel === 'whatsapp' && (links.length === 0 || (reg && reg.step !== 'done'))) {
      const say = (body: string) => ({ body, kind: 'registration' })
      const reply = async (resolution: Resolution, body: string) => {
        await finish(resolution, null, say(body))
        return done({ resolution, resume: null })
      }
      const rejectedText = (why: 'password' | 'invalid') => (why === 'password' ? DOCUMENT_REPLIES.password_protected : DOCUMENT_REPLIES.rejected)
      // Supplier with no identity until they confirm their data, created with the first valid PDF.
      // Verified by possession: the message came from that number. Not equivalent to KYC.
      const supplierFor = (row: Registration) => () => registrationSupplier(tx, row, msg)
      /** A PDF before the name and amount: stored and left waiting until both are given. */
      const keepStatement = async (row: Registration, bytes: Buffer): Promise<{ rejected: 'password' | 'invalid' } | { documentId: string }> => {
        const stored = await storeDocument(supplierFor(row), bytes)
        if ('rejected' in stored) return stored
        await tx.update(supplierRegistrations).set({ pendingDocumentId: stored.documentId, updatedAt: new Date() }).where(eq(supplierRegistrations.id, row.id))
        return { documentId: stored.documentId }
      }

      if (!reg || reg.step === 'done') {
        // No registration, or a finished one whose contact is no longer verified: start over, asking
        // the name and the amount before the statement.
        const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
        const fresh = { step: 'contact_name', contactName: null, requestedAmount: null, pendingDocumentId: null, legalName: null, rfc: null, holderName: null, holderRfc: null, corrected: false, supplierId: null, applicationId: null, updatedAt: new Date() }
        const [row] = reg
          ? await tx.update(supplierRegistrations).set(fresh).where(eq(supplierRegistrations.id, reg.id)).returning()
          : await tx.insert(supplierRegistrations).values({ tenantId, channel: msg.channel, address: msg.fromAddress, ...fresh }).returning()
        if (!row) throw new Error('no se guardó el registro')
        const tenantName = tenant?.name ?? 'GOW Credit'
        if (msg.attachment === null) return reply('registration_started', REGISTRATION_REPLIES.welcome(tenantName))
        const kept = await keepStatement(row, msg.attachment)
        if ('rejected' in kept) {
          await finish('registration_started', null, say(REGISTRATION_REPLIES.welcome(tenantName, false, rejectedText(kept.rejected))), { reason: kept.rejected })
          return done({ resolution: 'registration_started', resume: null })
        }
        await finish('registration_started', null, say(REGISTRATION_REPLIES.welcome(tenantName, true)), { document_id: kept.documentId })
        return done({ resolution: 'registration_started', resume: null })
      }
      const save = (set: Partial<typeof supplierRegistrations.$inferInsert>) => tx.update(supplierRegistrations).set({ ...set, updatedAt: new Date() }).where(eq(supplierRegistrations.id, reg.id))
      /** The amount they asked for, as the request's amount (no buyer or due date); null without one. */
      const requestOf = (amount: number | null) => (amount === null ? null : ApplicationRequest.parse({ amount, maturity: null, buyer: null }))

      /** Opens the request with the statement and analyzes it now; the result waits for registration. */
      const startReading = async (supplierId: string, doc: { documentId: string; sha256: string }, amount: number | null, inboundId?: string) => {
        const opened = await openWithDocument(supplierId, doc, requestOf(amount), inboundId)
        await save({ step: 'reading', supplierId, applicationId: opened.applicationId, pendingDocumentId: null })
        await finish('document_received', null, say(REGISTRATION_REPLIES.reading), { application_id: opened.applicationId })
        return done({ resolution: 'document_received', resume: null, process: { job: { tenant_id: tenantId, application_id: opened.applicationId }, sha256: opened.sha256 } })
      }

      // What follows with the name and RFC we have; with everything, registration ends and the result goes out.
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

      // A registration left half-done by the previous flow (legal name and RFC first) goes back to the start.
      const step = reg.step === 'legal_name' || (reg.step === 'rfc' && !reg.applicationId) ? 'statement' : reg.step
      if (step === 'contact_name' || step === 'amount') {
        const current = step === 'contact_name' ? REGISTRATION_REPLIES.ask_contact_name : REGISTRATION_REPLIES.ask_amount(null)
        if (msg.attachment !== null) {
          // The PDF is kept (the latest one wins) and read once the name and amount are in.
          const kept = await keepStatement(reg, msg.attachment)
          if ('rejected' in kept) {
            await finish('document_rejected', null, { body: `${rejectedText(kept.rejected)}\n\n${current}`, kind: 'document' }, { reason: kept.rejected })
            return done({ resolution: 'document_rejected', resume: null })
          }
          await finish('registration_document_kept', null, say(`${REGISTRATION_REPLIES.statement_kept}\n\n${current}`), { document_id: kept.documentId })
          return done({ resolution: 'registration_document_kept', resume: null })
        }
        if (step === 'contact_name') {
          const read = await readField('legal_name', current, parseContactName, { free: true })
          if (!('value' in read)) return reply('registration_invalid', reask('invalid' in read ? read.invalid : null, current, REGISTRATION_REPLIES.invalid_contact_name))
          await save({ step: 'amount', contactName: read.value })
          return reply('registration_step', REGISTRATION_REPLIES.ask_amount(read.value))
        }
        const read = await readField('amount', current, parseAmount, { allowSkip: true })
        if ('invalid' in read) return reply('registration_invalid', reask(read.invalid, current, REGISTRATION_REPLIES.invalid_amount))
        const amount = 'value' in read ? read.value : null
        const kept = reg.supplierId ? await pendingStatement(tx, reg) : undefined
        if (kept && reg.supplierId) {
          await save({ requestedAmount: amount })
          return startReading(reg.supplierId, kept, amount, kept.inboundId)
        }
        await save({ step: 'statement', requestedAmount: amount, pendingDocumentId: null })
        return reply('registration_step', REGISTRATION_REPLIES.ask_statement_for(amount))
      }
      if (step === 'statement') {
        if (msg.attachment === null) return reply('registration_waiting', REGISTRATION_REPLIES.ask_statement)
        const stored = await storeDocument(supplierFor(reg), msg.attachment)
        if ('rejected' in stored) {
          await finish('document_rejected', null, { body: rejectedText(stored.rejected), kind: 'document' }, { reason: stored.rejected })
          return { resolution: 'document_rejected', resume: null }
        }
        return startReading(await supplierFor(reg)(), stored, reg.requestedAmount)
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
        // Without a correction, a complete RFC from the document is kept; once corrected, it is always asked.
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

    // Pending invoice data: goes before clarifications because the request is not analyzed yet.
    // Only for a number with a verified link.
    const [intake] = links.length
      ? await tx
          .select()
          .from(invoiceIntakes)
          .where(and(eq(invoiceIntakes.channel, msg.channel), eq(invoiceIntakes.address, msg.fromAddress), ne(invoiceIntakes.step, 'done')))
          .orderBy(desc(invoiceIntakes.createdAt))
          .limit(1)
      : []
    // Amount requested after the maximum-line offer. A new PDF closes the offer and proceeds like
    // any document.
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
        // The amount goes into the request and re-evaluation decides with it, without models (redecide.ts).
        const request = ApplicationRequest.parse({ amount: read.value, maturity: null, buyer: null })
        await tx.update(applications).set({ request, status: 'deciding', updatedAt: new Date() }).where(eq(applications.id, intake.applicationId))
        await close()
        await finish('offer_accepted', null, say(AMOUNT_OFFER.reviewing(read.value)), { application_id: intake.applicationId })
        return done({ resolution: 'offer_accepted', resume: null, redecide: { tenant_id: tenantId, application_id: intake.applicationId, correction_batch: randomUUID() } })
      }
    }
    // An invoice conversation left open is ended even if the option is now off.
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
      // A past date is a valid reading that gets rejected: Haiku is not asked for another.
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
      // The full PDF was requested (missing pages): this PDF answers that question, it does not open another request.
      const requesting = await openClarification()
      const request = requesting ? documentRequestOf(requesting) : undefined
      if (requesting && request) {
        const stored = await storeDocument(supplierId, bytes)
        if ('rejected' in stored) {
          // The question stays open: they are told why the file is unusable and can send another.
          await finish('document_rejected', requesting.id, reply(stored.rejected === 'password' ? 'password_protected' : 'rejected'), { reason: stored.rejected })
          return { resolution: 'document_rejected', resume: null }
        }
        const [linked] = await tx
          .select({ documentId: applicationDocuments.documentId })
          .from(applicationDocuments)
          .where(and(eq(applicationDocuments.applicationId, requesting.applicationId), eq(applicationDocuments.documentId, stored.documentId)))
        if (linked) {
          await finish('document_duplicate', requesting.id, { body: documentRequestReplies(request).sameFile, kind: 'document' }, { application_id: requesting.applicationId })
          return { resolution: 'document_duplicate', resume: null }
        }
        await tx.insert(applicationDocuments).values({ tenantId, applicationId: requesting.applicationId, documentId: stored.documentId, origin: 'owner_answer' })
        const answers = [...Answers.parse(requesting.answers), { question_id: request.id, kind: 'documents' as const, paths: [stored.storagePath] }]
        const complete = isComplete(Questions.parse(requesting.questions), answers)
        // With everything answered, it resumes with the PDF as the answer; if analyst questions remain, the analyst is notified.
        await tx.update(clarifications).set(complete ? { answers, step: 'confirmed', status: 'answered', answeredAt: sql`now()` } : { answers, step: 'confirmed' }).where(eq(clarifications.id, requesting.id))
        const texts = documentRequestReplies(request)
        await finish('document_answer', requesting.id, { body: complete ? texts.received : texts.forReview, kind: 'document' }, { application_id: requesting.applicationId })
        return { resolution: 'document_answer', resume: complete ? { tenant_id: tenantId, application_id: requesting.applicationId, clarification_id: requesting.id } : null }
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const [existing] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.sha256, sha256))
      if (existing) {
        // The most recent request for that document: the reply depends on how it ended.
        const [prev] = await tx
          .select({ id: applications.id, status: applications.status, failureReason: applications.failureReason, request: applications.request })
          .from(applicationDocuments)
          .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
          .where(eq(applicationDocuments.documentId, existing.id))
          .orderBy(desc(applications.createdAt))
          .limit(1)
        const failure = prev?.status === 'failed' ? describeFailure(prev.failureReason) : null
        // Our own error can be retried with the same file: a new request is opened below.
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
        // With invoice questions, analysis waits for the data and is enqueued when they finish.
        await tx.insert(invoiceIntakes).values({ applicationId: created.id, tenantId, channel: msg.channel, address: msg.fromAddress, step: 'amount', documentSha256: sha256 })
        await finish('document_received', null, { body: INVOICE_REPLIES.ask_amount, kind: 'invoice' }, { application_id: created.id })
        return { resolution: 'document_received', resume: null }
      }
      // No questions (the demo): analyzed right away and the result is the maximum line.
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
        // In the demo, a registered supplier who greets is told what to do, not the generic reply.
        const [s] = await tx.select({ legalName: suppliers.legalName }).from(suppliers).where(inArray(suppliers.id, links.map((l) => l.supplierId))).limit(1)
        await finish('registered_idle', null, { body: REGISTRATION_REPLIES.idle(s?.legalName ?? 'tu empresa', reg?.contactName ?? null), kind: 'registration' })
        return { resolution: 'registered_idle', resume: null }
      }
      await finish('no_open_clarification', null, { body: GENERIC_NO_PENDING, kind: 'generic' })
      return { resolution: 'no_open_clarification', resume: null }
    }

    // Open clarification: question by question (`asking`), several answers in one message, a summary
    // to confirm (`confirming`), changing an answer (`revising`) and, once confirmed, the resume or,
    // if analyst questions remain, the notice (`confirmed`).
    const questions: QuestionT[] = Questions.parse(open.questions)
    let answers = Answers.parse(open.answers)
    const convo = conversationalIndexes(questions)
    const answer = async (resolution: Resolution, body: string, kind: string, set: PgUpdateSetSource<typeof clarifications> = {}, resume: ResumeJob | null = null) => {
      if (Object.keys(set).length > 0) await tx.update(clarifications).set(set).where(eq(clarifications.id, open.id))
      await finish(resolution, open.id, { body, kind })
      return done({ resolution, resume })
    }
    const withAnswers = (given: readonly OwnerAnswerT[]) => [...answers.filter((a) => !given.some((g) => g.question_id === a.question_id)), ...given]
    /** Reads an answer to question `q`: rules and, if there are options and they fall short, Haiku. */
    const readOne = async (q: QuestionT): Promise<{ answer: OwnerAnswerT | null; offTopic: boolean }> => {
      const direct = parseReply(msg.body, q)
      if (direct || q.options.length === 0) return { answer: direct, offTopic: false }
      // Haiku only maps the reply to an option; parseReply remains what accepts it.
      const read = await readField('option', q.text, (t) => parseReply(t, q), { options: q.options.map((o) => o.label) })
      return { answer: 'value' in read ? read.value : null, offTopic: 'invalid' in read && read.invalid === 'off_topic' }
    }
    const reaskText = (q: QuestionT, offTopic: boolean) => (offTopic ? `${CONVERSATION_FALLBACKS.off_topic}\n\n${renderReask(q)}` : renderReask(q))

    if (open.step === 'confirmed') return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst')

    if (open.step === 'confirming') {
      const summary = () => renderSummary(questions, answers)
      let read = parseConfirmation(msg.body, questions)
      if (!read) {
        // Yes or no via Haiku when the rules fall short; a correction is requested with the number.
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
      // Confirmed: with everything answered it resumes; if analyst questions remain, the analyst is notified.
      if (isComplete(questions, answers)) return answer('completed', CONFIRMATION_REPLIES.sent, 'confirmation', { step: 'confirmed', status: 'answered', answeredAt: sql`now()` }, { tenant_id: tenantId, application_id: open.applicationId, clarification_id: open.id })
      return answer('confirmed', CONFIRMATION_REPLIES.sent_analyst, 'analyst', { step: 'confirmed' })
    }

    const current = questions[open.currentQuestion]
    // A PDF is expected (the full one or one with an address): text does not answer it and changes no state.
    if (current && isDocumentRequest(current)) return answer('awaiting_document', documentRequestReplies(current).sendPdf, 'reask')
    if (!current || !isConversational(current)) return answer('awaiting_analyst', ANALYST_NOTICE, 'analyst', { step: 'confirmed' })

    if (open.step === 'revising') {
      const read = await readOne(current)
      if (!read.answer) return answer('unparsed', reaskText(current, read.offTopic), 'reask')
      answers = withAnswers([read.answer])
      return answer('corrected', `${CONFIRMATION_REPLIES.changed(convo.indexOf(open.currentQuestion) + 1)}\n\n${renderSummary(questions, answers)}`, 'summary', { answers, step: 'confirming' })
    }

    // Several answers in one message: they go to the current question and the next, in order. Rules first.
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
    // All chat questions answered: the summary, before evaluating.
    return answer('summary', renderSummary(questions, answers), 'summary', { answers, step: 'confirming' })
  })
}

/** Unprocessed inbound messages from all tenants (reviewed function, ids only). */
export async function pendingInbound(db: Db, limit = 50): Promise<{ id: string; tenant_id: string }[]> {
  const res = await db.execute<{ id: string; tenant_id: string }>(sql`select id, tenant_id from app.pending_inbound(${limit})`)
  return res.rows
}
