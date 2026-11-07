/**
 * Acceso a datos del worker. Todo pasa por `withTenant` con el rol `gow_worker`: una consulta sin
 * tenant no ve filas aunque haya un bug (docs/05 §2b, "RLS también para procesos internos").
 */
import { notQualifiedReasons, renderVerdict } from '@gow/channels'
import { describeFailure, parsePolicy, type ApplicationRequest, type Decision, type Policy, type StatementAgeSetting, type SupplierIdentity } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, decisions, documents, extractions, outboundMessages, policyVersions, supplierContacts, suppliers, tenants, withTenant, type Db, type Tx } from '@gow/db'
import { evaluate } from '@gow/decision'
import { applicationStatus, type RunInfo, type RunOutcome } from '@gow/mastra'
import { offerAmount } from './offer.ts'
import { startConfirmation } from './registration.ts'
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'

export interface PolicyRef {
  id: string
  version: number
  policy: Policy
}

export interface AppContext {
  tenantId: string
  application: typeof applications.$inferSelect
  supplier: typeof suppliers.$inferSelect
  documents: (typeof documents.$inferSelect)[]
  active: PolicyRef | null
  shadow: PolicyRef | null
  /** Ajuste de antigüedad del tenant (ADR 0049): la antigüedad del documento advierte, no pide otro. */
  statementAge: StatementAgeSetting
}

function toPolicyRef(row: typeof policyVersions.$inferSelect | undefined): PolicyRef | null {
  if (!row) return null
  const parsed = parsePolicy(row.document)
  if (!parsed.ok) throw new Error(`la versión de política ${row.id} no es válida: ${parsed.message}`)
  return { id: row.id, version: row.version, policy: parsed.policy }
}

export async function loadContext(db: Db, tenantId: string, applicationId: string): Promise<AppContext> {
  return withTenant(db, tenantId, async (tx) => {
    const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId))
    if (!application) throw new Error(`no existe la solicitud ${applicationId} en este tenant`)
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, application.supplierId))
    if (!supplier) throw new Error('la solicitud no tiene proveedor')
    const links = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, applicationId))
    const docs = links.length ? await tx.select().from(documents).where(inArray(documents.id, links.map((l) => l.documentId))) : []
    const versions = await tx.select().from(policyVersions).where(inArray(policyVersions.status, ['active', 'shadow'])).orderBy(desc(policyVersions.version))
    const [tenant] = await tx.select({ months: tenants.statementMaxAgeMonths }).from(tenants).where(eq(tenants.id, tenantId))
    if (!tenant) throw new Error(`no existe el tenant ${tenantId}`)
    return {
      tenantId,
      application,
      supplier,
      documents: docs,
      active: toPolicyRef(versions.find((v) => v.status === 'active')),
      shadow: toPolicyRef(versions.find((v) => v.status === 'shadow')),
      statementAge: { max_months: tenant.months },
    }
  })
}

/** Null mientras el proveedor que se registra por WhatsApp no confirma sus datos (ADR 0047). */
export function supplierIdentity(s: AppContext['supplier']): SupplierIdentity | null {
  return s.legalName === null ? null : { legal_name: s.legalName, rfc: s.rfc, clabes: s.clabes }
}

/** Proveedor que se está registrando con su primer estado de cuenta: el resultado espera a sus datos. */
export function identityPending(ctx: AppContext): boolean {
  return ctx.supplier.legalName === null
}

export async function verifiedContacts(db: Db, tenantId: string, supplierId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(supplierContacts).where(and(eq(supplierContacts.supplierId, supplierId), isNotNull(supplierContacts.verifiedAt))))
}

export async function setStatus(db: Db, tenantId: string, applicationId: string, status: typeof applications.$inferSelect.status, failureReason: string | null = null): Promise<void> {
  await withTenant(db, tenantId, (tx) => tx.update(applications).set({ status, failureReason, updatedAt: new Date() }).where(eq(applications.id, applicationId)))
}

export function requestOf(ctx: AppContext): ApplicationRequest | null {
  return (ctx.application.request ?? null) as ApplicationRequest | null
}

/** El veredicto activo y, si hay una política en sombra, el de esa (se evalúa y se registra sin decidir; docs/02 §6). */
export async function insertDecisions(tx: Tx, ctx: AppContext, d: Decision): Promise<void> {
  await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.active?.id ?? null, kind: 'active', status: d.status, limitAmount: d.limit === null ? null : String(d.limit), score: d.score === null ? null : String(d.score), payload: d })
  if (ctx.shadow) {
    const sd = evaluate(ctx.shadow.policy, d.profile, { policyId: ctx.shadow.id, counterfactuals: false, statementAge: ctx.statementAge })
    await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.shadow.id, kind: 'shadow', status: sd.status, limitAmount: sd.limit === null ? null : String(sd.limit), score: sd.score === null ? null : String(sd.score), payload: sd })
  }
}

const VERDICT_STATUSES = ['qualified', 'qualified_with_limit', 'not_qualified', 'human_review', 'failed'] as const
type VerdictStatus = (typeof VERDICT_STATUSES)[number]

/**
 * Avisa el resultado al proveedor por su WhatsApp verificado (ADR 0039): un mensaje con plantilla
 * fija en el buzón de salida, en la misma transacción que guarda el estado. `needs_clarification` no
 * avisa: ahí ya salió la pregunta. Sin WhatsApp verificado no hay aviso (el resultado sigue en la
 * API y el backoffice). El destino sale del vínculo, nunca del llamador.
 */
export async function queueVerdict(tx: Tx, ctx: AppContext, status: typeof applications.$inferSelect.status, limit: number | null, failureReason: string | null = null, decision: Decision | null = null): Promise<boolean> {
  if (!(VERDICT_STATUSES as readonly string[]).includes(status)) return false
  // Registro en curso (ADR 0047): el veredicto sale cuando el proveedor confirma sus datos. Un fallo
  // sí sale, porque no hay nada que confirmar y hace falta otro documento.
  if (identityPending(ctx) && status !== 'failed') return false
  const [contact] = await tx
    .select({ address: supplierContacts.address })
    .from(supplierContacts)
    .where(and(eq(supplierContacts.supplierId, ctx.supplier.id), eq(supplierContacts.channel, 'whatsapp'), isNotNull(supplierContacts.verifiedAt)))
    .orderBy(asc(supplierContacts.createdAt))
    .limit(1)
  if (!contact) return false
  const [tenant] = await tx.select({ name: tenants.name }).from(tenants)
  const request = requestOf(ctx)
  const failure = status === 'failed' ? describeFailure(failureReason) : null
  const verdict = renderVerdict({ status: status as VerdictStatus, limit, request, tenantName: tenant?.name ?? 'la institución crediticia', failure, reasons: status === 'not_qualified' ? notQualifiedReasons(decision) : [] })
  // Sin monto pedido y con línea, el aviso termina preguntando cuánto quiere adelantar (ADR 0053).
  const offer = await offerAmount(tx, { tenantId: ctx.tenantId, applicationId: ctx.application.id, status, limit, request, channel: 'whatsapp', address: contact.address })
  const body = offer ? `${verdict}\n\n${offer}` : verdict
  await tx.insert(outboundMessages).values({ tenantId: ctx.tenantId, kind: 'verdict', channel: 'whatsapp', destination: contact.address, body })
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: 'verdict.queued', subject: ctx.application.id, details: { status, channel: 'whatsapp', ...(failure ? { failure: failure.kind } : {}) } })
  return true
}

/**
 * Guarda lo que dejó una corrida del workflow: extracciones nuevas, el veredicto con la política
 * activa, el de la política en sombra (se evalúa, se registra y no decide; docs/02 §6) y el estado
 * de la solicitud con el run para reanudar.
 */
export async function persistOutcome(db: Db, ctx: AppContext, outcome: RunOutcome): Promise<typeof applications.$inferSelect.status> {
  const run: RunInfo = { workflow: 'process-application', run_id: outcome.runId, status: outcome.status, suspended_step: outcome.suspendedStep }
  const state = outcome.state
  const status = applicationStatus(state, run)
  await withTenant(db, ctx.tenantId, async (tx) => {
    for (const s of state?.statements ?? []) {
      const doc = ctx.documents.find((d) => d.sha256 === s.document.sha256)
      if (!doc) continue
      // La extracción es inmutable: lo que el dueño aclara vive en la aclaración y en el veredicto.
      const [existing] = await tx.select({ id: extractions.id }).from(extractions).where(eq(extractions.documentId, doc.id))
      if (!existing) await tx.insert(extractions).values({ tenantId: ctx.tenantId, documentId: doc.id, schemaVersion: s.schema_version, status: s.extraction.status, payload: s, costUsd: String(s.extraction.cost_usd) })
    }
    if (state?.decision) await insertDecisions(tx, ctx, state.decision)
    const failure = status === 'failed' ? (state?.failure_reason ?? outcome.error ?? 'el workflow terminó sin veredicto') : null
    await tx
      .update(applications)
      .set({ status, failureReason: failure, runId: outcome.runId, suspendedStep: outcome.suspendedStep, updatedAt: new Date() })
      .where(eq(applications.id, ctx.application.id))
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: `application.${outcome.status}`, subject: ctx.application.id, details: { status } })
    // Sin monto solicitado, el monto del aviso es la línea máxima.
    await queueVerdict(tx, ctx, status, state?.decision?.limit ?? state?.max_line?.amount ?? null, failure, state?.decision ?? null)
    if (identityPending(ctx)) await startConfirmation(tx, ctx, state, status)
  })
  return status
}
