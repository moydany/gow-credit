/**
 * Backoffice API (`/bo/v1`) responses: list rows and the composed request detail. Large payloads
 * (extraction, verdict) keep their own contracts; this is only the envelope.
 */
import { z } from 'zod'
import { ApplicationStatus, ClarificationStatus, DecisionStatus, PolicyVersionStatus } from './enums.ts'
import { OwnerAnswer, Question } from './clarification.ts'
import { Correction } from './corrections.ts'
import { Decision } from './decision.ts'
import { Money, Sha256 } from './primitives.ts'
import { ApplicationRequest } from './request.ts'
import { SimulationReport } from './simulation.ts'
import { StatementExtraction } from './statement.ts'
import { StatementMaxAgeMonths } from './statement-age.ts'
import { checkClabe, checkRfc } from './validators.ts'

export const ClarificationChannelName = z.enum(['whatsapp', 'email', 'manual'])
export const OutcomeName = z.enum(['paid', 'late', 'default', 'fraud'])

export const BackofficeMe = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.string() }),
  tenant: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    whatsapp_number: z.string().nullable(),
    whatsapp_linked_number: z.string().nullable().describe('Número vinculado con la sesión abierta y el proceso de WhatsApp vivo; null si no'),
  }),
})
export type BackofficeMe = z.infer<typeof BackofficeMe>

export const ApplicationRow = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  failure_reason: z.string().nullable(),
  supplier: z.strictObject({ id: z.uuid(), legal_name: z.string() }),
  request: ApplicationRequest.nullable(),
  decision: z.strictObject({ status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable(), policy_version: z.int().nullable(), reasons: z.array(z.strictObject({ code: z.string(), message: z.string() })) }).nullable(),
  document: z.strictObject({ file_name: z.string().nullable(), bank: z.string().nullable(), page_count: z.int().nullable(), issues: z.int(), flags: z.array(z.string()) }).nullable(),
  open_clarifications: z.int(),
  outcome: OutcomeName.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ApplicationRow = z.infer<typeof ApplicationRow>

export const ClarificationItem = z.strictObject({
  id: z.uuid(),
  application_id: z.uuid(),
  supplier_name: z.string(),
  round: z.int(),
  status: ClarificationStatus,
  channel: ClarificationChannelName,
  questions: z.array(Question),
  answers: z.array(OwnerAnswer),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  answered_by: z.string().nullable().describe('Usuario del backoffice que respondió a nombre del proveedor; null si respondió el proveedor'),
})
export type ClarificationItem = z.infer<typeof ClarificationItem>

export const ApplicationDetail = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  failure_reason: z.string().nullable(),
  request: ApplicationRequest.nullable(),
  as_of: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  supplier: z.strictObject({ id: z.uuid(), legal_name: z.string(), rfc: z.string().nullable(), external_ref: z.string().nullable(), clabes: z.array(z.string()) }),
  documents: z.array(z.strictObject({ id: z.uuid(), sha256: Sha256, size_bytes: z.number(), media_type: z.string() })),
  extraction: StatementExtraction.nullable(),
  decision: z.strictObject({ id: z.uuid(), policy_version: z.int().nullable(), created_at: z.string(), payload: Decision }).nullable(),
  shadow: z.strictObject({ policy_version: z.int().nullable(), status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable() }).nullable(),
  clarifications: z.array(ClarificationItem),
  outcomes: z.array(z.strictObject({ outcome: OutcomeName, observed_at: z.string() })),
  corrections: z.array(Correction),
})
export type ApplicationDetail = z.infer<typeof ApplicationDetail>

export const PolicyVersionItem = z.strictObject({
  id: z.uuid(),
  version: z.int(),
  status: PolicyVersionStatus,
  document: z.unknown(),
  simulation: SimulationReport.nullable(),
  created_at: z.string(),
  activated_at: z.string().nullable(),
})
export type PolicyVersionItem = z.infer<typeof PolicyVersionItem>

export const AuditEntry = z.strictObject({ id: z.uuid(), actor: z.string(), actor_label: z.string().nullable().describe('Correo del usuario cuando el actor es una persona del backoffice'), action: z.string(), subject: z.string().nullable(), details: z.record(z.string(), z.unknown()), at: z.string() })
export type AuditEntry = z.infer<typeof AuditEntry>

// ---------- Suppliers

/** Supplier RFC: no spaces or hyphens, uppercase, valid structure and date. The generic RFC identifies nobody. */
export const SupplierRfc = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').toUpperCase())
  .refine((s) => {
    const c = checkRfc(s)
    return c.result === 'valid' && c.kind !== 'generic'
  }, 'RFC inválido: 12 posiciones persona moral o 13 persona física, con fecha válida')
/** 18-digit CLABE with a valid check digit; not masked. */
export const SupplierClabe = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => checkClabe(s) === 'valid', 'CLABE inválida: 18 dígitos y dígito verificador correcto')
const SupplierClabes = z
  .array(SupplierClabe)
  .max(10)
  .refine((xs) => new Set(xs).size === xs.length, 'CLABE repetida')
const LegalName = z.string().trim().min(1, 'La razón social no puede ir vacía').max(300)

/** Created from the backoffice: no contacts (verified links come in through the integration API). */
export const SupplierCreateBody = z.strictObject({
  legal_name: LegalName,
  rfc: SupplierRfc.nullable().default(null),
  external_ref: z.string().trim().min(1).max(200).nullable().default(null),
  clabes: SupplierClabes.default([]),
})
export type SupplierCreateBody = z.input<typeof SupplierCreateBody>

/** Edit: legal name, RFC and CLABEs, at least one. `external_ref` is the integrator's key; not editable. */
export const SupplierUpdateBody = z
  .strictObject({ legal_name: LegalName.optional(), rfc: SupplierRfc.nullable().optional(), clabes: SupplierClabes.optional() })
  .refine((b) => b.legal_name !== undefined || b.rfc !== undefined || b.clabes !== undefined, 'Nada que cambiar')
export type SupplierUpdateBody = z.input<typeof SupplierUpdateBody>

export const SupplierRow = z.strictObject({
  id: z.uuid(),
  legal_name: z.string(),
  rfc: z.string().nullable(),
  external_ref: z.string().nullable(),
  applications: z.int(),
  last_application: z.strictObject({ id: z.uuid(), status: ApplicationStatus, created_at: z.string() }).nullable(),
  created_at: z.string(),
})
export type SupplierRow = z.infer<typeof SupplierRow>

export const SupplierContactItem = z.strictObject({
  id: z.uuid(),
  channel: ClarificationChannelName,
  address: z.string(),
  verified_at: z.string().nullable().describe('Sin fecha de verificación no se envía ni se acepta nada por ese contacto (docs/05 §2b)'),
  verification_method: z.string().nullable(),
  created_at: z.string(),
})
export type SupplierContactItem = z.infer<typeof SupplierContactItem>

export const SupplierApplicationItem = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  request: ApplicationRequest.nullable(),
  decision: z.strictObject({ status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable() }).nullable(),
  outcomes: z.array(z.strictObject({ outcome: OutcomeName, observed_at: z.string() })),
  created_at: z.string(),
})
export type SupplierApplicationItem = z.infer<typeof SupplierApplicationItem>

export const SupplierDetail = z.strictObject({
  id: z.uuid(),
  legal_name: z.string(),
  rfc: z.string().nullable(),
  external_ref: z.string().nullable(),
  clabes: z.array(z.string()),
  address: z.string().nullable().describe('Domicilio del titular según su estado de cuenta más reciente que lo trae; null si ninguno lo trae'),
  created_at: z.string(),
  contacts: z.array(SupplierContactItem),
  applications: z.array(SupplierApplicationItem),
})
export type SupplierDetail = z.infer<typeof SupplierDetail>

/** What was deleted along with a supplier: requests, documents, credit results, clarifications and messages. Counts only. */
export const SupplierDeleted = z.strictObject({
  id: z.uuid(),
  counts: z.strictObject({
    applications: z.int().nonnegative(),
    documents: z.int().nonnegative(),
    outcomes: z.int().nonnegative(),
    clarifications: z.int().nonnegative(),
    messages: z.int().nonnegative(),
  }),
})
export type SupplierDeleted = z.infer<typeof SupplierDeleted>

/** A statement uploaded from the supplier's page: the request opened with it, already enqueued. */
export const SupplierStatementUploaded = z.strictObject({ id: z.uuid(), status: z.literal('received') })
export type SupplierStatementUploaded = z.infer<typeof SupplierStatementUploaded>

/**
 * Progress of a request opened from the supplier's page, polled while it runs. No RFC, CLABE or
 * movements, so polling it does not write to the audit log like opening the request does.
 */
export const SupplierStatementStatus = z.strictObject({
  id: z.uuid(),
  status: ApplicationStatus,
  requested: Money.nullable().describe('Monto pedido; null si se decidió con la línea máxima'),
  decision: z.strictObject({ status: DecisionStatus, limit: Money.nullable(), score: z.number().nullable(), explanation: z.string().nullable() }).nullable(),
  failure: z.string().nullable().describe('Por qué falló, en palabras para el analista'),
  open_clarification: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type SupplierStatementStatus = z.infer<typeof SupplierStatementStatus>

// ---------- Queue jobs

export const JobState = z.enum(['created', 'retry', 'active', 'completed', 'cancelled', 'failed'])
export type JobState = z.infer<typeof JobState>

/**
 * A pg-boss job of the tenant (its payload carries `tenant_id`), for the "Trabajos" tab of the audit
 * log. Only ids from the payload and the error message, never the payload itself or the stack.
 */
export const JobItem = z.strictObject({
  id: z.uuid(),
  queue: z.string(),
  state: JobState,
  attempts: z.int().nonnegative().describe('Intentos hechos (reintentos + el primero, si ya arrancó)'),
  max_attempts: z.int().positive(),
  application_id: z.uuid().nullable(),
  supplier_id: z.uuid().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error: z.string().nullable().describe('Mensaje del error del último intento, recortado'),
  dead_letter_from: z.string().nullable().describe('Cola de la que vino, si llegó a application.dead'),
})
export type JobItem = z.infer<typeof JobItem>

export const JobListQuery = z.strictObject({
  state: z.enum(['failed', 'running']).optional().describe('failed: falló o se canceló; running: en cola, en curso o por reintentar'),
  application_id: z.uuid().optional(),
})
export type JobListQuery = z.infer<typeof JobListQuery>

// ---------- Settings: users, API keys and channels

export const TenantUserItem = z.strictObject({ id: z.uuid(), email: z.string(), created_at: z.string(), invited_by: z.string().nullable().describe('Correo de quien lo invitó, si sigue en el tenant'), is_me: z.boolean() })
export type TenantUserItem = z.infer<typeof TenantUserItem>

export const TenantUserCreateBody = z.strictObject({ email: z.email('Correo inválido').transform((s) => s.trim().toLowerCase()) })
export type TenantUserCreateBody = z.input<typeof TenantUserCreateBody>

/**
 * Without Supabase Auth the access link is returned once, to the inviter. With it there is no
 * link to share: the person signs in with their email and is sent one.
 */
export const TenantUserCreated = z.strictObject({
  user: TenantUserItem,
  access_link: z.string().nullable().describe('Enlace de desarrollo con el JWT; null con Supabase Auth'),
  expires_at: z.string().nullable(),
  email_sent: z.boolean().describe('true si Supabase Auth mandó el enlace de acceso al correo invitado'),
})
export type TenantUserCreated = z.infer<typeof TenantUserCreated>

// ---------- Session: email login with Supabase Auth

/** Sign-in methods the API offers; without Supabase Auth, only the link carrying the JWT. */
export const SessionConfig = z.strictObject({
  magic_link: z.boolean(),
  setup_required: z.boolean().describe('true mientras no exista ningún tenant: el backoffice ofrece el wizard del primer inicio'),
  setup_password: z.boolean().describe('true si el primer inicio pide la contraseña de la instalación (SETUP_PASSWORD)'),
})
export type SessionConfig = z.infer<typeof SessionConfig>

/** First start: lender name and its admin email. The tenant WhatsApp number is optional; the linked one is the QR's. */
export const SetupBody = z.strictObject({
  tenant_name: z.string().trim().min(2, 'Escribe el nombre de la institución crediticia').max(120),
  email: z.string().trim().toLowerCase().max(320).pipe(z.email('Correo inválido')),
  whatsapp_number: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Usa el formato internacional, por ejemplo +5215512345678')
    .nullable()
    .default(null),
  /** The installation's password (`SETUP_PASSWORD`), when the API asks for one. Never stored or logged. */
  password: z.string().max(200).optional(),
})
export type SetupBody = z.input<typeof SetupBody>

/**
 * What `/entrar` sends to create the session: the JWT and, with Supabase Auth, the refresh token
 * from the same fragment. The API stores the refresh token encrypted in an `HttpOnly` cookie.
 */
export const SessionCreateBody = z.strictObject({ token: z.string().min(20).max(4000), refresh_token: z.string().min(1).max(4000).optional() })
export type SessionCreateBody = z.infer<typeof SessionCreateBody>

export const MagicLinkBody = z.strictObject({ email: z.string().trim().toLowerCase().max(320).pipe(z.email('Correo inválido')) })
export type MagicLinkBody = z.input<typeof MagicLinkBody>

/**
 * The code of the emailed link (`#token_hash=` in `/entrar`), sent when the person presses "Entrar".
 * Opening the link spends nothing: mail scanners and reloads no longer burn it.
 */
export const EmailLinkBody = z.strictObject({ token_hash: z.string().min(10).max(500) })
export type EmailLinkBody = z.infer<typeof EmailLinkBody>

/** Same response whether or not the email exists, so it doesn't reveal who has an account. */
export const MagicLinkAccepted = z.strictObject({ accepted: z.literal(true) })
export type MagicLinkAccepted = z.infer<typeof MagicLinkAccepted>

export const ApiKeyScope = z.enum(['ingest', 'read', 'policies'])
export type ApiKeyScope = z.infer<typeof ApiKeyScope>

export const ApiKeyItem = z.strictObject({ id: z.uuid(), prefix: z.string(), scopes: z.array(ApiKeyScope), created_at: z.string(), revoked_at: z.string().nullable() })
export type ApiKeyItem = z.infer<typeof ApiKeyItem>

export const ApiKeyCreateBody = z.strictObject({ scopes: z.array(ApiKeyScope).min(1, 'Elige al menos un alcance').refine((xs) => new Set(xs).size === xs.length, 'Alcance repetido') })
export type ApiKeyCreateBody = z.input<typeof ApiKeyCreateBody>

/** The full key (`gowk_<prefix>.<secret>`) exists only in this response; the database keeps the hash. */
export const ApiKeyCreated = z.strictObject({ key: ApiKeyItem, secret_key: z.string() })
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>

export const TenantSettings = z.strictObject({
  tenant: z.strictObject({ id: z.uuid(), name: z.string(), created_at: z.string() }),
  whatsapp: z.strictObject({ number: z.string().nullable().describe('Número de WhatsApp del tenant; null si no tiene uno asignado') }),
  email: z.strictObject({ from: z.string().nullable() }),
  analysis: z.strictObject({
    statement_max_age_months: StatementMaxAgeMonths.describe('Antigüedad máxima del estado de cuenta: uno más viejo se analiza igual, con advertencia; null = sin límite'),
  }),
})
export type TenantSettings = z.infer<typeof TenantSettings>

/** What the backoffice may change in the tenant settings. */
export const TenantSettingsUpdateBody = z.strictObject({ statement_max_age_months: StatementMaxAgeMonths })
export type TenantSettingsUpdateBody = z.input<typeof TenantSettingsUpdateBody>

// ---------- WhatsApp linking from Settings

export const WhatsAppSessionStatus = z.enum(['starting', 'waiting_qr', 'open', 'closed', 'logged_out'])
export type WhatsAppSessionStatus = z.infer<typeof WhatsAppSessionStatus>

/**
 * Tenant WhatsApp session state. The QR is only present while the process is alive, in `waiting_qr`
 * and unexpired: whoever scans it links their account to the tenant bot, so viewing it is audit-logged.
 */
export const WhatsAppLinkState = z.strictObject({
  process_running: z.boolean().describe('Latido del proceso de WhatsApp en los últimos 30 s'),
  status: WhatsAppSessionStatus.nullable().describe('Último estado publicado; null si el proceso nunca ha corrido para este tenant'),
  linked_number: z.string().nullable(),
  qr: z.string().nullable(),
  qr_expires_at: z.string().nullable(),
  unlink_pending: z.boolean().describe('Se pidió desvincular y el proceso aún no lo atiende'),
  updated_at: z.string().nullable(),
})
export type WhatsAppLinkState = z.infer<typeof WhatsAppLinkState>

export const WhatsAppUnlinkRequested = z.strictObject({ unlink_requested_at: z.string() })
export type WhatsAppUnlinkRequested = z.infer<typeof WhatsAppUnlinkRequested>
