/**
 * Format validators that detect invention: a CLABE "completed" by the model fails the check
 * digit; an invented RFC usually fails the structure or the date. A masked value cannot be
 * verified and does not count as invalid.
 */

export type FormatCheck = 'valid' | 'invalid' | 'masked' | 'absent'

const MASK = /[*xX•#]/

/** CLABE: 18 digits; the last is a check digit with weights 3, 7, 1 over the first 17. */
export function checkClabe(raw: string | null): FormatCheck {
  if (raw === null) return 'absent'
  const s = raw.replace(/[\s-]/g, '')
  if (MASK.test(s)) return 'masked'
  if (!/^\d{18}$/.test(s)) return 'invalid'
  const weights = [3, 7, 1]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (Number(s[i]) * (weights[i % 3] ?? 1)) % 10
  const check = (10 - (sum % 10)) % 10
  return check === Number(s[17]) ? 'valid' : 'invalid'
}

const RFC_CHARSET = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ'

function rfcCheckDigit(base12: string): string {
  // base12: the RFC without check digit, padded to 12 positions (a legal entity gets a leading space).
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const v = RFC_CHARSET.indexOf(base12[i] ?? ' ')
    sum += (v < 0 ? 0 : v) * (13 - i)
  }
  const r = 11 - (sum % 11)
  return r === 11 ? '0' : r === 10 ? 'A' : String(r)
}

function validYymmdd(s: string): boolean {
  const mm = Number(s.slice(2, 4))
  const dd = Number(s.slice(4, 6))
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
}

export interface RfcCheck {
  result: FormatCheck
  kind: 'individual' | 'legal_entity' | 'generic' | null
  checkDigitOk: boolean | null
}

const RFC_IN_TEXT = /(?<![A-ZÑ&\d])([A-ZÑ&]{3,4}\d{6}[A-Z\d]{2}[A\d])(?![A-ZÑ&\d])/g

/**
 * Counterparty RFC printed in a transaction description: the first RFC with valid structure and
 * date that is neither generic nor the holder's own.
 */
export function findCounterpartyRfc(description: string, holderRfc: string | null = null): string | null {
  const text = description.toUpperCase()
  const holder = holderRfc?.replace(/\s/g, '').toUpperCase() ?? null
  for (const m of text.matchAll(RFC_IN_TEXT)) {
    const rfc = m[1] ?? ''
    const check = checkRfc(rfc)
    if (check.result !== 'valid' || check.kind === 'generic') continue
    if (holder !== null && holder === rfc) continue
    return rfc
  }
  return null
}

/**
 * Root of an RFC without homoclave: 3 letters + date (legal entity, 9 positions) or 4 letters +
 * date (natural person, 10). Several banks print the holder RFC this way. null if it is not a
 * root with a valid date.
 */
export function rfcRoot(raw: string | null): string | null {
  if (raw === null) return null
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  const m = /^([A-ZÑ&]{3,4})(\d{6})$/.exec(s)
  return m?.[2] && validYymmdd(m[2]) ? s : null
}

/** RFC: 12 positions legal entity, 13 natural person; valid date; homoclave and check digit. */
export function checkRfc(raw: string | null): RfcCheck {
  if (raw === null) return { result: 'absent', kind: null, checkDigitOk: null }
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  if (s === 'XAXX010101000' || s === 'XEXX010101000') return { result: 'valid', kind: 'generic', checkDigitOk: null }
  // In an RFC the X can be a name letter: only *, • and # count as a mask.
  if (/[*•#]/.test(s)) return { result: 'masked', kind: null, checkDigitOk: null }
  const m = /^([A-ZÑ&]{3,4})(\d{6})([A-Z\d]{2})([A\d])$/.exec(s)
  if (!m) return { result: 'invalid', kind: null, checkDigitOk: null }
  const [, letters = '', date = '', homo = '', digit = ''] = m
  if (!validYymmdd(date)) return { result: 'invalid', kind: null, checkDigitOk: null }
  const kind = letters.length === 3 ? 'legal_entity' : 'individual'
  const base = (kind === 'legal_entity' ? ' ' : '') + letters + date + homo
  const ok = rfcCheckDigit(base) === digit
  // The check digit does not always match in old real RFCs: it is reported, not invalidating.
  return { result: 'valid', kind, checkDigitOk: ok }
}
