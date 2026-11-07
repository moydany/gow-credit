/**
 * Fiscal block: assembly of the printed CFDI and its cross-checks. All checks are free: they
 * compare the invoice with itself (header against original string, total against subtotal plus
 * IVA) and with the rest of the statement (fees, holder RFC and person type).
 */
import type { FiscalDocument, HolderType, Period } from '@gow/contracts'
import { amountField, textField, type FieldOf } from './assemble.ts'
import type { IssueSink } from './issues.ts'
import { pick, type FiscalOut } from './llm-schema.ts'
import { parseAmount, parseLooseDate, round2 } from './normalize.ts'
import type { PageText } from './page-text.ts'
import { checkRfc } from './validators.ts'

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
const CERT = /^\d{20}$/

/**
 * Printed CFDI date and time -> "YYYY-MM-DDTHH:mm:ss" (local time): "2025-02-01T10:12:33",
 * "2025-02-01 10:12:33", "06/08/2025 03:06:55 AM", "01 de Octubre de 2025 a las 23:28:07".
 * The time is split off the text and the date goes through the shared date parser.
 */
export function parseLocalDateTime(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, ' ')
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
  const time = iso ? null : /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(a\.?\s?m\.?|p\.?\s?m\.?|AM|PM))?/i.exec(s)
  const date = iso ? (iso[1] ?? null) : time ? parseLooseDate(s.slice(0, time.index).replace(/\b(a las|hrs?\.?)\s*$/i, '').trim(), null) : null
  const parts = iso ? [iso[2], iso[3], iso[4]] : time ? [time[1], time[2], time[3]] : null
  if (date === null || parts === null) return null
  let hh = Number(parts[0])
  const mm = Number(parts[1])
  const ss = Number(parts[2] ?? 0)
  const ampm = (time?.[4] ?? '').toLowerCase().replace(/[^ap]/g, '')
  if (ampm === 'p' && hh < 12) hh += 12
  if (ampm === 'a' && hh === 12) hh = 0
  if (hh > 23 || mm > 59 || ss > 59) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date}T${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

function dateTimeField(c: { value: string; page: number; snippet: string }, text: PageText): FieldOf<string> {
  const base = textField(c, text)
  if (base.value === null) return base
  const v = parseLocalDateTime(base.value)
  return v === null ? { value: null, source: null, verification: 'unverified', confidence: 0, provenance: 'extracted' } : { ...base, value: v }
}

function upperField(c: { value: string; page: number; snippet: string }, text: PageText): FieldOf<string> {
  const f = textField({ ...c, value: c.value.replace(/\s+/g, '').toUpperCase() }, text)
  return f
}

/**
 * An invoice with no fiscal folio and no total plus issuer RFC cannot be identified or
 * cross-checked: it is a model false positive (Banamex in dev returned a "withholding" with a
 * single field). Dropped with an informational issue.
 */
function identifiable(f: FiscalOut): boolean {
  const has = (n: string) => pick(f.values, n).value.trim().length > 0
  return has('uuid') || (has('total') && has('issuer_rfc'))
}

export function assembleFiscal(list: readonly FiscalOut[], text: PageText, issues?: IssueSink): FiscalDocument[] {
  return list
    .filter((f) => {
      if (identifiable(f)) return true
      issues?.add({ code: 'invalid_uuid', severity: 'info', message: `Se descartó un comprobante fiscal de la página ${String(f.page)} sin folio fiscal ni total con RFC del emisor: no se puede identificar.`, page: f.page > 0 ? f.page : null })
      return false
    })
    .map((f, i) => {
      const v = (name: string) => pick(f.values, name)
      const page = text.validPage(f.page) ? f.page : (f.values.find((x) => text.validPage(x.page))?.page ?? 1)
      const currencyRaw = v('currency').value.trim().toUpperCase()
      const currency = /^[A-Z]{3}$/.test(currencyRaw) ? textField({ ...v('currency'), value: currencyRaw }, text) : textField({ value: '', page: 0, snippet: '' }, text)
      const truncated = f.seals_look_truncated === 'unknown' ? null : f.seals_look_truncated === 'yes'
      return {
        id: `f${String(i + 1)}`,
        kind: f.kind,
        version: textField(v('cfdi_version'), text),
        uuid: upperField(v('uuid'), text),
        series: textField(v('series'), text),
        folio: textField(v('folio'), text),
        issued_at: dateTimeField(v('issued_at'), text),
        certified_at: dateTimeField(v('certified_at'), text),
        issuer_certificate: textField({ ...v('issuer_certificate'), value: v('issuer_certificate').value.replace(/\s+/g, '') }, text),
        sat_certificate: textField({ ...v('sat_certificate'), value: v('sat_certificate').value.replace(/\s+/g, '') }, text),
        pac_rfc: upperField(v('pac_rfc'), text),
        issuer: { rfc: upperField(v('issuer_rfc'), text), name: textField(v('issuer_name'), text), tax_regime: textField(v('issuer_tax_regime'), text) },
        receiver: {
          rfc: upperField(v('receiver_rfc'), text),
          name: textField(v('receiver_name'), text),
          tax_regime: textField(v('receiver_tax_regime'), text),
          cfdi_use: upperField(v('receiver_cfdi_use'), text),
          postal_code: textField(v('receiver_postal_code'), text),
        },
        payment_form: textField(v('payment_form'), text),
        payment_method: upperField(v('payment_method'), text),
        currency,
        subtotal: amountField(cite(v('subtotal')), text),
        tax: amountField(cite(v('tax')), text),
        total: amountField(cite(v('total')), text),
        seals: { issuer_present: f.issuer_seal_present, sat_present: f.sat_seal_present, chain_present: f.original_chain_present, looks_truncated: truncated },
        original_chain: {
          uuid: upperField(v('chain_uuid'), text),
          certified_at: dateTimeField(v('chain_certified_at'), text),
          sat_certificate: textField({ ...v('chain_sat_certificate'), value: v('chain_sat_certificate').value.replace(/\s+/g, '') }, text),
        },
        source: { page, snippet: (f.snippet.trim() || 'representación impresa de un CFDI').slice(0, 600) },
      }
    })
}

function cite(c: { value: string; page: number; snippet: string }) {
  const value = parseAmount(c.value)
  return { value, page: c.page > 0 ? c.page : null, snippet: c.snippet.trim() || null }
}

/** SAT tax regime -> contract person type. */
const REGIME_TO_HOLDER: Record<string, HolderType> = {
  '601': 'legal_entity',
  '603': 'legal_entity',
  '612': 'individual_with_business_activity',
  '621': 'individual_with_business_activity',
  '626': 'individual_with_business_activity',
  '605': 'individual',
  '616': 'individual',
}

/** Are two RFCs compatible? The header often masks characters with * or X. */
function rfcCompatible(a: string, b: string): boolean {
  const x = a.replace(/\s/g, '').toUpperCase()
  const y = b.replace(/\s/g, '').toUpperCase()
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) {
    const c1 = x[i] ?? ''
    const c2 = y[i] ?? ''
    if (c1 === c2 || c1 === '*' || c2 === '*' || c1 === '•' || c2 === '•') continue
    return false
  }
  return true
}

const verify = <T>(f: FieldOf<T>): FieldOf<T> => (f.value !== null && f.source !== null ? { ...f, verification: 'verified', confidence: Math.max(f.confidence, 0.95) } : f)
const unverify = <T>(f: FieldOf<T>): FieldOf<T> => (f.value !== null ? { ...f, verification: 'unverified', confidence: Math.min(f.confidence, 0.4) } : f)
const conflict = <T>(f: FieldOf<T>): FieldOf<T> => (f.value !== null ? { ...f, verification: 'conflict', confidence: Math.min(f.confidence, 0.2) } : f)

export interface HolderRefs {
  rfc: FieldOf<string>
  holder_type: FieldOf<HolderType>
}

/**
 * Cross-checks. Mutates in place the verification of the invoice fields (and of the holder's
 * person type) and adds issues.
 */
export function crossCheckFiscal(docs: FiscalDocument[], holder: HolderRefs, periods: readonly Period[], issues: IssueSink): void {
  for (const f of docs) {
    const page = f.source.page
    const tag = `CFDI ${f.id} (página ${String(page)})`

    // 1. UUID well-formed and equal to the original string's.
    if (f.uuid.value !== null && !UUID.test(f.uuid.value)) {
      f.uuid = unverify(f.uuid)
      issues.add({ code: 'invalid_uuid', severity: 'error', message: `${tag}: el folio fiscal no tiene el formato 8-4-4-4-12 hexadecimal.`, page })
    }
    if (f.uuid.value !== null && f.original_chain.uuid.value !== null) {
      if (f.uuid.value === f.original_chain.uuid.value) {
        f.uuid = verify(f.uuid)
        f.original_chain.uuid = verify(f.original_chain.uuid)
      } else {
        f.uuid = conflict(f.uuid)
        issues.add({ code: 'fiscal_chain_mismatch', severity: 'error', message: `${tag}: el folio fiscal del encabezado no coincide con el de la cadena original.`, page })
      }
    }
    // 2. SAT certificate equal to the string's; dates only as a warning.
    if (f.sat_certificate.value !== null && f.original_chain.sat_certificate.value !== null) {
      if (f.sat_certificate.value === f.original_chain.sat_certificate.value) f.sat_certificate = verify(f.sat_certificate)
      else {
        f.sat_certificate = conflict(f.sat_certificate)
        issues.add({ code: 'fiscal_chain_mismatch', severity: 'error', message: `${tag}: el certificado del SAT no coincide con el de la cadena original.`, page })
      }
    }
    if (f.certified_at.value !== null && f.original_chain.certified_at.value !== null && f.certified_at.value !== f.original_chain.certified_at.value) {
      issues.add({ code: 'fiscal_chain_mismatch', severity: 'warning', message: `${tag}: la fecha de certificación impresa (${f.certified_at.value}) no coincide con la de la cadena original (${f.original_chain.certified_at.value}).`, page })
    }
    // 3. total = subtotal + IVA.
    const [subtotal, tax, total] = [f.subtotal.value, f.tax.value, f.total.value]
    if (subtotal !== null && tax !== null && total !== null) {
      const expected = round2(subtotal + tax)
      if (Math.abs(expected - total) <= 0.01) {
        f.subtotal = verify(f.subtotal)
        f.tax = verify(f.tax)
        f.total = verify(f.total)
      } else {
        issues.add({ code: 'fiscal_totals_mismatch', severity: 'error', message: `${tag}: subtotal ${String(subtotal)} + IVA ${String(tax)} = ${String(expected)}, pero el total impreso es ${String(total)}.`, page })
      }
      // 5. IVA near 16%: informational only (there may be exempt fees).
      if (subtotal > 0) {
        const rate = tax / subtotal
        if (Math.abs(rate - 0.16) > 0.005) issues.add({ code: 'fiscal_totals_mismatch', severity: 'info', message: `${tag}: el IVA es ${(rate * 100).toFixed(1)} % del subtotal (no 16 %); puede haber conceptos exentos.`, page })
      }
    }
    // 4. Subtotal against fees charged in the period (income CFDI).
    if (f.kind === 'income' && f.subtotal.value !== null) {
      const fees = periods.map((p) => p.summary.fees_charged.value).filter((v): v is number => v !== null)
      if (fees.length > 0 && !fees.some((v) => Math.abs(v - (f.subtotal.value ?? 0)) <= 0.01) && !fees.some((v) => Math.abs(v - (f.total.value ?? -1)) <= 0.01)) {
        issues.add({ code: 'fiscal_fees_mismatch', severity: 'warning', message: `${tag}: el subtotal (${String(f.subtotal.value)}) no coincide con las comisiones cobradas del periodo (${fees.join(', ')}); puede haber comisiones exentas o cortes distintos.`, page })
      }
    }
    // 6. Receiver RFC against the holder's.
    if (f.receiver.rfc.value !== null && holder.rfc.value !== null) {
      if (rfcCompatible(f.receiver.rfc.value, holder.rfc.value)) {
        f.receiver.rfc = verify(f.receiver.rfc)
      } else {
        f.receiver.rfc = conflict(f.receiver.rfc)
        issues.add({ code: 'fiscal_receiver_mismatch', severity: 'error', message: `${tag}: el RFC del receptor del CFDI no coincide con el del titular del estado de cuenta.`, page })
      }
    }
    // 7. Receiver tax regime against the holder's person type.
    const regime = f.receiver.tax_regime.value?.match(/\d{3}/)?.[0]
    const expectedHolder = regime ? REGIME_TO_HOLDER[regime] : undefined
    if (expectedHolder && holder.holder_type.value !== null && holder.holder_type.value !== expectedHolder) {
      holder.holder_type = unverify(holder.holder_type)
      issues.add({ code: 'fiscal_receiver_mismatch', severity: 'warning', message: `${tag}: el régimen fiscal ${regime ?? ''} corresponde a ${expectedHolder}, pero el encabezado sugiere ${holder.holder_type.value}.`, page })
    }
    // The stamp date is a SAT timestamp. Far from the period end, the document was generated much
    // later or the period was edited.
    const stamped = f.certified_at.value?.slice(0, 10) ?? null
    const ends = periods.map((p) => p.period_end.value ?? p.statement_date.value).filter((d): d is string => d !== null)
    const lastEnd = ends.sort().at(-1) ?? null
    if (stamped !== null && lastEnd !== null) {
      const gap = Math.round((Date.parse(`${stamped}T00:00:00Z`) - Date.parse(`${lastEnd}T00:00:00Z`)) / 86_400_000)
      if (gap > 30 || gap < -5) {
        issues.add({ code: 'date_out_of_period', severity: 'warning', message: `${tag}: el timbrado (${stamped}) está a ${String(gap)} días del fin del periodo (${lastEnd}); el estado de cuenta pudo generarse mucho después o el periodo pudo editarse.`, page })
      }
    }
    // 8. Certificate and RFC format.
    for (const [label, cert] of [['emisor', f.issuer_certificate], ['SAT', f.sat_certificate]] as const) {
      if (cert.value !== null && !CERT.test(cert.value)) issues.add({ code: 'fiscal_chain_mismatch', severity: 'warning', message: `${tag}: el número de certificado del ${label} no tiene 20 dígitos.`, page })
    }
    for (const [label, rfc] of [['del PAC', f.pac_rfc], ['del emisor', f.issuer.rfc], ['del receptor', f.receiver.rfc]] as const) {
      if (checkRfc(rfc.value).result === 'invalid') issues.add({ code: 'invalid_rfc', severity: 'warning', message: `${tag}: el RFC ${label} no tiene una estructura válida.`, page })
    }
  }
}
