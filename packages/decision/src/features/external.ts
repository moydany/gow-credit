/**
 * Features que salen de fuentes externas (docs/03 §3, docs/06 §5, docs/09 §9) y de la
 * solicitud. Una fuente no disponible deja sus features en `null` con la razón; nunca se
 * supone "sin créditos" o "sin listas" por defecto.
 */
import type { ApplicationRequest, ExternalSnapshot } from '@gow/contracts'
import { type Ledger, evidenceRef } from '../ledger.ts'
import { toDay } from '../util/dates.ts'
import { round4, sumMoney } from '../util/num.ts'
import { known, unknown, type Entries, type Entry } from './entry.ts'
import { isIncomeRow } from './statement.ts'

export interface ExternalContext {
  snapshot: ExternalSnapshot
  request: ApplicationRequest | null
  ledger: Ledger
  /** Entradas ya calculadas desde el estado de cuenta (flujo libre, deuda, ingresos). */
  statement: Entries
  minConfidence: number
  asOfDay: number
}

const ext = { provenance: 'external' as const }

function unavailable(source: string): string {
  return `fuente ${source} no disponible`
}

/** UUIDs de los CFDI de los documentos usados (huella del estado de cuenta, docs/09 §9.2). */
export function documentUuids(ledger: Ledger): string[] {
  const out = new Set<string>()
  for (const d of ledger.documents) for (const f of d.statement.fiscal_documents) if (f.uuid.value) out.add(f.uuid.value.toUpperCase())
  return [...out]
}

function existingCredits(ctx: ExternalContext): Entries {
  const src = ctx.snapshot.existing_credits
  const names = ['existing_exposure_balance', 'existing_exposure_days_past_due', 'existing_exposure_payment_ratio', 'existing_exposure_past_due_amount'] as const
  if (!src.available) return Object.fromEntries(names.map((n) => [n, unknown(unavailable('ExistingCredits'), 'external')]))
  const credits = src.credits
  const evidence = credits.map((c) => `existing_credits:${c.product}`)
  const payments = sumMoney(credits.map((c) => c.monthly_payment))
  const fcf = ctx.statement.free_cash_flow_monthly?.value
  let ratio: Entry
  if (payments === 0) ratio = known(0, { ...ext, evidence })
  else if (typeof fcf !== 'number') ratio = unknown('sin flujo libre mensual', 'external')
  else if (fcf <= 0) ratio = unknown('flujo libre no positivo: la razón cuota / flujo libre no está definida', 'external')
  else ratio = known(round4(payments / fcf), { ...ext, confidence: ctx.statement.free_cash_flow_monthly?.confidence ?? 1, evidence, note: `cuota vigente ${String(payments)} / flujo libre ${String(fcf)}` })
  const pastDue = credits.every((c) => c.days_past_due === 0 || c.past_due_amount !== null)
    ? known(sumMoney(credits.map((c) => (c.days_past_due === 0 ? 0 : (c.past_due_amount ?? 0)))), { ...ext, evidence })
    : unknown('el core del prestamista no informa el monto vencido de un crédito con atraso', 'external')
  return {
    existing_exposure_balance: known(sumMoney(credits.map((c) => c.balance)), { ...ext, evidence, note: credits.length === 0 ? 'sin créditos vigentes con este prestamista' : null }),
    existing_exposure_days_past_due: known(credits.reduce((m, c) => Math.max(m, c.days_past_due), 0), { ...ext, evidence }),
    existing_exposure_payment_ratio: ratio,
    existing_exposure_past_due_amount: pastDue,
  }
}

function bureau(ctx: ExternalContext): Entries {
  const src = ctx.snapshot.credit_bureau
  const report = src.available ? src.report : null
  const out: Entries = {
    buro_score: report?.score != null ? known(report.score, ext) : unknown(src.available ? 'buró sin score' : unavailable('CreditBureau'), 'external'),
  }
  // external_debt_signal sale del estado de cuenta; buró solo la confirma (docs/03 §3).
  const signal = ctx.statement.external_debt_signal
  if (signal && signal.value !== null && report?.open_accounts != null) {
    const confirms = report.open_accounts > 0 && (signal.value as number) > 0
    out.external_debt_signal = {
      ...signal,
      confidence: confirms ? 1 : signal.confidence,
      note: `${signal.note ?? ''}; buró reporta ${String(report.open_accounts)} cuentas abiertas${confirms ? ' (confirma)' : ''}`,
    }
  }
  return out
}

function taxAuthority(ctx: ExternalContext): Entries {
  const src = ctx.snapshot.tax_authority
  if (!src.available) {
    const note = unavailable('TaxAuthority')
    return { sat_status: unknown(note, 'external'), sat_list_status: unknown(note, 'external'), cfdi_sat_status: unknown(note, 'external'), income_from_listed_rfc_share: unknown(note, 'external') }
  }
  const tp = src.taxpayer
  const out: Entries = {
    sat_status: tp?.compliance_opinion ? known(tp.compliance_opinion === 'positive' ? 'compliant' : 'non_compliant', ext) : unknown('sin opinión de cumplimiento', 'external'),
    sat_list_status: tp?.list_status ? known(tp.list_status, ext) : unknown('no se consultaron las listas para el RFC del titular (sin RFC completo)', 'external'),
  }

  // El peor estado de los CFDI consultados; un UUID sin datos para consultar no cuenta.
  const order = { cancelled: 2, not_found: 1, valid: 0 } as const
  const uuids = new Set(documentUuids(ctx.ledger))
  const checks = src.cfdi.filter((c) => uuids.has(c.uuid.toUpperCase()))
  out.cfdi_sat_status =
    checks.length === 0
      ? unknown(uuids.size === 0 ? 'el documento no trae CFDI' : 'CFDI sin datos suficientes para consultarlo (RFC de emisor o receptor, total)', 'external')
      : known(checks.reduce<keyof typeof order>((w, c) => (order[c.status] > order[w] ? c.status : w), 'valid'), { ...ext, evidence: checks.map((c) => `cfdi:${c.uuid}=${c.status}`) })

  // Ingresos de pagadores en 69-B definitivo (docs/09 §9.4): solo se ve lo que trae RFC.
  const listed = new Set(src.listed_counterparties.filter((l) => l.list_status === 'efos_definitive').map((l) => l.rfc.toUpperCase()))
  const incomeRows = ctx.ledger.rows.filter((r) => r.verified && isIncomeRow(r, ctx.minConfidence))
  const income = sumMoney(incomeRows.map((r) => r.amount))
  const withRfc = incomeRows.filter((r) => r.classification.counterparty_rfc)
  if (income <= 0) out.income_from_listed_rfc_share = unknown('sin ingresos operativos', 'external')
  else if (withRfc.length === 0) out.income_from_listed_rfc_share = unknown('ningún abono de cliente trae el RFC del pagador', 'external')
  else {
    const flagged = withRfc.filter((r) => listed.has((r.classification.counterparty_rfc ?? '').toUpperCase()))
    const rfcShare = sumMoney(withRfc.map((r) => r.amount)) / income
    out.income_from_listed_rfc_share = known(round4(sumMoney(flagged.map((r) => r.amount)) / income), {
      ...ext,
      confidence: rfcShare,
      evidence: flagged.map(evidenceRef),
      note: `RFC del pagador visible en ${(rfcShare * 100).toFixed(0)} % de los ingresos`,
    })
  }
  return out
}

function program(ctx: ExternalContext): Entry {
  const src = ctx.snapshot.program
  if (!src.available) return unknown(ctx.request?.buyer ? unavailable('del programa del comprador') : 'la solicitud no trae comprador', 'external')
  return src.available_limit === null ? unknown('el comprador no tiene programa con cupo configurado', 'external') : known(src.available_limit, ext)
}

function internal(ctx: ExternalContext): Entries {
  const src = ctx.snapshot.internal
  if (!src.available) {
    const note = unavailable('del historial interno')
    return { prior_applications: unknown(note, 'external'), statement_reuse_count: unknown(note, 'external'), statement_seen_elsewhere_days: unknown(note, 'external') }
  }
  const uuids = new Set(documentUuids(ctx.ledger))
  const out: Entries = { prior_applications: known(src.prior_applications, { ...ext, evidence: src.prior_applications.map((a) => `application:${a.application_id}`) }) }
  if (uuids.size === 0) {
    out.statement_reuse_count = unknown('el documento no trae CFDI: no hay huella por UUID', 'external')
    out.statement_seen_elsewhere_days = unknown('el documento no trae CFDI: no hay huella por UUID', 'external')
    return out
  }
  const reuse = new Set(src.statement_reuse.filter((r) => uuids.has(r.uuid.toUpperCase())).map((r) => r.application_id))
  out.statement_reuse_count = known(reuse.size, { ...ext, evidence: [...reuse].map((id) => `application:${id}`) })
  const seen = src.seen_elsewhere.filter((s) => uuids.has(s.uuid.toUpperCase())).map((s) => ctx.asOfDay - toDay(s.seen_on))
  out.statement_seen_elsewhere_days =
    seen.length === 0 ? unknown('ningún otro prestamista ha visto este UUID', 'external') : known(Math.max(0, Math.min(...seen)), { ...ext, note: 'índice de plataforma por HMAC(UUID)' })
  return out
}

export function externalFeatures(ctx: ExternalContext): Entries {
  return {
    ...existingCredits(ctx),
    ...bureau(ctx),
    ...taxAuthority(ctx),
    program_available_limit: program(ctx),
    ...internal(ctx),
    requested_amount: ctx.request?.amount != null ? known(ctx.request.amount, ext) : unknown('la solicitud no trae monto', 'external'),
  }
}
