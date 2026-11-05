/**
 * Acceso a datos del worker. Todo pasa por `withTenant` con el rol `gow_worker`: una consulta sin
 * tenant no ve filas aunque haya un bug (docs/05 §2b, "RLS también para procesos internos").
 */
import { parsePolicy, type ApplicationRequest, type Policy, type SupplierIdentity } from '@gow/contracts'
import { applicationDocuments, applications, auditLog, decisions, documents, extractions, policyVersions, supplierContacts, suppliers, withTenant, type Db } from '@gow/db'
import { evaluate } from '@gow/decision'
import { applicationStatus, type RunInfo, type RunOutcome } from '@gow/mastra'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'

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
    return {
      tenantId,
      application,
      supplier,
      documents: docs,
      active: toPolicyRef(versions.find((v) => v.status === 'active')),
      shadow: toPolicyRef(versions.find((v) => v.status === 'shadow')),
    }
  })
}

export function supplierIdentity(s: AppContext['supplier']): SupplierIdentity {
  return { legal_name: s.legalName, rfc: s.rfc, clabes: s.clabes }
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
    const d = state?.decision ?? null
    if (d) {
      await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.active?.id ?? null, kind: 'active', status: d.status, limitAmount: d.limit === null ? null : String(d.limit), score: d.score === null ? null : String(d.score), payload: d })
      if (ctx.shadow) {
        const sd = evaluate(ctx.shadow.policy, d.profile, { policyId: ctx.shadow.id, counterfactuals: false })
        await tx.insert(decisions).values({ tenantId: ctx.tenantId, applicationId: ctx.application.id, policyVersionId: ctx.shadow.id, kind: 'shadow', status: sd.status, limitAmount: sd.limit === null ? null : String(sd.limit), score: sd.score === null ? null : String(sd.score), payload: sd })
      }
    }
    const failure = status === 'failed' ? (state?.failure_reason ?? outcome.error ?? 'el workflow terminó sin veredicto') : null
    await tx
      .update(applications)
      .set({ status, failureReason: failure, runId: outcome.runId, suspendedStep: outcome.suspendedStep, updatedAt: new Date() })
      .where(eq(applications.id, ctx.application.id))
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'worker', action: `application.${outcome.status}`, subject: ctx.application.id, details: { status } })
  })
  return status
}
