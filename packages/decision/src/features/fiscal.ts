/**
 * Features fiscales de un estado de cuenta (docs/09 §9): régimen impreso en el CFDI, ancla fiscal de las
 * comisiones y si los ingresos caben en el tope del régimen.
 */
import { checkRfc, FISCAL_REGIMES, type Verification } from '@gow/contracts'
import { round2, sumMoney } from '../util/num.ts'
import { known, unknown, worst, type Entry } from './entry.ts'
import type { StatementContext } from './statement-context.ts'

/** Tope de ingresos anuales de RESICO persona física (régimen 626), docs/09 §9.5. */
export const RESICO_ANNUAL_CAP = 3_500_000

/** Tolerancia del ancla fiscal: comisiones del CFDI contra filas de comisión. */
const FISCAL_ANCHOR_TOLERANCE = 1

/** "601 General de Ley Personas Morales" → 601; una clave fuera del catálogo → other. */
export function regimeCode(raw: string): (typeof FISCAL_REGIMES)[number] | null {
  const m = /^\s*(\d{3})\b/.exec(raw)
  if (!m) return null
  const code = m[1] ?? ''
  return (FISCAL_REGIMES as readonly string[]).includes(code) ? (code as (typeof FISCAL_REGIMES)[number]) : 'other'
}

/** El RFC receptor genérico (público en general o extranjero): el CFDI no es del titular (ADR 0056). */
const GENERIC_RECEIVER_NOTE = 'el CFDI va al RFC genérico; el régimen impreso no es del titular'
/** Sin RFC receptor impreso, el régimen no se puede atribuir al titular (el BBVA imprime 616 sin RFC). */
const NO_RECEIVER_NOTE = 'el CFDI no trae RFC receptor; el régimen impreso no se puede atribuir al titular'

export function fiscalRegime(ctx: StatementContext): Entry {
  // El documento más reciente manda; si dos documentos dicen regímenes distintos, es conflicto.
  const found: { code: string; verification: Verification; where: string; end: number }[] = []
  let skippedNote: string | null = null
  for (const doc of ctx.ledger.documents) {
    const end = Math.max(...ctx.ledger.periods.filter((p) => p.doc === doc).map((p) => p.end ?? 0))
    const fiscal = [...doc.statement.fiscal_documents].sort((a, b) => (a.kind === 'income' ? 0 : 1) - (b.kind === 'income' ? 0 : 1))
    for (const f of fiscal) {
      const raw = f.receiver.tax_regime.value
      const code = raw === null ? null : regimeCode(raw)
      if (code === null) continue
      // Un CFDI a XAXX010101000 / XEXX010101000 imprime el régimen que se le pone a "público en general"
      // (616 en el BBVA), no el del titular: no sirve para el perfil.
      const rfc = f.receiver.rfc.value
      if (rfc === null || rfc.trim() === '') {
        skippedNote ??= NO_RECEIVER_NOTE
        continue
      }
      if (checkRfc(rfc).kind === 'generic') {
        skippedNote = GENERIC_RECEIVER_NOTE
        continue
      }
      found.push({ code, verification: f.receiver.tax_regime.verification, where: `${doc.tag}:${f.id}.receiver.tax_regime`, end })
      break
    }
  }
  if (found.length === 0) return unknown(skippedNote ?? 'sin CFDI o el CFDI no imprime el régimen del receptor')
  found.sort((a, b) => b.end - a.end)
  const latest = found[0]
  if (!latest) return unknown('sin régimen')
  const conflict = found.some((f) => f.code !== latest.code)
  return known(latest.code, {
    verification: conflict ? 'conflict' : latest.verification,
    evidence: found.map((f) => `${f.where}=${f.code}`),
    note: conflict ? 'los documentos traen regímenes distintos' : null,
  })
}

/**
 * Ancla fiscal (docs/09 §9.1): el CFDI de comisiones lo firma el SAT, fuera del PDF editable.
 * Las filas de comisión del documento deben sumar su total (si el banco detalla el IVA) o su
 * subtotal (si no). Un documento sin importes en el CFDI no cuenta.
 */
export function fiscalAnchor(ctx: StatementContext): Entry {
  const checks: { ok: boolean; where: string; verification: Verification }[] = []
  for (const doc of ctx.ledger.documents) {
    for (const f of doc.statement.fiscal_documents) {
      if (f.kind !== 'income') continue
      const total = f.total.value ?? (f.subtotal.value !== null && f.tax.value !== null ? round2(f.subtotal.value + f.tax.value) : null)
      const subtotal = f.subtotal.value
      if (total === null && subtotal === null) continue
      const feeRows = ctx.ledger.rows.filter((r) => r.doc === doc && r.type === 'debit' && r.classification.category === 'fee')
      const fees = sumMoney(feeRows.map((r) => r.amount))
      const ok = (total !== null && Math.abs(fees - total) <= FISCAL_ANCHOR_TOLERANCE) || (subtotal !== null && Math.abs(fees - subtotal) <= FISCAL_ANCHOR_TOLERANCE)
      const verification = worst(f.total.verification, f.subtotal.verification, ...feeRows.map((r) => (r.verified ? 'verified' : 'unverified')))
      checks.push({ ok, where: `${doc.tag}:${f.id} comisiones=${String(fees)} cfdi=${String(total ?? subtotal)}`, verification })
    }
  }
  if (checks.length === 0) return unknown('ningún CFDI de comisiones con importes impresos')
  return known(
    checks.every((c) => c.ok),
    { verification: worst(...checks.map((c) => c.verification)), evidence: checks.map((c) => c.where), note: checks.every((c) => c.ok) ? null : 'las comisiones del estado de cuenta no suman lo que firmó el SAT' },
  )
}

export function regimeIncomePlausible(regime: Entry, incomeMonthly: number | null, incomeEntry: Entry | undefined): Entry {
  if (regime.value === null) return unknown(regime.note ?? 'sin régimen fiscal')
  if (regime.value !== '626') return known(true, { verification: regime.verification, note: `el régimen ${typeof regime.value === 'string' ? regime.value : ''} no tiene tope de ingresos` })
  if (incomeMonthly === null || incomeEntry === undefined) return unknown('sin ingresos operativos mensuales')
  const annual = round2(incomeMonthly * 12)
  return known(annual <= RESICO_ANNUAL_CAP, {
    confidence: incomeEntry.confidence,
    verification: worst(regime.verification, incomeEntry.verification),
    note: `RESICO: ingresos operativos anualizados ${String(annual)} contra tope ${String(RESICO_ANNUAL_CAP)}`,
  })
}
