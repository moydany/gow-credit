/**
 * Bloque fiscal (docs/09): ensamblado del CFDI impreso y sus cruces. Todos los cruces son
 * gratis: comparan el comprobante consigo mismo (encabezado contra cadena original, total
 * contra subtotal más IVA) y contra el resto del estado de cuenta (comisiones, RFC y tipo de
 * persona del titular).
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

/** "2025-02-01T10:12:33", "2025-02-01 10:12:33", "06/08/2025 03:06:55 AM" → "YYYY-MM-DDTHH:mm:ss". */
export function parseLocalDateTime(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, ' ')
  let m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
  let date: string | null
  let hh: number
  let mm: number
  let ss: number
  if (m) {
    date = m[1] ?? null
    hh = Number(m[2])
    mm = Number(m[3])
    ss = Number(m[4] ?? 0)
  } else {
    m = /^(\d{1,2}\/\d{1,2}\/\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM|a\.? ?m\.?|p\.? ?m\.?)?$/i.exec(s)
    if (!m) return null
    date = parseLooseDate(m[1] ?? '', null)
    hh = Number(m[2])
    mm = Number(m[3])
    ss = Number(m[4] ?? 0)
    const ampm = (m[5] ?? '').toLowerCase().replace(/[^ap]/g, '')
    if (ampm === 'p' && hh < 12) hh += 12
    if (ampm === 'a' && hh === 12) hh = 0
  }
  if (date === null || hh > 23 || mm > 59 || ss > 59) return null
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

export function assembleFiscal(list: readonly FiscalOut[], text: PageText): FiscalDocument[] {
  return list
    .filter((f) => f.values.some((v) => v.value.trim().length > 0))
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

/** Régimen fiscal del SAT → tipo de persona del contrato (docs/09 §4.7). */
const REGIME_TO_HOLDER: Record<string, HolderType> = {
  '601': 'legal_entity',
  '603': 'legal_entity',
  '612': 'individual_with_business_activity',
  '621': 'individual_with_business_activity',
  '626': 'individual_with_business_activity',
  '605': 'individual',
  '616': 'individual',
}

/** ¿Dos RFC son compatibles? El encabezado suele enmascarar caracteres con * o X. */
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
 * Cruces de docs/09 §4. Modifica en sitio la verificación de los campos del comprobante (y
 * del tipo de persona del titular) y agrega issues.
 */
export function crossCheckFiscal(docs: FiscalDocument[], holder: HolderRefs, periods: readonly Period[], issues: IssueSink): void {
  for (const f of docs) {
    const page = f.source.page
    const tag = `CFDI ${f.id} (página ${String(page)})`

    // 1. UUID con formato válido y igual al de la cadena original.
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
    // 2. Certificado del SAT igual al de la cadena; fechas solo como aviso.
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
      // 5. IVA cerca del 16 %: solo informativo (puede haber comisiones exentas).
      if (subtotal > 0) {
        const rate = tax / subtotal
        if (Math.abs(rate - 0.16) > 0.005) issues.add({ code: 'fiscal_totals_mismatch', severity: 'info', message: `${tag}: el IVA es ${(rate * 100).toFixed(1)} % del subtotal (no 16 %); puede haber conceptos exentos.`, page })
      }
    }
    // 4. Subtotal contra comisiones cobradas del periodo (CFDI de ingreso).
    if (f.kind === 'income' && f.subtotal.value !== null) {
      const fees = periods.map((p) => p.summary.fees_charged.value).filter((v): v is number => v !== null)
      if (fees.length > 0 && !fees.some((v) => Math.abs(v - (f.subtotal.value ?? 0)) <= 0.01) && !fees.some((v) => Math.abs(v - (f.total.value ?? -1)) <= 0.01)) {
        issues.add({ code: 'fiscal_fees_mismatch', severity: 'warning', message: `${tag}: el subtotal (${String(f.subtotal.value)}) no coincide con las comisiones cobradas del periodo (${fees.join(', ')}); puede haber comisiones exentas o cortes distintos.`, page })
      }
    }
    // 6. RFC del receptor contra el del titular.
    if (f.receiver.rfc.value !== null && holder.rfc.value !== null) {
      if (rfcCompatible(f.receiver.rfc.value, holder.rfc.value)) {
        f.receiver.rfc = verify(f.receiver.rfc)
      } else {
        f.receiver.rfc = conflict(f.receiver.rfc)
        issues.add({ code: 'fiscal_receiver_mismatch', severity: 'error', message: `${tag}: el RFC del receptor del CFDI no coincide con el del titular del estado de cuenta.`, page })
      }
    }
    // 7. Régimen fiscal del receptor contra el tipo de persona del titular.
    const regime = f.receiver.tax_regime.value?.match(/\d{3}/)?.[0]
    const expectedHolder = regime ? REGIME_TO_HOLDER[regime] : undefined
    if (expectedHolder && holder.holder_type.value !== null && holder.holder_type.value !== expectedHolder) {
      holder.holder_type = unverify(holder.holder_type)
      issues.add({ code: 'fiscal_receiver_mismatch', severity: 'warning', message: `${tag}: el régimen fiscal ${regime ?? ''} corresponde a ${expectedHolder}, pero el encabezado sugiere ${holder.holder_type.value}.`, page })
    }
    // 8. Formato de certificados y RFC.
    for (const [label, cert] of [['emisor', f.issuer_certificate], ['SAT', f.sat_certificate]] as const) {
      if (cert.value !== null && !CERT.test(cert.value)) issues.add({ code: 'fiscal_chain_mismatch', severity: 'warning', message: `${tag}: el número de certificado del ${label} no tiene 20 dígitos.`, page })
    }
    for (const [label, rfc] of [['del PAC', f.pac_rfc], ['del emisor', f.issuer.rfc], ['del receptor', f.receiver.rfc]] as const) {
      if (checkRfc(rfc.value).result === 'invalid') issues.add({ code: 'invalid_rfc', severity: 'warning', message: `${tag}: el RFC ${label} no tiene una estructura válida.`, page })
    }
  }
}
