/**
 * Revisiones que convierten lo reconciliado y lo extraído en avisos (`issues`): cuadre del periodo,
 * fechas fuera de rango y formato de CLABE y RFC.
 */
import type { Period, StatementExtraction, Transaction } from '@gow/contracts'
import type { FieldOf } from './assemble.ts'
import type { IssueSink } from './issues.ts'
import { daysBetween } from './normalize.ts'
import type { PeriodReconciliation } from './reconcile.ts'
import { checkClabe, checkRfc, rfcRoot } from './validators.ts'

export function reportPeriodIssues(p: Period, rec: PeriodReconciliation, issues: IssueSink, missingOnPage: Map<number, number>, retried: Set<number>): void {
  const r = rec.reconciliation
  if (r.global && !r.global.ok) {
    issues.add({ code: 'reconciliation_mismatch', severity: 'error', message: `Saldo inicial + abonos − cargos = ${String(r.global.expected_closing)}, pero el saldo final impreso es ${String(r.global.printed_closing)} (diferencia ${String(r.global.difference)}).`, period_id: p.id, details: { difference: r.global.difference } })
  }
  const components = [
    ['el ISR retenido', p.summary.tax_withheld.value],
    ['las comisiones', p.summary.fees_charged.value],
    ['los intereses', p.summary.interest_earned.value],
  ] as const
  for (const [label, c] of [['abonos', r.totals.credits], ['cargos', r.totals.debits]] as const) {
    if (c.ok !== false) continue
    const diff = Math.abs(c.difference ?? 0)
    const explained = components.find(([, v]) => v !== null && Math.abs(v - diff) <= 0.01)
    const globalOk = r.global?.ok === true
    const message = explained && globalOk
      ? `La suma de ${label} extraídos (${String(c.extracted)}) difiere del total impreso (${String(c.printed)}) en ${String(diff)}, que coincide con ${explained[0]}: el banco no lo incluye en su total. El cuadre global es exacto.`
      : `La suma de ${label} extraídos (${String(c.extracted)}) no coincide con el total impreso (${String(c.printed)})${globalOk ? '; el cuadre global sí es exacto' : ''}.`
    issues.add({ code: 'totals_mismatch', severity: explained && globalOk ? 'info' : globalOk ? 'warning' : 'error', message, period_id: p.id, details: { difference: c.difference } })
  }
  for (const [label, c] of [['abonos', r.totals.credits_count], ['cargos', r.totals.debits_count]] as const) {
    if (c.ok === false) issues.add({ code: 'count_mismatch', severity: 'warning', message: `Se extrajeron ${String(c.extracted)} ${label} y el banco imprime ${String(c.printed)}.`, period_id: p.id })
  }
  for (const b of r.running_balance?.breaks.slice(0, 15) ?? []) {
    issues.add({ code: 'running_balance_break', severity: 'warning', message: `Saldo corrido roto en la página ${String(b.page)}: se esperaba ${String(b.expected_balance)} y está impreso ${String(b.printed_balance)}${retried.has(b.page) ? ' (persiste tras releer la página)' : ''}.`, page: b.page, period_id: p.id, transaction_id: b.transaction_id, details: { difference: b.difference } })
  }
  for (const [page, n] of missingOnPage) {
    issues.add({ code: 'snippet_not_found', severity: 'warning', message: `${String(n)} montos extraídos no aparecen en el texto de la página ${String(page)}.`, page, period_id: p.id, details: { count: n } })
  }
}

export function checkDates(p: Period, txs: readonly Transaction[], issues: IssueSink): void {
  const start = p.period_start.value
  const end = p.period_end.value ?? p.statement_date.value
  if (!start || !end) return
  const outside = txs.filter((t) => daysBetween(start, t.date) < -1 || daysBetween(end, t.date) > 1)
  if (outside.length > 0) {
    issues.add({ code: 'date_out_of_period', severity: 'warning', message: `${String(outside.length)} movimientos tienen fecha fuera del periodo ${start} a ${end}.`, period_id: p.id, page: outside[0]?.source.page ?? null, details: { count: outside.length } })
  }
}

export function checkAccountFormats(acc: StatementExtraction['accounts'][number], issues: IssueSink): void {
  const clabe = acc.clabe
  const res = checkClabe(clabe.value)
  if (res === 'invalid') {
    acc.clabe = { ...clabe, verification: 'unverified', confidence: Math.min(clabe.confidence, 0.3) }
    issues.add({ code: 'invalid_clabe', severity: 'warning', message: 'La CLABE extraída no pasa el dígito verificador.', account_id: acc.id, page: clabe.source?.page ?? null })
  } else if (res === 'valid' && clabe.source !== null) {
    acc.clabe = { ...clabe, verification: 'verified', confidence: Math.max(clabe.confidence, 0.95) }
  }
}

export function checkRfcField(rfc: FieldOf<string>, issues: IssueSink): void {
  const r = checkRfc(rfc.value)
  // Varios bancos imprimen el RFC sin homoclave: es una raíz válida, no un error de lectura (ADR 0044).
  if (r.result === 'invalid' && rfcRoot(rfc.value) !== null) {
    issues.add({ code: 'invalid_rfc', severity: 'info', message: 'El RFC del titular viene sin homoclave (solo letras y fecha).', page: rfc.source?.page ?? null })
    return
  }
  if (r.result === 'invalid') {
    rfc.verification = 'unverified'
    rfc.confidence = Math.min(rfc.confidence, 0.3)
    issues.add({ code: 'invalid_rfc', severity: 'warning', message: 'El RFC del titular no tiene una estructura válida.', page: rfc.source?.page ?? null })
  }
}
