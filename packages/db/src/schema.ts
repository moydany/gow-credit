/**
 * Esquema de negocio (docs/02 §1, docs/05 §2 y §2b). Todo vive en el esquema `app`, cada tabla
 * lleva `tenant_id` y tiene RLS forzada con la política `tenant_isolation` (migración
 * 0001_rls.sql). pg-boss y Mastra viven en sus propios esquemas con sus propios roles.
 *
 * Los estados son los canónicos de docs/README.md. Los JSON grandes (extracción, veredicto,
 * política) se guardan tal cual sus contratos Zod; las columnas sueltas son lo que se consulta.
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, customType, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
  /** Nuestro número de WhatsApp para este tenant: el par (este número, el del proveedor) lo identifica (docs/05 §2b). */
  whatsappNumber: text('whatsapp_number').unique(),
  /** Remitente de correo de este tenant. */
  emailFrom: text('email_from'),
  /**
   * Antigüedad máxima del estado de cuenta en meses (ADR 0049): uno más viejo se analiza igual y el
   * veredicto lleva una advertencia. NULL = sin límite. Por defecto 3 (los 90 días de la plantilla).
   */
  statementMaxAgeMonths: integer('statement_max_age_months').default(3),
  createdAt: createdAt(),
})

/**
 * Usuarios del backoffice (docs/08 §1): un rol, varios usuarios por tenant. `user_id` es el `sub`
 * del JWT (Supabase Auth en producción); la pertenencia al tenant es la autorización completa.
 * El correo es único: un usuario pertenece a un solo tenant.
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
    /** Parte visible de la llave (`gowk_xxxxxxxx`); la llave completa solo se muestra al crearla. */
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
     * Null solo mientras un proveedor que se registra por WhatsApp no confirma los datos de su estado
     * de cuenta (ADR 0047): sin identidad declarada no hay contra qué comparar al titular.
     */
    legalName: text('legal_name'),
    /** Cifrado de columna planeado (docs/05 §3); hoy en claro y protegido por RLS. */
    rfc: text('rfc'),
    clabes: text('clabes').array().notNull().default(sql`'{}'::text[]`),
    /** Representante legal de una persona moral, si el proveedor lo dio (ADR 0047). No entra a la decisión. */
    representativeName: text('representative_name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppliers_tenant_ref').on(t.tenantId, t.externalRef)],
)

/** Vínculo verificado tenant–proveedor–dirección (docs/05 §2b). Sin `verified_at` no se envía ni se acepta nada. */
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
 * Registro de un proveedor que escribe por primera vez (ADR 0038 y 0047, solo con
 * `WHATSAPP_SELF_REGISTRATION`): la conversación pide primero el estado de cuenta; al leerlo, el
 * proveedor confirma o corrige el titular y el RFC, completa lo que falte y, si es persona moral, da
 * su representante legal. Solo entonces sale el resultado. Una fila por dirección y tenant.
 */
export const supplierRegistrations = app.table(
  'supplier_registrations',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    channel: channel('channel').notNull(),
    address: text('address').notNull(),
    /** statement | reading | confirm | name | rfc | representative | done */
    step: text('step').notNull(),
    /** Lo que el proveedor confirmó o escribió. */
    legalName: text('legal_name'),
    rfc: text('rfc'),
    /** Lo que se leyó del estado de cuenta, para preguntar si es correcto. */
    holderName: text('holder_name'),
    holderRfc: text('holder_rfc'),
    /** El proveedor dijo que los datos leídos no son los suyos: el RFC se pide aunque venga completo. */
    corrected: boolean('corrected').notNull().default(false),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    /** La solicitud del primer estado de cuenta, cuyo resultado espera a que termine el registro. */
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
    /** ApplicationRequest (monto, vencimiento, comprador). */
    request: jsonb('request'),
    /** Run de Mastra y paso suspendido, para reanudar desde otro proceso (spike 4). */
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
 * Datos de la factura que se piden por el chat antes de analizar un estado de cuenta recibido por
 * WhatsApp (ADR 0039). Al terminar, `draft` pasa a `applications.request` y se encola el análisis.
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
    /** Lo contestado hasta ahora: `{ amount?, buyer?, maturity? }`. */
    draft: jsonb('draft').notNull().default(sql`'{}'::jsonb`),
    /** Clave de idempotencia del análisis que se encola al terminar. */
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
    /** Policy validada con parsePolicy; inmutable una vez creada. */
    document: jsonb('document').notNull(),
    /** SimulationReport contra la versión activa al momento de crearla o simularla. */
    simulation: jsonb('simulation'),
    createdAt: createdAt(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('policy_versions_number').on(t.policyId, t.version),
    // Una sola versión activa y una sola en sombra por tenant.
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
    /** Decision completa con el perfil: es lo que reevalúa la simulación. */
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
    /** Copiado del vínculo verificado al crearla: el adaptador no acepta destinatarios (docs/05 §2b). */
    destination: text('destination'),
    contactId: uuid('contact_id').references(() => supplierContacts.id),
    /** Question[] ya redactadas y filtradas. */
    questions: jsonb('questions').notNull(),
    /** OwnerAnswer[] acumuladas. */
    answers: jsonb('answers').notNull().default(sql`'[]'::jsonb`),
    /** Índice de la pregunta que se está esperando por un canal conversacional. */
    currentQuestion: integer('current_question').notNull().default(0),
    /**
     * Paso de la conversación (ADR 0051): `asking` (se espera la pregunta actual), `revising` (se
     * repregunta una respuesta que el proveedor quiere cambiar), `confirming` (se mostró el resumen y
     * se espera el sí) o `confirmed` (confirmó; quedan preguntas para el analista).
     */
    step: text('step').notNull().default('asking'),
    createdAt: createdAt(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    index('clarifications_open').on(t.tenantId, t.status),
    // Una por ronda: si el job se reintenta tras enviar, no se duplica la pregunta.
    uniqueIndex('clarifications_round').on(t.applicationId, t.round),
  ],
)

/** Buzón de salida: lo único que lee el proceso de WhatsApp (docs/05 §2b, radio de daño). */
export const outboundMessages = app.table(
  'outbound_messages',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    /** Null en las respuestas fijas a un número sin vínculo o sin aclaración abierta (docs/05 §2b). */
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

/** Mensajes entrantes tal como llegan; la resolución al vínculo verificado la hace el worker. */
export const inboundMessages = app.table(
  'inbound_messages',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    channel: channel('channel').notNull(),
    fromAddress: text('from_address').notNull(),
    /** Id del mensaje en el canal: idempotencia ante reentregas (docs/05 §5). */
    externalId: text('external_id'),
    body: text('body').notNull(),
    /**
     * Documento adjunto (ADR 0037): el proceso de WhatsApp no tiene acceso al almacenamiento de
     * documentos, así que deja aquí los bytes tal como llegaron. El worker los valida, los mueve al
     * almacenamiento del tenant y vacía la columna; nunca se guardan dos veces.
     */
    attachment: bytea('attachment'),
    attachmentName: text('attachment_name'),
    attachmentMediaType: text('attachment_media_type'),
    /**
     * Foto, nota de voz, video o sticker (ADR 0051): `image` | `audio` | `video` | `sticker`. Solo el
     * tipo, para contestar que se necesita el PDF; los bytes nunca se descargan ni se guardan.
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
 * Correcciones del analista en revisión humana (docs/08 §2, ADR 0020): el par (valor leído, valor
 * correcto) sobre un valor de la extracción. Inmutables: la extracción guardada no cambia, las
 * correcciones se aplican encima al leer y al reevaluar, y alimentan el dataset de evals.
 */
export const corrections = app.table(
  'corrections',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    applicationId: uuid('application_id').notNull().references(() => applications.id),
    documentId: uuid('document_id').notNull().references(() => documents.id),
    /** CorrectionTarget: qué valor de la extracción se corrige. */
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
 * Estado de la sesión de WhatsApp de cada tenant (ADR 0033): lo publica el proceso de WhatsApp y lo
 * lee el backoffice para vincular el número escaneando el QR desde Configuración. Una fila por tenant.
 * `gow_whatsapp` escribe todo; `gow_api` lee y solo puede pedir desvincular (`unlink_requested_at`).
 */
export const whatsappSessions = app.table('whatsapp_sessions', {
  tenantId: tenantId()
    .primaryKey()
    .references(() => tenants.id),
  status: whatsappSessionStatus('status').notNull().default('starting'),
  /** Reto de vinculación vigente; se borra en cuanto la sesión abre. Nunca va a registros. */
  qr: text('qr'),
  qrExpiresAt: timestamp('qr_expires_at', { withTimezone: true }),
  /** Número vinculado (+52...), derivado de la cuenta de la sesión abierta. */
  linkedNumber: text('linked_number'),
  /** Latido del proceso (reloj de la base); null tras un apagado limpio. */
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  /** Lo pide un usuario del backoffice; el proceso lo atiende si es más nuevo que `unlink_handled_at`. */
  unlinkRequestedAt: timestamp('unlink_requested_at', { withTimezone: true }),
  unlinkHandledAt: timestamp('unlink_handled_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Bitácora inmutable: los roles de aplicación solo pueden insertar (docs/05 §7). */
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
    /** Sin PII: ids y códigos, no RFC, CLABE ni montos. */
    redacted: boolean('redacted').notNull().default(true),
  },
  (t) => [index('audit_tenant_at').on(t.tenantId, t.at)],
)

/** Todas las tablas de negocio: la prueba de RLS las recorre y el chequeo de catálogo exige que no falte ninguna. */
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
  'audit_log',
] as const
