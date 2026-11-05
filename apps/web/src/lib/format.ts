/** Formato y etiquetas en español (es-MX). Los estados son los canónicos de docs/README.md. */
import { FEATURE_CATALOG, type ApplicationStatus, type CorrectionTarget, type DecisionStatus, type FeatureName } from '@gow/contracts'

const mxn0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
const mxn2 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 })
const pct = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 1 })
const dateFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const dateTimeFmt = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const rel = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' })

export const money = (n: number | null | undefined, cents = false): string => (n === null || n === undefined ? '—' : (cents ? mxn2 : mxn0).format(n))
export const number = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : num.format(n))
export const percent = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : pct.format(n))

/** Fecha ISO (AAAA-MM-DD o con hora) en formato corto. Las fechas sin hora no se corren por zona horaria. */
export function date(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso)
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d)
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

/** Valor de una feature del perfil, según su unidad en el catálogo. */
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

/** Texto plano de cualquier valor JSON para umbrales de reglas. */
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

/** Qué valor se corrigió, en español, para el historial. */
export function describeTarget(t: CorrectionTarget): string {
  const f = FIELD_LABEL[t.field] ?? t.field
  return t.kind === 'holder' ? `Titular: ${f}` : t.kind === 'account' ? `Cuenta: ${f}` : t.kind === 'period' ? `Periodo: ${f}` : `Movimiento ${t.transaction_id}: ${f}`
}

export const TYPE_LABEL: Record<string, string> = { credit: 'Abono', debit: 'Cargo', individual: 'Persona física', individual_with_business_activity: 'Persona física con actividad empresarial', legal_entity: 'Persona moral' }
