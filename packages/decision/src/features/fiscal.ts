/**
 * Fiscal features of a statement: regime printed on the CFDI, fiscal anchor of the fees, and
 * whether income fits under the regime's cap.
 */
import { checkRfc, FISCAL_REGIMES, type Verification } from '@gow/contracts'
import { round2, sumMoney } from '../util/num.ts'
import { known, unknown, worst, type Entry } from './entry.ts'
import type { StatementContext } from './statement-context.ts'

/** Annual income cap for RESICO persona física (regime 626). */
export const RESICO_ANNUAL_CAP = 3_500_000

/** Fiscal anchor tolerance: CFDI fees against fee rows. */
const FISCAL_ANCHOR_TOLERANCE = 1

/** "601 General de Ley Personas Morales" -> 601; a key outside the catalog -> other. */
export function regimeCode(raw: string): (typeof FISCAL_REGIMES)[number] | null {
  const m = /^\s*(\d{3})\b/.exec(raw)
  if (!m) return null
  const code = m[1] ?? ''
  return (FISCAL_REGIMES as readonly string[]).includes(code) ? (code as (typeof FISCAL_REGIMES)[number]) : 'other'
}

/** The generic receiver RFC (público en general or foreign): the CFDI is not the holder's. */
const GENERIC_RECEIVER_NOTE = 'el CFDI va al RFC genérico; el régimen impreso no es del titular'
/** With no printed receiver RFC the regime cannot be attributed to the holder (BBVA prints 616 with no RFC). */
const NO_RECEIVER_NOTE = 'el CFDI no trae RFC receptor; el régimen impreso no se puede atribuir al titular'

interface FoundRegime {
  code: string
  verification: Verification
  where: string
  end: number
}

function findFiscalRegimeInDoc(
  doc: StatementContext['ledger']['documents'][number],
  periods: StatementContext['ledger']['periods'],
): { found: FoundRegime | null; note: string | null } {
  const end = Math.max(...periods.filter((p) => p.doc === doc).map((p) => p.end ?? 0))
  const fiscal = [...doc.statement.fiscal_documents].sort((a, b) => (a.kind === 'income' ? 0 : 1) - (b.kind === 'income' ? 0 : 1))
  let skippedNote: string | null = null
  for (const f of fiscal) {
    const raw = f.receiver.tax_regime.value
    const code = raw === null ? null : regimeCode(raw)
    if (code === null) continue
    const rfc = f.receiver.rfc.value
    if (rfc === null || rfc.trim() === '') {
      skippedNote ??= NO_RECEIVER_NOTE
      continue
    }
    if (checkRfc(rfc).kind === 'generic') {
      skippedNote = GENERIC_RECEIVER_NOTE
      continue
    }
    return { found: { code, verification: f.receiver.tax_regime.verification, where: `${doc.tag}:${f.id}.receiver.tax_regime`, end }, note: skippedNote }
  }
  return { found: null, note: skippedNote }
}

export function fiscalRegime(ctx: StatementContext): Entry {
  const found: FoundRegime[] = []
  let skippedNote: string | null = null
  for (const doc of ctx.ledger.documents) {
    const res = findFiscalRegimeInDoc(doc, ctx.ledger.periods)
    if (res.note) skippedNote = res.note
    if (res.found) found.push(res.found)
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

interface AnchorCheck {
  ok: boolean
  where: string
  verification: Verification
}

function checkDocFiscalAnchor(
  f: StatementContext['ledger']['submitted'][number]['statement']['fiscal_documents'][number],
  doc: StatementContext['ledger']['submitted'][number],
  submittedRows: StatementContext['ledger']['submittedRows'],
): AnchorCheck | null {
  if (f.kind !== 'income') return null
  const total = f.total.value ?? (f.subtotal.value !== null && f.tax.value !== null ? round2(f.subtotal.value + f.tax.value) : null)
  const subtotal = f.subtotal.value
  if (total === null && subtotal === null) return null
  const feeRows = submittedRows.filter((r) => r.doc === doc && r.type === 'debit' && r.classification.category === 'fee')
  const fees = sumMoney(feeRows.map((r) => r.amount))
  const ok = (total !== null && Math.abs(fees - total) <= FISCAL_ANCHOR_TOLERANCE) || (subtotal !== null && Math.abs(fees - subtotal) <= FISCAL_ANCHOR_TOLERANCE)
  const verification = worst(f.total.verification, f.subtotal.verification, ...feeRows.map((r) => (r.verified ? 'verified' : 'unverified')))
  return { ok, where: `${doc.tag}:${f.id} comisiones=${String(fees)} cfdi=${String(total ?? subtotal)}`, verification }
}

/**
 * Fiscal anchor: the fee CFDI is signed by the SAT, outside the editable PDF. The document's fee
 * rows must add up to its total (if the bank itemizes IVA) or its subtotal (if not). A document
 * with no CFDI amounts does not count. It checks the whole document, every submitted one, with all
 * its movements: the CFDI covers the document, not the evaluated months.
 */
export function fiscalAnchor(ctx: StatementContext): Entry {
  const checks: AnchorCheck[] = []
  for (const doc of ctx.ledger.submitted) {
    for (const f of doc.statement.fiscal_documents) {
      const check = checkDocFiscalAnchor(f, doc, ctx.ledger.submittedRows)
      if (check) checks.push(check)
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
