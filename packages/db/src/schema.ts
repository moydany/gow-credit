/**
 * Business schema. Everything lives in the `app` schema; each table carries `tenant_id` and has
 * forced RLS with the `tenant_isolation` policy (migration 0001_rls.sql). pg-boss and Mastra live in
 * their own schemas with their own roles.
 *
 * Statuses are the canonical ones. Large JSON blobs (extraction, verdict, policy) are stored as
 * their Zod contracts define them; the plain columns are what gets queried.
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, customType, foreignKey, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

export const app = pgSchema('app')

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const applicationStatus = app.enum('application_status', ['received', 'extracting', 'extracted', 'deciding', 'needs_clarification', 'human_review', 'qualified', 'qualified_with_limit', 'not_qualified', 'failed'])
export const decisionStatus = app.enum('decision_status', ['qualified', 'qualified_with_limit', 'not_qualified', 'needs_clarification', 'human_review'])
export const policyVersionStatus = app.enum('policy_version_status', ['draft', 'shadow', 'active', 'archived'])
export const clarificationStatus = app.enum('clarification_status', ['open', 'answered', 'expired', 'rejected'])
export const channel = app.enum('channel', ['whatsapp', 'email', 'manual'])
export const outcome = app.enum('outcome', ['paid', 'late', 'default', 'fraud'])
export const documentOrigin = app.enum('document_origin', ['submitted', 'owner_answer'])
export const messageStatus = app.enum('message_status', ['pending', 'sent', 'failed'])
export const decisionKind = app.enum('decision_kind', ['active', 'shadow'])
export const whatsappSessionStatus = app.enum('whatsapp_session_status', ['starting', 'waiting_qr', 'open', 'closed', 'logged_out'])

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`)
const tenantId = () => uuid('tenant_id').notNull()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const tenants = app.table('tenants', {
  id: id(),
  name: text('name').notNull(),
  /** Our WhatsApp number for this tenant; the pair (this number, the supplier's) identifies a link. */
  whatsappNumber: text('whatsapp_number').unique(),
  /** This tenant's email sender. */
  emailFrom: text('email_from'),
  /**
   * Maximum statement age in months: an older one is still analysed and the verdict carries a
   * warning. NULL = no limit (the default): document age neither decides nor warns until the tenant
   * sets a limit.
   */
  statementMaxAgeMonths: integer('statement_max_age_months'),
  createdAt: createdAt(),
})

/**
 * Backoffice users: one role, several users per tenant. `user_id` is the JWT `sub` (Supabase Auth
 * in production); tenant membership is the whole authorization. Email is unique, so a user belongs
 * to a single tenant.
 */
export const tenantUsers = app.table(
  'tenant_users',
  {
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    email: text('email').notNull(),
    invitedBy: uuid('invited_by'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), uniqueIndex('tenant_users_email').on(t.email)],
)

export const apiKeys = app.table(
  'api_keys',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    /** Visible part of the key (`gowk_xxxxxxxx`); the full key is shown only at creation. */
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_keys_tenant').on(t.tenantId)],
)

export const suppliers = app.table(
  'suppliers',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    externalRef: text('external_ref'),
    /**
     * Null only while a supplier registering over WhatsApp hasn't confirmed the details read from
     * their statement: without a declared identity there is nothing to compare the holder against.
     */
    legalName: text('legal_name'),
    /** Column encryption is planned; for now stored in clear and protected by RLS. */
    rfc: text('rfc'),
    clabes: text('clabes').array().notNull().default(sql`'{}'::text[]`),
    /** Legal representative of a persona moral, if the supplier gave one. Not part of the decision. */
    representativeName: text('representative_name'),
    /**
     * Holder address from the latest statement that includes one. Personal data: protected by RLS,
     * never in logs or the audit log.
     */
    address: text('address'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppliers_tenant_ref').on(t.tenantId, t.externalRef)],
)

/** Verified tenant-supplier-address link. Without `verified_at` nothing is sent or accepted. */
export const supplierContacts = app.table(
  'supplier_contacts',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    channel: channel('channel').notNull(),
    address: text('address').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationMethod: text('verification_method'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('supplier_contacts_unique').on(t.tenantId, t.supplierId, t.channel, t.address), index('supplier_contacts_lookup').on(t.tenantId, t.channel, t.address)],
)

/**
 * Registration of a supplier writing for the first time (only with `WHATSAPP_SELF_REGISTRATION`):
 * the conversation asks for the statement first; once it's read, the supplier confirms or corrects
 * the holder and RFC, fills in what's missing and, for a persona moral, gives a legal
 * representative. Only then does the result go out. One row per address and tenant.
 */
export const supplierRegistrations = app.table(
  'supplier_registrations',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    channel: channel('channel').notNull(),
    address: text('address').notNull(),
    /** contact_name | amount | statement | reading | confirm | name | rfc | representative | done */
    step: text('step').notNull(),
    /** How the person writing is called, asked on greeting. Not the account holder. */
    contactName: text('contact_name'),
    /** What they want to advance, asked before the statement; null if they skipped it. */
    requestedAmount: numeric('requested_amount', { precision: 14, scale: 2, mode: 'number' }),
    /** A PDF that arrived before the name and amount: it is opened once both are given. */
    pendingDocumentId: uuid('pending_document_id').references(() => documents.id),
    /** What the supplier confirmed or typed. */
    legalName: text('legal_name'),
    rfc: text('rfc'),
    /** What was read from the statement, to ask whether it is correct. */
    holderName: text('holder_name'),
    holderRfc: text('holder_rfc'),
    /** The supplier said the data read isn't theirs: the RFC is asked for even if it came complete. */
    corrected: boolean('corrected').notNull().default(false),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    /** The request for the first statement, whose result waits until registration finishes. */
    applicationId: uuid('application_id').references(() => applications.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('supplier_registrations_address').on(t.tenantId, t.channel, t.address)],
)

export const documents = app.table(
  'documents',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    storagePath: text('storage_path').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mediaType: text('media_type').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('documents_tenant_sha').on(t.tenantId, t.sha256)],
)

export const applications = app.table(
  'applications',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    status: applicationStatus('status').notNull().default('received'),
    failureReason: text('failure_reason'),
    /** ApplicationRequest (amount, maturity, buyer). */
    request: jsonb('request'),
    /** Mastra run and suspended step, to resume from another process. */
    runId: text('run_id'),
    suspendedStep: jsonb('suspended_step'),
    asOf: text('as_of'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('applications_tenant_status').on(t.tenantId, t.status)],
)

export const applicationDocuments = app.table(
  'application_documents',
  {
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').notNull().references(() => applications.id),
    documentId: uuid('document_id').notNull().references(() => documents.id),
    origin: documentOrigin('origin').notNull().default('submitted'),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.documentId] })],
)

/**
 * Invoice details asked over chat before analysing a statement received on WhatsApp. When done,
 * `draft` becomes `applications.request` and the analysis is enqueued.
 */
export const invoiceIntakes = app.table(
  'invoice_intakes',
  {
    applicationId: uuid('application_id').primaryKey().references(() => applications.id),
    tenantId: tenantId().references(() => tenants.id),
    channel: channel('channel').notNull(),
    address: text('address').notNull(),
    /** amount | buyer | maturity | done */
    step: text('step').notNull(),
    /** Answers so far: `{ amount?, buyer?, maturity? }`. */
    draft: jsonb('draft').notNull().default(sql`'{}'::jsonb`),
    /** Idempotency key for the analysis enqueued at the end. */
    documentSha256: text('document_sha256').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invoice_intakes_open').on(t.tenantId, t.channel, t.address, t.step)],
)

export const extractions = app.table(
  'extractions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    documentId: uuid('document_id').notNull().references(() => documents.id),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    /** StatementExtraction completa. */
    payload: jsonb('payload').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [index('extractions_document').on(t.tenantId, t.documentId)],
)

export const policies = app.table('policies', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const policyVersions = app.table(
  'policy_versions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    policyId: uuid('policy_id').notNull().references(() => policies.id),
    version: integer('version').notNull(),
    status: policyVersionStatus('status').notNull().default('draft'),
    /** Policy validated with parsePolicy; immutable once created. */
    document: jsonb('document').notNull(),
    /** SimulationReport against the active version at the time it was created or simulated. */
    simulation: jsonb('simulation'),
    createdAt: createdAt(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('policy_versions_number').on(t.policyId, t.version),
    // One active and one shadow version per tenant.
    uniqueIndex('policy_versions_one_active').on(t.tenantId).where(sql`status = 'active'`),
    uniqueIndex('policy_versions_one_shadow').on(t.tenantId).where(sql`status = 'shadow'`),
  ],
)

export const decisions = app.table(
  'decisions',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').notNull().references(() => applications.id),
    policyVersionId: uuid('policy_version_id').references(() => policyVersions.id),
    kind: decisionKind('kind').notNull().default('active'),
    status: decisionStatus('status').notNull(),
    limitAmount: numeric('limit_amount', { precision: 14, scale: 2 }),
    score: numeric('score', { precision: 6, scale: 2 }),
    /** Full Decision with the profile: what the simulation re-evaluates. */
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('decisions_application').on(t.tenantId, t.applicationId)],
)

export const clarifications = app.table(
  'clarifications',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').notNull().references(() => applications.id),
    supplierId: uuid('supplier_id').notNull().references(() => suppliers.id),
    round: integer('round').notNull(),
    status: clarificationStatus('status').notNull().default('open'),
    channel: channel('channel').notNull(),
    /** Copied from the verified link at creation: the adapter never accepts recipients. */
    destination: text('destination'),
    contactId: uuid('contact_id').references(() => supplierContacts.id),
    /** Question[] already worded and filtered. */
    questions: jsonb('questions').notNull(),
    /** Accumulated OwnerAnswer[]. */
    answers: jsonb('answers').notNull().default(sql`'[]'::jsonb`),
    /** Index of the question awaited on a conversational channel. */
    currentQuestion: integer('current_question').notNull().default(0),
    /**
     * Conversation step: `asking` (waiting on the current question), `revising` (re-asking an answer
     * the supplier wants to change), `confirming` (summary shown, waiting for the yes) or
     * `confirmed` (confirmed; remaining questions go to the analyst).
     */
    step: text('step').notNull().default('asking'),
    createdAt: createdAt(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    index('clarifications_open').on(t.tenantId, t.status),
    // One per round: if the job retries after sending, the question isn't duplicated.
    uniqueIndex('clarifications_round').on(t.applicationId, t.round),
  ],
)

/** Outbox: the only thing the WhatsApp process reads, to limit the blast radius. */
export const outboundMessages = app.table(
  'outbound_messages',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    /** Null for the fixed replies to a number with no link or no open clarification. */
    clarificationId: uuid('clarification_id').references(() => clarifications.id),
    /** question | reask | generic */
    kind: text('kind').notNull().default('question'),
    channel: channel('channel').notNull(),
    destination: text('destination').notNull(),
    body: text('body').notNull(),
    status: messageStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('outbound_pending').on(t.tenantId, t.channel, t.status)],
)

/** Incoming messages as they arrive; the worker resolves them to the verified link. */
export const inboundMessages = app.table(
  'inbound_messages',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    channel: channel('channel').notNull(),
    fromAddress: text('from_address').notNull(),
    /** Message id on the channel, for idempotency on redelivery. */
    externalId: text('external_id'),
    body: text('body').notNull(),
    /**
     * Attached document: the WhatsApp process has no access to document storage, so it leaves the
     * bytes here as received. The worker validates them, moves them to the tenant's storage and
     * clears the column; they are never kept twice.
     */
    attachment: bytea('attachment'),
    attachmentName: text('attachment_name'),
    attachmentMediaType: text('attachment_media_type'),
    /**
     * Photo, voice note, video or sticker: `image` | `audio` | `video` | `sticker`. Type only, to
     * reply that the PDF is needed; the bytes are never downloaded or stored.
     */
    mediaKind: text('media_kind'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** matched | completed | no_link | unparsed | document_* | registration_* | intake_* | summary | revising | corrected | confirmed | awaiting_* | media_unsupported (`Resolution` en apps/worker/src/inbound.ts) */
    resolution: text('resolution'),
    clarificationId: uuid('clarification_id').references(() => clarifications.id),
  },
  (t) => [uniqueIndex('inbound_external').on(t.tenantId, t.channel, t.externalId)],
)

export const outcomes = app.table('outcomes', {
  id: id(),
  tenantId: tenantId().references(() => tenants.id),
  applicationId: uuid('application_id').notNull().references(() => applications.id),
  outcome: outcome('outcome').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

/**
 * Analyst corrections from human review: the pair (value read, correct value) on one extraction
 * value. Immutable: the stored extraction doesn't change, corrections are applied on top when
 * reading and re-evaluating, and they feed the evals dataset.
 */
export const corrections = app.table(
  'corrections',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').notNull().references(() => applications.id),
    documentId: uuid('document_id').notNull().references(() => documents.id),
    /** CorrectionTarget: which extraction value is being corrected. */
    target: jsonb('target').notNull(),
    readValue: jsonb('read_value'),
    value: jsonb('value').notNull(),
    page: integer('page'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('corrections_application').on(t.tenantId, t.applicationId, t.createdAt)],
)

/**
 * Each tenant's WhatsApp session status: published by the WhatsApp process and read by the
 * backoffice to link the number by scanning the QR in settings. One row per tenant. `gow_whatsapp`
 * writes everything; `gow_api` reads and can only request an unlink (`unlink_requested_at`).
 */
export const whatsappSessions = app.table('whatsapp_sessions', {
  tenantId: tenantId()
    .primaryKey()
    .references(() => tenants.id),
  status: whatsappSessionStatus('status').notNull().default('starting'),
  /** Current linking challenge; cleared as soon as the session opens. Never logged. */
  qr: text('qr'),
  qrExpiresAt: timestamp('qr_expires_at', { withTimezone: true }),
  /** Linked number (+52...), taken from the open session's account. */
  linkedNumber: text('linked_number'),
  /** Process heartbeat (database clock); null after a clean shutdown. */
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  /** Set by a backoffice user; the process handles it if newer than `unlink_handled_at`. */
  unlinkRequestedAt: timestamp('unlink_requested_at', { withTimezone: true }),
  unlinkHandledAt: timestamp('unlink_handled_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Every model exchange verbatim: system prompt, instruction, parameters, the PDF fingerprint and
 * what came back (object, raw output if it didn't validate, error, usage and cost). Lets a failed
 * case be analysed without calling the model again. It holds document data, so it stays out of the
 * movements log: the worker inserts, the API reads, and viewing the detail is audited. Deleted
 * along with the supplier (`app.purge_supplier`).
 */
export const llmExchanges = app.table(
  'llm_exchanges',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').references(() => applications.id),
    inboundMessageId: uuid('inbound_message_id').references(() => inboundMessages.id),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    schemaName: text('schema_name').notNull(),
    promptVersion: text('prompt_version').notNull(),
    effort: text('effort').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    serverFallback: boolean('server_fallback').notNull(),
    system: text('system').notNull(),
    instruction: text('instruction').notNull(),
    documentSha256: text('document_sha256'),
    /** ok | error */
    outcome: text('outcome').notNull(),
    response: jsonb('response'),
    rawOutput: text('raw_output'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    finishReason: text('finish_reason'),
    responseCacheHit: boolean('response_cache_hit').notNull().default(false),
    usage: jsonb('usage'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('llm_exchanges_tenant_at').on(t.tenantId, t.createdAt), index('llm_exchanges_application').on(t.tenantId, t.applicationId, t.createdAt)],
)

/**
 * Model prompts. Global, not per tenant: the same for every lender, since the accuracy the evals
 * measure depends on them. One row per catalog prompt (`PROMPT_CATALOG` in @gow/contracts) with the
 * active version. The seed (`syncPromptFiles`, on every `pnpm db:migrate`) fills it from prompts/.
 */
export const prompts = app.table(
  'prompts',
  {
    name: text('name').primaryKey(),
    /** File version used by code running without a database; the seed updates it. */
    codeDefaultFileVersion: integer('code_default_file_version').notNull(),
    activeVersionId: uuid('active_version_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** Email of whoever activated it in the backoffice; null if the seed did. */
    activatedBy: text('activated_by'),
    createdAt: createdAt(),
  },
  (t) => [foreignKey({ name: 'prompts_active_version_fk', columns: [t.name, t.activeVersionId], foreignColumns: [promptVersions.promptName, promptVersions.id] })],
)

/**
 * Immutable prompt versions: editing creates a new one (a trigger rejects UPDATE and DELETE).
 * `source = 'file'` rows are seeded by the migration owner from prompts/; `backoffice` rows are
 * created by `gow_api` on behalf of a user.
 */
export const promptVersions = app.table(
  'prompt_versions',
  {
    id: id(),
    promptName: text('prompt_name')
      .notNull()
      .references((): AnyPgColumn => prompts.name),
    version: integer('version').notNull(),
    /** file | backoffice */
    source: text('source').notNull(),
    fileVersion: integer('file_version'),
    text: text('text').notNull(),
    sha256: text('sha256').notNull(),
    note: text('note').notNull(),
    /** `seed` o `user:<id>`. */
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('prompt_versions_name_version').on(t.promptName, t.version),
    unique('prompt_versions_name_id').on(t.promptName, t.id),
    uniqueIndex('prompt_versions_name_file').on(t.promptName, t.fileVersion),
    check('prompt_versions_source', sql`(${t.source} = 'file' AND ${t.fileVersion} IS NOT NULL) OR (${t.source} = 'backoffice' AND ${t.fileVersion} IS NULL)`),
  ],
)

/** Immutable audit log: the application roles can only insert. */
export const auditLog = app.table(
  'audit_log',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subject: text('subject'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** No PII: ids and codes, not RFC, CLABE or amounts. */
    redacted: boolean('redacted').notNull().default(true),
  },
  (t) => [index('audit_tenant_at').on(t.tenantId, t.at)],
)

/** All business tables: the RLS test walks them and the catalog check requires that none is missing. */
export const TENANT_TABLES = [
  'tenants',
  'api_keys',
  'tenant_users',
  'suppliers',
  'supplier_contacts',
  'supplier_registrations',
  'documents',
  'applications',
  'application_documents',
  'invoice_intakes',
  'extractions',
  'policies',
  'policy_versions',
  'decisions',
  'clarifications',
  'outbound_messages',
  'inbound_messages',
  'outcomes',
  'corrections',
  'whatsapp_sessions',
  'llm_exchanges',
  'audit_log',
] as const

/**
 * Global `app` tables (no `tenant_id`): also forced RLS, but their policies don't split by tenant.
 * The RLS test requires every `app` table to be in one of the two lists.
 */
export const GLOBAL_TABLES = ['prompts', 'prompt_versions'] as const
