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
  tenant: z.strictObject({ id: z.uuid(), name: z.string(), whatsapp_number: z.string().nullable() }),
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

/** El enlace de acceso se devuelve una sola vez, a quien invita (en producción lo manda Supabase Auth por correo). */
export const TenantUserCreated = z.strictObject({ user: TenantUserItem, access_link: z.string(), expires_at: z.string() })
export type TenantUserCreated = z.infer<typeof TenantUserCreated>

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
