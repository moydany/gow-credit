import { createHash, randomUUID } from 'node:crypto'
import { CONVERSATION_FALLBACKS, isSkip } from '@gow/channels'
import type { ApplicationRequest as ApplicationRequestT } from '@gow/contracts'
import {
  applicationDocuments,
  applications,
  auditLog,
  clarifications,
  documents,
  inboundMessages,
  outboundMessages,
  supplierContacts,
  supplierRegistrations,
  type Tx,
} from '@gow/db'
import { pdfProtection } from '@gow/extraction'
import { isPdf, MAX_DOCUMENT_BYTES } from '@gow/platform'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { ExpectedField } from './interpret.ts'
import type { InboundOptions, InboundResult, Resolution } from './inbound-types.ts'

export type { InboundOptions, InboundResult, Resolution }

export type FieldRead<T> = { value: T } | { skip: true } | { invalid: 'not_understood' | 'off_topic' | null }
export type StoredDoc = { documentId: string; storagePath: string; sha256: string }
export type RejectedDoc = { rejected: 'password' | 'invalid' }

export interface InboundContext {
  readonly tx: Tx
  readonly tenantId: string
  readonly msg: typeof inboundMessages.$inferSelect
  readonly opts: InboundOptions
  readonly today: () => string
  readonly links: readonly { supplierId: string }[]
  readonly reg: typeof supplierRegistrations.$inferSelect | undefined
  finish(
    resolution: Resolution,
    clarificationId: string | null,
    reply: { body: string; kind: string } | null,
    details?: Record<string, string>,
  ): Promise<void>
  done(result: InboundResult): InboundResult
  readField<T>(
    field: ExpectedField,
    question: string,
    parse: (text: string) => T | null,
    options?: { free?: boolean; allowSkip?: boolean; options?: readonly string[] },
  ): Promise<FieldRead<T>>
  reask(why: 'not_understood' | 'off_topic' | null, question: string, specific: string): string
  storeDocument(supplier: string | (() => Promise<string>), bytes: Buffer): Promise<StoredDoc | RejectedDoc>
  openWithDocument(
    supplierId: string,
    doc: { documentId: string; sha256: string },
    request?: ApplicationRequestT | null,
    inboundId?: string,
  ): Promise<{ applicationId: string; sha256: string }>
  openClarification(): Promise<typeof clarifications.$inferSelect | undefined>
}

type InboundMessageRow = typeof inboundMessages.$inferSelect

async function interpretWithLlm<T>(
  interpreter: NonNullable<InboundOptions['interpreter']>,
  field: ExpectedField,
  question: string,
  body: string,
  today: string,
  parse: (text: string) => T | null,
  options?: readonly string[],
): Promise<FieldRead<T> | null> {
  const r = await interpreter.interpret({
    field,
    question,
    message: body,
    today,
    ...(options ? { options } : {}),
  })
  if (!r) return null
  if (r.intent === 'answer' && r.value !== null) {
    const v = parse(r.value)
    return v === null ? { invalid: null } : { value: v }
  }
  if (r.intent === 'skip') return { skip: true }
  return { invalid: r.intent === 'question' ? 'off_topic' : 'not_understood' }
}

async function executeInterpreterRead<T>(
  interpreter: NonNullable<InboundOptions['interpreter']>,
  msgBody: string,
  today: string,
  field: ExpectedField,
  question: string,
  parse: (text: string) => T | null,
  allowSkip?: boolean,
  options?: readonly string[],
): Promise<{ read: FieldRead<T>; interpreted: boolean } | null> {
  const res = await interpretWithLlm(interpreter, field, question, msgBody, today, parse, options)
  if (!res) return null
  if ('skip' in res && !allowSkip) return { read: { invalid: 'not_understood' }, interpreted: true }
  return { read: res, interpreted: true }
}

async function executeFieldRead<T>(
  msgBody: string,
  interpreter: InboundOptions['interpreter'],
  today: string,
  field: ExpectedField,
  question: string,
  parse: (text: string) => T | null,
  o: { free?: boolean; allowSkip?: boolean; options?: readonly string[] } = {},
): Promise<{ read: FieldRead<T>; interpreted: boolean }> {
  if (o.allowSkip && isSkip(msgBody)) return { read: { skip: true }, interpreted: false }
  if (!o.free) {
    const direct = parse(msgBody)
    if (direct !== null) return { read: { value: direct }, interpreted: false }
  }
  if (interpreter && msgBody.trim()) {
    const res = await executeInterpreterRead(
      interpreter,
      msgBody,
      today,
      field,
      question,
      parse,
      o.allowSkip,
      o.options,
    )
    if (res) return res
  }
  if (o.free) {
    const direct = parse(msgBody)
    if (direct !== null) return { read: { value: direct }, interpreted: false }
  }
  return { read: { invalid: null }, interpreted: false }
}

async function executeStoreDocument(
  tx: Tx,
  tenantId: string,
  storage: InboundOptions['storage'],
  supplier: string | (() => Promise<string>),
  bytes: Buffer,
): Promise<StoredDoc | RejectedDoc> {
  if (!storage || bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES || !isPdf(bytes)) {
    return { rejected: 'invalid' }
  }
  if ((await pdfProtection(bytes)) === 'password') return { rejected: 'password' }
  const supplierId = typeof supplier === 'string' ? supplier : await supplier()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const [existing] = await tx
    .select({ id: documents.id, storagePath: documents.storagePath })
    .from(documents)
    .where(eq(documents.sha256, sha256))
  if (existing) return { documentId: existing.id, storagePath: existing.storagePath, sha256 }
  const storagePath = `${tenantId}/${randomUUID()}.pdf`
  await storage.put(storagePath, bytes)
  const [doc] = await tx
    .insert(documents)
    .values({
      tenantId,
      supplierId,
      storagePath,
      sha256,
      sizeBytes: bytes.length,
      mediaType: 'application/pdf',
    })
    .returning({ id: documents.id })
  if (!doc) throw new Error('no se guardó el documento recibido')
  return { documentId: doc.id, storagePath, sha256 }
}

async function executeOpenWithDocument(
  tx: Tx,
  tenantId: string,
  msg: typeof inboundMessages.$inferSelect,
  supplierId: string,
  doc: { documentId: string; sha256: string },
  request: ApplicationRequestT | null = null,
  inboundId = msg.id,
): Promise<{ applicationId: string; sha256: string }> {
  const [created] = await tx
    .insert(applications)
    .values({ tenantId, supplierId, request, asOf: null })
    .returning({ id: applications.id })
  if (!created) throw new Error('no se creó la solicitud del documento recibido')
  await tx.insert(applicationDocuments).values({
    tenantId,
    applicationId: created.id,
    documentId: doc.documentId,
  })
  await tx.insert(auditLog).values({
    tenantId,
    actor: `inbound:${msg.channel}`,
    action: 'application.received',
    subject: created.id,
    details: { inbound_message_id: inboundId },
  })
  return { applicationId: created.id, sha256: doc.sha256 }
}

async function executeFinishMessage(
  tx: Tx,
  tenantId: string,
  msg: typeof inboundMessages.$inferSelect,
  interpreted: boolean,
  resolution: Resolution,
  clarificationId: string | null,
  reply: { body: string; kind: string } | null,
  details: Record<string, string> = {},
): Promise<void> {
  await tx
    .update(inboundMessages)
    .set({ processedAt: new Date(), resolution, clarificationId, attachment: null })
    .where(eq(inboundMessages.id, msg.id))
  if (reply && msg.channel !== 'manual') {
    await tx.insert(outboundMessages).values({
      tenantId,
      clarificationId,
      kind: reply.kind,
      channel: msg.channel,
      destination: msg.fromAddress,
      body: reply.body,
    })
  }
  await tx.insert(auditLog).values({
    tenantId,
    actor: `inbound:${msg.channel}`,
    action: `inbound.${resolution}`,
    subject: msg.id,
    details: {
      clarification_id: clarificationId,
      ...details,
      ...(interpreted ? { interpreted: 'haiku' } : {}),
    },
  })
}

async function findVerifiedLinks(
  tx: Tx,
  channel: InboundMessageRow['channel'],
  address: string,
): Promise<{ supplierId: string }[]> {
  return tx
    .select({ supplierId: supplierContacts.supplierId })
    .from(supplierContacts)
    .where(
      and(
        eq(supplierContacts.channel, channel),
        eq(supplierContacts.address, address),
        isNotNull(supplierContacts.verifiedAt),
      ),
    )
}

async function findOpenClarification(
  tx: Tx,
  channel: InboundMessageRow['channel'],
  address: string,
  links: readonly { supplierId: string }[],
): Promise<typeof clarifications.$inferSelect | undefined> {
  if (links.length === 0) return undefined
  const [row] = await tx
    .select()
    .from(clarifications)
    .where(
      and(
        eq(clarifications.status, 'open'),
        eq(clarifications.channel, channel),
        eq(clarifications.destination, address),
        inArray(
          clarifications.supplierId,
          links.map((l) => l.supplierId),
        ),
      ),
    )
    .orderBy(asc(clarifications.createdAt))
    .limit(1)
  return row
}

export async function createInboundContext(
  tx: Tx,
  tenantId: string,
  msg: typeof inboundMessages.$inferSelect,
  opts: InboundOptions,
): Promise<InboundContext> {
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10))
  let interpreted = false

  const finish = (
    resolution: Resolution,
    clarificationId: string | null,
    reply: { body: string; kind: string } | null,
    details: Record<string, string> = {},
  ): Promise<void> =>
    executeFinishMessage(tx, tenantId, msg, interpreted, resolution, clarificationId, reply, details)

  const done = (r: InboundResult): InboundResult => (interpreted ? { ...r, interpreted } : r)

  const readField = async <T>(
    field: ExpectedField,
    question: string,
    parse: (text: string) => T | null,
    o: { free?: boolean; allowSkip?: boolean; options?: readonly string[] } = {},
  ): Promise<FieldRead<T>> => {
    const outcome = await executeFieldRead(msg.body, opts.interpreter, today(), field, question, parse, o)
    if (outcome.interpreted) interpreted = true
    return outcome.read
  }

  const reask = (why: 'not_understood' | 'off_topic' | null, question: string, specific: string): string =>
    why ? `${CONVERSATION_FALLBACKS[why]}\n\n${question}` : specific

  const links = await findVerifiedLinks(tx, msg.channel, msg.fromAddress)

  const [reg] =
    opts.selfRegistration && msg.channel === 'whatsapp'
      ? await tx
          .select()
          .from(supplierRegistrations)
          .where(
            and(
              eq(supplierRegistrations.channel, msg.channel),
              eq(supplierRegistrations.address, msg.fromAddress),
            ),
          )
      : []

  return {
    tx,
    tenantId,
    msg,
    opts,
    today,
    links,
    reg,
    finish,
    done,
    readField,
    reask,
    storeDocument: (supplier, bytes) => executeStoreDocument(tx, tenantId, opts.storage, supplier, bytes),
    openWithDocument: (supplierId, doc, request, inboundId) =>
      executeOpenWithDocument(tx, tenantId, msg, supplierId, doc, request, inboundId),
    openClarification: () => findOpenClarification(tx, msg.channel, msg.fromAddress, links),
  }
}
