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
  const rfcs = statements
    .flatMap((s) => s.accounts)
    .flatMap((a) => a.periods)
    .flatMap((p) => p.transactions)
    .map((t) => t.classification?.counterparty_rfc)
    .filter((r): r is string => Boolean(r))
  return [...new Set(rfcs)]
}

function uuidsOf(statements: readonly StatementExtraction[]): string[] {
  return [...new Set(statements.flatMap((s) => s.fiscal_documents.map((f) => f.uuid.value?.toUpperCase() ?? null)).filter((u): u is string => u !== null))]
}

async function fetchCreditsSnapshot(port: ExistingCreditsPort, supplierId: string): Promise<ExternalSnapshot['existing_credits']> {
  const r = await attempt(() => port.creditsOf(supplierId))
  return { available: r.ok, simulated: port.simulated, credits: r.ok ? r.value : [] }
}

async function fetchBureauSnapshot(port: CreditBureauPort, supplierId: string, rfc: string | null): Promise<ExternalSnapshot['credit_bureau']> {
  const r = await attempt(() => port.reportOf(supplierId, rfc))
  return { available: r.ok, simulated: port.simulated, report: r.ok ? r.value : null }
}

async function fetchTaxSnapshot(
  tax: TaxAuthorityPort,
  q: ExternalQuery,
  rfc: string | null,
  extraCounterpartyRfcs: readonly string[],
): Promise<ExternalSnapshot['tax_authority']> {
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
  return { available: ok && listed.ok, simulated: tax.simulated, taxpayer: tp.ok ? tp.value : null, cfdi: checks, listed_counterparties: listed.ok ? listed.value : [] }
}

async function fetchProgramSnapshot(program: ProgramPort, buyer: NonNullable<ApplicationRequest['buyer']> | null): Promise<ExternalSnapshot['program']> {
  if (buyer === null) {
    return { available: true, simulated: program.simulated, available_limit: null }
  }
  const r = await attempt(() => program.availableLimit(buyer))
  return { available: r.ok, simulated: program.simulated, available_limit: r.ok ? r.value : null }
}

async function fetchHistorySnapshot(
  h: ApplicationHistoryPort,
  supplierId: string,
  statements: readonly StatementExtraction[],
): Promise<ExternalSnapshot['internal']> {
  const uuids = uuidsOf(statements)
  const prior = await attempt(() => h.priorApplications(supplierId))
  const reuse = await attempt(() => h.statementReuse(uuids))
  const seen = await attempt(() => h.seenElsewhere(uuids))
  return {
    available: prior.ok && reuse.ok && seen.ok,
    simulated: h.simulated,
    prior_applications: prior.ok ? prior.value : [],
    statement_reuse: reuse.ok ? reuse.value : [],
    seen_elsewhere: seen.ok ? seen.value : [],
  }
}

/**
 * Builds the external sources snapshot. `counterpartyRfcs` lets the caller pass the RFCs that
 * classification found (rules read them from the description), besides those in the extraction.
 */
export async function gatherExternal(ports: ExternalPorts, q: ExternalQuery, extraCounterpartyRfcs: readonly string[] = []): Promise<ExternalSnapshot> {
  const snap = emptyExternalSnapshot()
  const rfc = holderRfc(q)
  if (ports.existingCredits) snap.existing_credits = await fetchCreditsSnapshot(ports.existingCredits, q.supplierId)
  if (ports.creditBureau) snap.credit_bureau = await fetchBureauSnapshot(ports.creditBureau, q.supplierId, rfc)
  if (ports.taxAuthority) snap.tax_authority = await fetchTaxSnapshot(ports.taxAuthority, q, rfc, extraCounterpartyRfcs)
  if (ports.program) snap.program = await fetchProgramSnapshot(ports.program, q.request?.buyer ?? null)
  if (ports.history) snap.internal = await fetchHistorySnapshot(ports.history, q.supplierId, q.statements)
  return snap
}
