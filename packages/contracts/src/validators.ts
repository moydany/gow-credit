/**
 * Validadores de formato que detectan invención (docs/04 §3.4): una CLABE "completada" por
 * el modelo falla el dígito verificador; un RFC inventado suele fallar la estructura o la
 * fecha. Un valor enmascarado no se puede verificar y no cuenta como inválido.
 */

export type FormatCheck = 'valid' | 'invalid' | 'masked' | 'absent'

const MASK = /[*xX•#]/

/** CLABE: 18 dígitos; el último es verificador con pesos 3, 7, 1 sobre los primeros 17. */
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
  // base12: el RFC sin dígito verificador, rellenado a 12 posiciones (persona moral lleva un espacio al inicio).
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
 * RFC de la contraparte impreso en la descripción de un movimiento (docs/09 §9.3): el primer
 * RFC con estructura y fecha válidas que no sea genérico ni el del propio titular.
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

/** RFC: 12 posiciones persona moral, 13 persona física; fecha válida; homoclave y verificador. */
export function checkRfc(raw: string | null): RfcCheck {
  if (raw === null) return { result: 'absent', kind: null, checkDigitOk: null }
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  if (s === 'XAXX010101000' || s === 'XEXX010101000') return { result: 'valid', kind: 'generic', checkDigitOk: null }
  // En un RFC la X puede ser letra del nombre: solo *, • y # cuentan como máscara.
  if (/[*•#]/.test(s)) return { result: 'masked', kind: null, checkDigitOk: null }
  const m = /^([A-ZÑ&]{3,4})(\d{6})([A-Z\d]{2})([A\d])$/.exec(s)
  if (!m) return { result: 'invalid', kind: null, checkDigitOk: null }
  const [, letters = '', date = '', homo = '', digit = ''] = m
  if (!validYymmdd(date)) return { result: 'invalid', kind: null, checkDigitOk: null }
  const kind = letters.length === 3 ? 'legal_entity' : 'individual'
  const base = (kind === 'legal_entity' ? ' ' : '') + letters + date + homo
  const ok = rfcCheckDigit(base) === digit
  // El dígito verificador no siempre coincide en RFCs reales antiguos: se reporta, no invalida.
  return { result: 'valid', kind, checkDigitOk: ok }
}
