/**
 * Ports for the profile's external sources. Profile computation is pure and takes an
 * `ExternalSnapshot`; this async layer builds it by asking each port. Real adapters are not
 * implemented yet; the simulated doubles in `simulated.ts` are what scenarios use.
 *
 * A port that fails or is missing leaves its source unavailable: the request goes on and that
 * source's features stay null (the policy decides what to do with unknowns).
 */
import type { ApplicationRequest, BureauReport, CfdiCheck, ExistingCredit, ExternalSnapshot, ListedRfc, PriorApplication, StatementExtraction, SupplierIdentity, TaxpayerStatus } from '@gow/contracts'
import { emptyExternalSnapshot } from '@gow/contracts'
import type { z } from 'zod'

type Prior = z.infer<typeof PriorApplication>

export interface CfdiQuery {
  uuid: string
  issuer_rfc: string
  receiver_rfc: string
  total: number
}

export interface ExistingCreditsPort {
  readonly simulated: boolean
  creditsOf(supplierId: string): Promise<ExistingCredit[]>
}

export interface CreditBureauPort {
  readonly simulated: boolean
  reportOf(supplierId: string, rfc: string | null): Promise<BureauReport | null>
}

export interface TaxAuthorityPort {
  readonly simulated: boolean
  taxpayer(supplierId: string, rfc: string | null): Promise<TaxpayerStatus | null>
  /** SAT "Verifica CFDI". Only called with complete data. */
  cfdiStatus(query: CfdiQuery): Promise<CfdiCheck['status'] | null>
  /** RFCs of counterparties that appear on the 69-B list or are not located. */
  listedAmong(rfcs: readonly string[]): Promise<ListedRfc[]>
}

export interface ProgramPort {
  readonly simulated: boolean
  availableLimit(buyer: NonNullable<ApplicationRequest['buyer']>): Promise<number | null>
}

export interface ApplicationHistoryPort {
  readonly simulated: boolean
  priorApplications(supplierId: string): Promise<Prior[]>
  statementReuse(uuids: readonly string[]): Promise<{ uuid: string; application_id: string }[]>
  seenElsewhere(uuids: readonly string[]): Promise<{ uuid: string; seen_on: string }[]>
}

export interface ExternalPorts {
  existingCredits?: ExistingCreditsPort
  creditBureau?: CreditBureauPort
  taxAuthority?: TaxAuthorityPort
  program?: ProgramPort
  history?: ApplicationHistoryPort
}

export interface ExternalQuery {
  supplierId: string
  supplier: SupplierIdentity | null
  request: ApplicationRequest | null
  statements: readonly StatementExtraction[]
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() }
  } catch {
    // The failure reason goes to the real adapter's logs; here only the missing data matters.
    return { ok: false }
  }
}

const RFC_SHAPE = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/

function fullRfc(raw: string | null | undefined): string | null {
  const s = raw?.replace(/[\s-]/g, '').toUpperCase() ?? null
  return s !== null && RFC_SHAPE.test(s) ? s : null
}

/** Holder's full RFC: the registered one, or the CFDI receiver's (the header is often masked). */
function holderRfc(q: ExternalQuery): string | null {
  const registered = fullRfc(q.supplier?.rfc)
  if (registered) return registered
  for (const s of q.statements) for (const f of s.fiscal_documents) if (fullRfc(f.receiver.rfc.value)) return fullRfc(f.receiver.rfc.value)
  return null
}

function cfdiQueries(statements: readonly StatementExtraction[]): CfdiQuery[] {
  const out: CfdiQuery[] = []
  for (const s of statements) {
    for (const f of s.fiscal_documents) {
      const issuer = fullRfc(f.issuer.rfc.value)
      const receiver = fullRfc(f.receiver.rfc.value)
      // Missing data: no lookup, and the status stays null, never not_found.
      if (f.uuid.value && issuer && receiver && f.total.value !== null) out.push({ uuid: f.uuid.value.toUpperCase(), issuer_rfc: issuer, receiver_rfc: receiver, total: f.total.value })
    }
  }
  return out
}

function counterpartyRfcs(statements: readonly StatementExtraction[]): string[] {
  const out = new Set<string>()
  for (const s of statements) for (const a of s.accounts) for (const p of a.periods) for (const t of p.transactions) if (t.classification?.counterparty_rfc) out.add(t.classification.counterparty_rfc)
  return [...out]
}

function uuidsOf(statements: readonly StatementExtraction[]): string[] {
  return [...new Set(statements.flatMap((s) => s.fiscal_documents.map((f) => f.uuid.value?.toUpperCase() ?? null)).filter((u): u is string => u !== null))]
}

/**
 * Builds the external sources snapshot. `counterpartyRfcs` lets the caller pass the RFCs that
 * classification found (rules read them from the description), besides those in the extraction.
 */
export async function gatherExternal(ports: ExternalPorts, q: ExternalQuery, extraCounterpartyRfcs: readonly string[] = []): Promise<ExternalSnapshot> {
  const snap = emptyExternalSnapshot()
  const rfc = holderRfc(q)
  if (ports.existingCredits) {
    const r = await attempt(() => (ports.existingCredits as ExistingCreditsPort).creditsOf(q.supplierId))
    snap.existing_credits = { available: r.ok, simulated: ports.existingCredits.simulated, credits: r.ok ? r.value : [] }
  }
  if (ports.creditBureau) {
    const r = await attempt(() => (ports.creditBureau as CreditBureauPort).reportOf(q.supplierId, rfc))
    snap.credit_bureau = { available: r.ok, simulated: ports.creditBureau.simulated, report: r.ok ? r.value : null }
  }
  if (ports.taxAuthority) {
    const tax = ports.taxAuthority
    const tp = await attempt(() => tax.taxpayer(q.supplierId, rfc))
    const checks: CfdiCheck[] = []
    let ok = tp.ok
    for (const query of cfdiQueries(q.statements)) {
      const r = await attempt(() => tax.cfdiStatus(query))
      if (!r.ok) ok = false
      else if (r.value !== null) checks.push({ uuid: query.uuid, status: r.value })
    }
    const rfcs = [...new Set([...counterpartyRfcs(q.statements), ...extraCounterpartyRfcs])]
    const listed = rfcs.length > 0 ? await attempt(() => tax.listedAmong(rfcs)) : { ok: true as const, value: [] }
    snap.tax_authority = { available: ok && listed.ok, simulated: tax.simulated, taxpayer: tp.ok ? tp.value : null, cfdi: checks, listed_counterparties: listed.ok ? listed.value : [] }
  }
  if (ports.program) {
    const buyer = q.request?.buyer ?? null
    const program = ports.program
    if (buyer !== null) {
      const r = await attempt(() => program.availableLimit(buyer))
      snap.program = { available: r.ok, simulated: program.simulated, available_limit: r.ok ? r.value : null }
    }
  }
  if (ports.history) {
    const h = ports.history
    const uuids = uuidsOf(q.statements)
    const prior = await attempt(() => h.priorApplications(q.supplierId))
    const reuse = await attempt(() => h.statementReuse(uuids))
    const seen = await attempt(() => h.seenElsewhere(uuids))
    snap.internal = {
      available: prior.ok && reuse.ok && seen.ok,
      simulated: h.simulated,
      prior_applications: prior.ok ? prior.value : [],
      statement_reuse: reuse.ok ? reuse.value : [],
      seen_elsewhere: seen.ok ? seen.value : [],
    }
  }
  return snap
}
