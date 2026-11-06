/**
 * Respuestas de la API del backoffice (`/bo/v1`, docs/08 §4). Lo que el navegador lee: filas de
 * lista y el detalle compuesto de una solicitud. Las cargas grandes (extracción, veredicto)
 * conservan sus contratos propios; aquí solo se arma el sobre.
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
import { checkClabe, checkRfc } from './validators.ts'

export const ClarificationChannelName = z.enum(['whatsapp', 'email', 'manual'])
export const OutcomeName = z.enum(['paid', 'late', 'default', 'fraud'])

export const BackofficeMe = z.strictObject({
  user: z.strictObject({ id: z.uuid(), email: z.string() }),
  tenant: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    whatsapp_number: z.string().nullable(),
    whatsapp_linked_number: z.string().nullable().describe('Número vinculado con la sesión abierta y el proceso de WhatsApp vivo (ADR 0033); null si no'),
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

// ---------- Proveedores (docs/08 §2)

/** RFC del proveedor: sin espacios ni guiones, en mayúsculas, con estructura y fecha válidas. El genérico no identifica a nadie. */
export const SupplierRfc = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').toUpperCase())
  .refine((s) => {
    const c = checkRfc(s)
    return c.result === 'valid' && c.kind !== 'generic'
  }, 'RFC inválido: 12 posiciones persona moral o 13 persona física, con fecha válida')
/** CLABE de 18 dígitos con dígito verificador correcto; sin enmascarar. */
export const SupplierClabe = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => checkClabe(s) === 'valid', 'CLABE inválida: 18 dígitos y dígito verificador correcto')
const SupplierClabes = z
  .array(SupplierClabe)
  .max(10)
  .refine((xs) => new Set(xs).size === xs.length, 'CLABE repetida')
const LegalName = z.string().trim().min(1, 'La razón social no puede ir vacía').max(300)

/** Alta desde el backoffice: sin contactos (los vínculos verificados entran por la API de integración). */
export const SupplierCreateBody = z.strictObject({
  legal_name: LegalName,
  rfc: SupplierRfc.nullable().default(null),
  external_ref: z.string().trim().min(1).max(200).nullable().default(null),
  clabes: SupplierClabes.default([]),
})
export type SupplierCreateBody = z.input<typeof SupplierCreateBody>

/** Edición: razón social, RFC y CLABEs; al menos uno. `external_ref` es la llave del integrador y no se edita aquí. */
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
  created_at: z.string(),
  contacts: z.array(SupplierContactItem),
  applications: z.array(SupplierApplicationItem),
})
export type SupplierDetail = z.infer<typeof SupplierDetail>

// ---------- Configuración (docs/08 §2): usuarios, llaves de API y canales

export const TenantUserItem = z.strictObject({ id: z.uuid(), email: z.string(), created_at: z.string(), invited_by: z.string().nullable().describe('Correo de quien lo invitó, si sigue en el tenant'), is_me: z.boolean() })
export type TenantUserItem = z.infer<typeof TenantUserItem>

export const TenantUserCreateBody = z.strictObject({ email: z.email('Correo inválido').transform((s) => s.trim().toLowerCase()) })
export type TenantUserCreateBody = z.input<typeof TenantUserCreateBody>

/**
 * Sin Supabase Auth, el enlace de acceso se devuelve una sola vez, a quien invita. Con Supabase Auth
 * (ADR 0035) no hay enlace que compartir: la persona entra con su correo y se le manda uno.
 */
export const TenantUserCreated = z.strictObject({
  user: TenantUserItem,
  access_link: z.string().nullable().describe('Enlace de desarrollo con el JWT; null con Supabase Auth'),
  expires_at: z.string().nullable(),
  email_sent: z.boolean().describe('true si Supabase Auth mandó el enlace de acceso al correo invitado'),
})
export type TenantUserCreated = z.infer<typeof TenantUserCreated>

// ---------- Sesión: login por correo con Supabase Auth (ADR 0035)

/** Qué formas de entrar ofrece la API; sin Supabase Auth solo el enlace con el JWT. */
export const SessionConfig = z.strictObject({ magic_link: z.boolean() })
export type SessionConfig = z.infer<typeof SessionConfig>

/**
 * Lo que manda `/entrar` para crear la sesión: el JWT y, con Supabase Auth, el refresh token del
 * mismo fragmento. La API guarda el refresh token cifrado en una cookie `HttpOnly` (ADR 0036).
 */
export const SessionCreateBody = z.strictObject({ token: z.string().min(20).max(4000), refresh_token: z.string().min(1).max(4000).optional() })
export type SessionCreateBody = z.infer<typeof SessionCreateBody>

export const MagicLinkBody = z.strictObject({ email: z.string().trim().toLowerCase().max(320).pipe(z.email('Correo inválido')) })
export type MagicLinkBody = z.input<typeof MagicLinkBody>

/** La misma respuesta exista o no el correo: no revela quién tiene cuenta. */
export const MagicLinkAccepted = z.strictObject({ accepted: z.literal(true) })
export type MagicLinkAccepted = z.infer<typeof MagicLinkAccepted>

export const ApiKeyScope = z.enum(['ingest', 'read', 'policies'])
export type ApiKeyScope = z.infer<typeof ApiKeyScope>

export const ApiKeyItem = z.strictObject({ id: z.uuid(), prefix: z.string(), scopes: z.array(ApiKeyScope), created_at: z.string(), revoked_at: z.string().nullable() })
export type ApiKeyItem = z.infer<typeof ApiKeyItem>

export const ApiKeyCreateBody = z.strictObject({ scopes: z.array(ApiKeyScope).min(1, 'Elige al menos un alcance').refine((xs) => new Set(xs).size === xs.length, 'Alcance repetido') })
export type ApiKeyCreateBody = z.input<typeof ApiKeyCreateBody>

/** La llave completa (`gowk_<prefijo>.<secreto>`) solo existe en esta respuesta; la base guarda el hash. */
export const ApiKeyCreated = z.strictObject({ key: ApiKeyItem, secret_key: z.string() })
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>

export const TenantSettings = z.strictObject({
  tenant: z.strictObject({ id: z.uuid(), name: z.string(), created_at: z.string() }),
  whatsapp: z.strictObject({ number: z.string().nullable().describe('Número de WhatsApp del tenant; null si no tiene uno asignado') }),
  email: z.strictObject({ from: z.string().nullable() }),
})
export type TenantSettings = z.infer<typeof TenantSettings>

// ---------- Vinculación de WhatsApp desde Configuración (ADR 0033)

export const WhatsAppSessionStatus = z.enum(['starting', 'waiting_qr', 'open', 'closed', 'logged_out'])
export type WhatsAppSessionStatus = z.infer<typeof WhatsAppSessionStatus>

/**
 * Estado de la sesión de WhatsApp del tenant. El QR solo viene con el proceso vivo, en `waiting_qr`
 * y sin caducar: quien lo escanee vincula su cuenta al bot del tenant, por eso verlo queda en la
 * bitácora.
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
