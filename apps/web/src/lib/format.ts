/** Formatting and labels in Spanish (es-MX). Statuses are the canonical ones. */
import { FEATURE_CATALOG, type ApplicationStatus, type CorrectionTarget, type DecisionStatus, type FeatureName } from '@gow/contracts'

const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 })
const pct = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 1 })
// A date without a time (due date, movement date) is a calendar day: never shifted in UTC.
// An instant (created, decided) is shown in the viewer's browser zone.
const calendarDateFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const localDateFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const rel = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' })

/** Mexican pesos always with cents and currency: "$149,937.00 MXN". */
export const money = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${mxn.format(n)} MXN`)
/** For big figures: amount and currency apart, so "MXN" can be smaller. */
export const moneyParts = (n: number | null | undefined): { amount: string; currency: string | null } => (n === null || n === undefined ? { amount: '—', currency: null } : { amount: mxn.format(n), currency: 'MXN' })
export const number = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : num.format(n))
export const percent = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : pct.format(n))

/**
 * ISO date, short format. YYYY-MM-DD is a calendar day and is shown as is; an instant with a time
 * is shown in the browser's time zone (23:00 on November 6 in Mexico is not "7 nov").
 */
export function date(iso: string | null | undefined): string {
  if (!iso) return '—'
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  const d = new Date(calendar ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return (calendar ? calendarDateFmt : localDateFmt).format(d)
}

/** Today as YYYY-MM-DD in the browser's zone (not UTC, which in Mexico is already tomorrow from 18:00). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
export const dateTime = (iso: string): string => dateTimeFmt.format(new Date(iso))

export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return 'ahora'
  if (abs < 3600) return rel.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rel.format(Math.round(s / 3600), 'hour')
  return rel.format(Math.round(s / 86400), 'day')
}

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  received: 'Recibida',
  extracting: 'Extrayendo',
  extracted: 'Extraída',
  deciding: 'Evaluando',
  needs_clarification: 'Pide aclaración',
  human_review: 'Revisión humana',
  qualified: 'Calificada',
  qualified_with_limit: 'Con línea',
  not_qualified: 'No calificada',
  failed: 'Falló',
}

export const DECISION_LABEL: Record<DecisionStatus, string> = {
  qualified: 'Calificada',
  qualified_with_limit: 'Calificada con línea',
  not_qualified: 'No calificada',
  needs_clarification: 'Pide aclaración',
  human_review: 'Revisión humana',
}

export const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Correo', manual: 'Manual' } as const

export const CATEGORY_LABEL: Record<string, string> = {
  customer_payment: 'Pago de cliente',
  own_transfer: 'Traspaso propio',
  loan_disbursement: 'Préstamo recibido',
  loan_payment: 'Pago de crédito',
  payroll: 'Nómina',
  supplier_payment: 'Pago a proveedor',
  tax: 'Impuestos',
  fee: 'Comisión',
  interest: 'Intereses',
  other: 'Otro',
}

export const OUTCOME_LABEL = { paid: 'Pagó a tiempo', late: 'Con atraso', default: 'Mora', fraud: 'Fraude' } as const

export const ISSUE_SEVERITY_LABEL = { info: 'Info', warning: 'Aviso', error: 'Error' } as const

export const PROVENANCE_LABEL: Record<string, string> = { extracted: 'Del documento', owner_answer: 'Respuesta del proveedor', analyst_answer: 'Respuesta del analista', external: 'Fuente externa' }
export const VERIFICATION_LABEL: Record<string, string> = { verified: 'Verificado', unverified: 'Sin verificar', conflict: 'En conflicto' }

export const ENUM_LABEL: Record<string, string> = {
  match: 'Coincide', partial: 'Parcial', mismatch: 'No coincide',
  overdraft: 'Sobregiro', returned_check: 'Cheque devuelto', garnishment: 'Embargo', judicial_order: 'Orden judicial', tax_requirement: 'Requerimiento fiscal',
  compliant: 'Al corriente', non_compliant: 'Con incumplimiento',
  valid: 'Vigente', cancelled: 'Cancelado', not_found: 'No encontrado',
  clear: 'Limpio', efos_presumed: 'EFOS presunto', efos_definitive: 'EFOS definitivo', not_located: 'No localizado',
}

/** Value of a profile feature, by its unit in the catalog. */
export function featureValue(name: FeatureName, value: unknown): string {
  if (value === null || value === undefined) return '—'
  const unit = FEATURE_CATALOG[name].unit
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (typeof value === 'string') return ENUM_LABEL[value] ?? value
  if (Array.isArray(value)) return value.length === 0 ? 'Ninguna' : `${String(value.length)} ${typeof value[0] === 'string' ? '· ' + value.map((v) => ENUM_LABEL[String(v)] ?? String(v)).join(', ') : 'registros'}`
  if (typeof value === 'number') {
    if (unit === 'MXN') return money(value)
    if (unit === 'ratio') return percent(value)
    if (unit === 'months') return `${number(value)} meses`
    if (unit === 'days') return `${number(value)} días`
    return number(value)
  }
  return JSON.stringify(value)
}

export const featureLabel = (name: FeatureName): string => FEATURE_CATALOG[name].description

/** Plain text of any JSON value, for rule thresholds. */
export function jsonValue(v: unknown): string {
  const plain = (x: unknown): string => (typeof x === 'string' ? (ENUM_LABEL[x] ?? x) : typeof x === 'number' ? number(x) : typeof x === 'boolean' ? (x ? 'Sí' : 'No') : x === null || x === undefined ? '—' : JSON.stringify(x))
  return Array.isArray(v) ? v.map(plain).join(', ') : plain(v)
}

export const OP_LABEL: Record<string, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠', in: 'es uno de', not_in: 'no es', empty: 'vacío', not_empty: 'no vacío' }

const FIELD_LABEL: Record<string, string> = {
  name: 'nombre', rfc: 'RFC', holder_type: 'tipo de titular', clabe: 'CLABE', account_number: 'número de cuenta',
  opening_balance: 'saldo inicial', closing_balance: 'saldo final', total_credits: 'total de abonos', total_debits: 'total de cargos', credits_count: 'número de abonos', debits_count: 'número de cargos',
  amount: 'monto', type: 'sentido', date: 'fecha',
}

/** Which value was corrected, in Spanish, for the history. */
export function describeTarget(t: CorrectionTarget): string {
  const f = FIELD_LABEL[t.field] ?? t.field
  return t.kind === 'holder' ? `Titular: ${f}` : t.kind === 'account' ? `Cuenta: ${f}` : t.kind === 'period' ? `Periodo: ${f}` : `Movimiento ${t.transaction_id}: ${f}`
}

export const TYPE_LABEL: Record<string, string> = { credit: 'Abono', debit: 'Cargo', individual: 'Persona física', individual_with_business_activity: 'Persona física con actividad empresarial', legal_entity: 'Persona moral' }
