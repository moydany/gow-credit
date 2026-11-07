/**
 * Conversación por WhatsApp o correo (docs/02 §3, docs/05 §2b; ADR 0017): una pregunta a la vez,
 * con opciones numeradas, y la respuesta se lee contra la pregunta que se está esperando. Por estos
 * canales se preguntan abonos, cargos, el cliente principal (texto libre) y el uso de la cuenta
 * (ADR 0050); identidad y documentos nuevos exigen un canal con segundo factor (enlace de un solo
 * uso o backoffice), así que van por la API. La excepción es el estado de
 * cuenta en PDF desde un vínculo verificado de WhatsApp, que abre una solicitud (ADR 0037).
 *
 * Lectura de la respuesta: número de opción, nombre de la opción o palabras clave. Si coinciden
 * dos categorías o ninguna, no se adivina: se vuelve a preguntar con las opciones numeradas
 * (docs/04 §4). El texto nunca autoriza nada: solo se compara contra la pregunta abierta de ese
 * número.
 */
import type { AccountUse, ChargeAnswerCategory, Decision, DepositAnswerCategory, FailureInfo, OwnerAnswer, Question } from '@gow/contracts'

export const GENERIC_NO_PENDING = 'Hola. No tenemos una solicitud pendiente de aclarar para este número. Si crees que es un error, contacta a quien te pidió la información.'

/**
 * Respuestas fijas a un documento recibido por WhatsApp (ADR 0037). No dicen nada del contenido
 * ni del resultado: el veredicto se consulta por la API o el backoffice, nunca por este canal.
 */
export const DOCUMENT_REPLIES = {
  received: 'Recibimos tu estado de cuenta. Lo estoy revisando y en unos minutos te digo hasta cuánto te podemos adelantar.',
  duplicate: 'Ya habíamos recibido este estado de cuenta y sigue en revisión. No hace falta mandarlo de nuevo.',
  rejected: 'No pudimos recibir el documento. Mándalo de nuevo como archivo PDF de hasta 40 MB, tal como lo descargaste de tu banco.',
  /** PDF que pide contraseña para abrirse (ADR 0049): se contesta de inmediato y no se abre solicitud. */
  password_protected: 'Tu PDF tiene contraseña y no lo puedo abrir. Descárgalo de nuevo desde tu banco sin contraseña (o quítasela) y mándamelo por aquí.',
  ambiguous: 'Este número está registrado con más de una empresa, así que no sabemos a cuál corresponde el documento. Pide a quien te contactó que lo suba por su sistema.',
  no_link: 'Hola. Este número no está registrado para recibir documentos. Si crees que es un error, contacta a quien te pidió la información.',
} as const

/**
 * Registro de un proveedor que escribe por primera vez (ADR 0038 y 0047, solo en la demo con
 * `WHATSAPP_SELF_REGISTRATION`). Primero el estado de cuenta; al leerlo, el titular y el RFC que
 * trae se le muestran al mismo número que lo mandó para que los confirme o corrija, y se pide lo que
 * falte. El resultado sale cuando termina el registro.
 */
/**
 * Aviso de que el caso queda con un analista (ADR 0051): la aclaración solo tiene preguntas que no se
 * hacen por el chat, se agotaron las rondas o la identidad no se pudo confirmar. El proveedor nunca se
 * queda sin respuesta.
 */
export const ANALYST_NOTICE = 'Un analista revisará tu estado de cuenta y te avisaremos el resultado por este chat.'

/** Respuesta a una foto, nota de voz, video o sticker (ADR 0051): solo se lee el PDF. */
export const MEDIA_UNSUPPORTED = 'Solo puedo leer el estado de cuenta en PDF, tal como lo descargas de tu banco.'

const ASK_STATEMENT = 'Para empezar, mándame por este chat tu estado de cuenta bancario más reciente en PDF, tal como lo descargaste de tu banco.'
const YES_NO = 'Responde sí o no.'

/** Por qué se pide el RFC: viene sin homoclave, no viene completo o el proveedor corrigió los datos. */
export type RfcAskReason = { kind: 'root'; root: string } | { kind: 'missing' } | { kind: 'corrected' }

export const REGISTRATION_REPLIES = {
  welcome: (tenantName: string) => `Hola, te escribe el asistente de ${tenantName}. Reviso tu estado de cuenta para decirte hasta cuánto te podemos adelantar del pago de tus facturas.\n\n${ASK_STATEMENT}`,
  ask_statement: ASK_STATEMENT,
  reading: 'Recibí tu estado de cuenta y lo estoy leyendo. En un momento te pido que confirmes tus datos.',
  still_reading: 'Sigo leyendo tu estado de cuenta. En un momento te pido que confirmes tus datos; no hace falta mandarlo de nuevo.',
  /** El titular leído, con o sin RFC completo. Un RFC sin homoclave se pide después, por separado. */
  confirm: (name: string, rfc: string | null) =>
    rfc ? `Ya leí tu estado de cuenta. Está a nombre de ${name}, con RFC ${rfc}.\n\n¿Son correctos? ${YES_NO}` : `Ya leí tu estado de cuenta. Está a nombre de ${name}.\n\n¿Es correcto? ${YES_NO}`,
  invalid_yes_no: `No entendí tu respuesta. ${YES_NO}`,
  ask_name_unread: 'Ya leí tu estado de cuenta, pero no pude leer el nombre del titular. ¿Me escribes la razón social o el nombre completo del titular de la cuenta?',
  ask_name_corrected: 'Entendido. ¿A nombre de quién está la cuenta? Escribe la razón social o el nombre completo del titular, tal como lo registraste ante el SAT.',
  ask_name: '¿Me escribes la razón social o el nombre completo del titular de la cuenta?',
  invalid_name: 'No pude leer el nombre. Escríbelo completo, por ejemplo: Distribuidora del Norte SA de CV o Ana María López Pérez.',
  ask_rfc: (why: RfcAskReason) =>
    why.kind === 'root'
      ? `En tu estado de cuenta el RFC viene sin homoclave (${why.root}). Escribe tu RFC completo, con los 3 caracteres de la homoclave.`
      : why.kind === 'missing'
        ? 'En tu estado de cuenta no viene el RFC completo. Escribe el RFC del titular (12 caracteres si es persona moral, 13 si es persona física).'
        : 'Ahora escribe el RFC del titular (12 caracteres si es persona moral, 13 si es persona física).',
  invalid_rfc: 'Ese RFC no tiene el formato correcto. Escríbelo sin espacios ni guiones, por ejemplo: DNO150304AB1.',
  rfc_root_mismatch: (root: string) => `Ese RFC no empieza como el de tu estado de cuenta (${root}). Revísalo y escríbelo completo, con homoclave.`,
  ask_representative: 'Como es una persona moral, ¿cómo se llama su representante legal? Escribe su nombre completo.',
  invalid_representative: 'No pude leer el nombre del representante legal. Escríbelo completo, por ejemplo: Ana María López Pérez.',
  /** Un PDF o un texto mientras se espera un dato del registro. */
  pending_first: 'Antes de recibir otro documento necesito que terminemos con tus datos.',
  thanks: (name: string) => `Gracias, quedaron registrados los datos de ${name}.`,
  finishing: 'Estoy terminando la revisión; en un momento te mando el resultado.',
  analyst: ANALYST_NOTICE,
  idle: (legalName: string) => `Hola. Ya tienes registrada a ${legalName}. Si quieres que revisemos un estado de cuenta, mándalo en PDF por este chat.`,
} as const

/** "sí" / "no" con sus variantes comunes; cualquier otra cosa, null. */
export function parseYesNo(text: string): boolean | null {
  const t = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[¡!¿?.,]/g, '')
    .trim()
  if (/^no (se|lo se|estoy seguro|recuerdo)\b/.test(t)) return null
  if (/^(si|sip|sii+|claro|correcto|correctos|es correcto|son correctos|asi es|exacto|ok|okay|va|de acuerdo|afirmativo|1)( (gracias|son|es|correcto|correctos))*$/.test(t)) return true
  if (/^(no|nop|nel|incorrecto|incorrectos|no es correcto|no son correctos|no son|no es|negativo|2)( .*)?$/.test(t)) return false
  return null
}

/** Persona moral (12 caracteres) o física (13), por la longitud del RFC. */
export function personTypeOf(rfc: string): 'moral' | 'fisica' {
  return rfc.length === 12 ? 'moral' : 'fisica'
}

/** Razón social legible: espacios normalizados, entre 3 y 200 caracteres y con al menos una letra. */
export function parseLegalName(text: string): string | null {
  const name = text.replace(/\s+/g, ' ').trim()
  return name.length >= 3 && name.length <= 200 && /\p{L}/u.test(name) ? name : null
}

/** RFC de persona moral (12) o física (13), en mayúsculas y sin espacios ni guiones. */
export function parseRfc(text: string): string | null {
  const rfc = text.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(rfc) ? rfc : null
}

/** Preguntas que se hacen por un canal conversacional. */
export function isConversational(q: Question): boolean {
  return q.kind === 'deposit' || q.kind === 'charge' || q.kind === 'buyer' || q.kind === 'account_use'
}

export function renderQuestion(q: Question, position: number, total: number): string {
  const head = total > 1 ? `Pregunta ${String(position)} de ${String(total)}. ` : ''
  const options = q.options.map((o, i) => `${String(i + 1)}) ${o.label}`).join('\n')
  return `${head}${q.text}${options ? `\n\nResponde con el número:\n${options}` : ''}`
}

export function renderReask(q: Question): string {
  if (q.kind === 'buyer') return 'No entendimos tu respuesta. Escribe solo el nombre de la empresa que te paga las facturas, por ejemplo: Cadena Comercial del Norte. Si no lo sabes, escribe no sé.'
  const options = q.options.map((o, i) => `${String(i + 1)}) ${o.label}`).join('\n')
  return `No entendimos tu respuesta. Responde solo con el número de la opción:\n${options}`
}

const DECLINE = /\bno (lo )?(se|recuerdo|tengo|estoy segur[oa])\b|\bni idea\b/

const KEYWORDS: readonly (readonly [DepositAnswerCategory | 'decline', RegExp])[] = [
  ['decline', DECLINE],
  ['own_transfer', /\btraspaso\b|\b(mi|mis) (otra )?cuentas?\b|\bcuenta (mia|propia)\b|\bentre (mis )?cuentas\b|\bmio\b|\bmia\b/],
  ['loan_disbursement', /\bprestamo\b|\bcredito\b|\bfinanciera\b|\bfinanciamiento\b/],
  ['interest', /\binteres(es)?\b|\brendimientos?\b/],
  ['customer_payment', /\bpago de (un |mi )?cliente\b|\bcliente\b|\bventas?\b|\bcobro\b|\bfactura\b|\bme pago\b/],
  ['other', /\botra cosa\b|\botro\b/],
]

/** Cargos (ADR 0050). "Pago de mi tarjeta personal" coincide con dos: se vuelve a preguntar. */
const CHARGE_KEYWORDS: readonly (readonly [ChargeAnswerCategory | 'decline', RegExp])[] = [
  ['decline', DECLINE],
  ['own_transfer', /\btraspaso\b|\b(a |de )?(mi|mis) (otra )?cuentas?\b|\bcuenta (mia|propia)\b|\bentre (mis )?cuentas\b|\bme (lo )?(pase|mande|transferi)\b/],
  ['loan_payment', /\bprestamo\b|\bcredito\b|\bfinanciera\b|\bmensualidad\b|\btarjeta\b|\bhipoteca\b|\barrendamiento\b/],
  ['supplier_payment', /\bproveedor(es)?\b|\bmercancia\b|\binsumos?\b|\bmateriales?\b|\bdel negocio\b|\bde la empresa\b|\brenta del (local|negocio)\b/],
  ['personal_expense', /\bpersonal(es)?\b|\bde la casa\b|\bfamilia(r)?\b|\bgasto mio\b/],
  ['other', /\botra cosa\b|\botro\b/],
]

/** Uso de la cuenta (ADR 0050). "Solo negocio, nada personal" coincide con los dos: se vuelve a preguntar. */
const ACCOUNT_USE_KEYWORDS: readonly (readonly [AccountUse | 'decline', RegExp])[] = [
  ['decline', DECLINE],
  ['business_only', /\bsolo (para |de |es )?(el |mi |la )?(negocio|empresa|trabajo)\b|\bsolo negocio\b|\bexclusiva(mente)?\b|\bnada mas (para |de )?(el |mi )?negocio\b/],
  ['mixed', /\bpersonal(es)?\b|\btambien\b|\bambos\b|\bambas\b|\blas dos\b|\bmixt[ao]\b|\bde todo\b/],
]

/** Respuestas que no dan un nombre de cliente: cuentan como "no sé". */
const NO_BUYER = /^(no (lo )?(se|recuerdo|tengo|hay|estoy segur[oa])|ni idea|omitir|omite|ninguno|ninguna|nadie|varios|muchos|no tengo (uno|cliente principal)|n a|na)$/
/** Lo que empieza como saludo, cortesía o sí/no no es un nombre: se vuelve a preguntar. */
const NOT_A_NAME = /^(hola|buen(os|as)|que tal|hey|gracias|ok|okay|si|no|sale|va|listo|claro|perdon|disculpa)\b/
/** Lo que se quita de "mi cliente es X" o "se llama X" antes de leer el nombre. */
const BUYER_PREFIX = /^\s*(?:(?:mi )?(?:cliente(?: principal)?|comprador)\s+(?:es|se llama)\s+|(?:es|se llama|son)\s+)/i

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * La opción elegida: número, nombre de la opción o palabras clave (una sola categoría). "decline" es
 * "no sé"; null si no se puede leer sin adivinar.
 */
function readOption<C extends string>(t: string, q: Question, keywords: readonly (readonly [C | 'decline', RegExp])[]): C | 'decline' | null {
  const number = /^(?:opcion |la )?(\d)\b/.exec(t)
  if (number) {
    const option = q.options[Number(number[1]) - 1]
    if (option) return option.value as C
  }
  const byLabel = q.options.filter((o) => t.includes(normalize(o.label)))
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0].value as C
  const hits = keywords.filter(([, re]) => re.test(t)).map(([c]) => c)
  // "pago de cliente" y "otro" pueden coincidir juntos en una frase larga: gana lo específico.
  const specific = hits.filter((c) => c !== 'other')
  const chosen = specific.length > 0 ? specific : hits
  return chosen.length === 1 ? (chosen[0] ?? null) : null
}

/**
 * Nombre del cliente principal en texto libre (ADR 0050): se quita "mi cliente es", y vale si
 * `parseLegalName` lo acepta, no es una pregunta y no pasa de 120 caracteres.
 */
function readBuyerName(text: string): { name: string } | 'decline' | null {
  const t = normalize(text)
  if (NO_BUYER.test(t) || isSkip(text)) return 'decline'
  if (DECLINE.test(t) && t.split(' ').length <= 6) return 'decline'
  if (/[?¿]/.test(text) || /^\d+$/.test(t) || NOT_A_NAME.test(t)) return null
  const name = parseLegalName(text.replace(BUYER_PREFIX, '').replace(/[.!¡]+$/u, ''))
  return name !== null && name.length <= 120 ? { name } : null
}

/** La respuesta a una pregunta conversacional, o null si no se puede leer sin adivinar. */
export function parseReply(text: string, q: Question): OwnerAnswer | null {
  const decline = { question_id: q.id, kind: 'decline' as const, note: null }
  switch (q.kind) {
    case 'deposit': {
      const c = readOption(normalize(text), q, KEYWORDS)
      return c === null ? null : c === 'decline' ? decline : { question_id: q.id, kind: 'deposit', category: c, counterparty: null }
    }
    case 'charge': {
      const c = readOption(normalize(text), q, CHARGE_KEYWORDS)
      return c === null ? null : c === 'decline' ? decline : { question_id: q.id, kind: 'charge', category: c, counterparty: null }
    }
    case 'account_use': {
      const c = readOption(normalize(text), q, ACCOUNT_USE_KEYWORDS)
      return c === null ? null : c === 'decline' ? decline : { question_id: q.id, kind: 'account_use', use: c }
    }
    case 'buyer': {
      const read = readBuyerName(text)
      return read === null ? null : read === 'decline' ? decline : { question_id: q.id, kind: 'buyer', name: read.name }
    }
    case 'identity':
    case 'documents':
      return null
  }
}

/** Índice de la siguiente pregunta conversacional desde `from` (inclusive), o -1. */
export function nextConversational(questions: readonly Question[], from: number): number {
  for (let i = Math.max(0, from); i < questions.length; i++) if (questions[i] && isConversational(questions[i] as Question)) return i
  return -1
}

/** Toda pregunta tiene respuesta (incluido "no sé"): la aclaración se puede reanudar. */
export function isComplete(questions: readonly Question[], answers: readonly OwnerAnswer[]): boolean {
  const answered = new Set(answers.map((a) => a.question_id))
  return questions.every((q) => answered.has(q.id))
}

/**
 * Datos de la factura que el proveedor quiere adelantar (ADR 0039): se piden por el chat después de
 * recibir el estado de cuenta y antes de analizarlo, para que el veredicto conteste "¿califica
 * esta factura?". "omitir" en el monto analiza sin factura y el resultado es la línea máxima.
 */
export const INVOICE_REPLIES = {
  ask_amount: 'Recibimos tu estado de cuenta. Para decirte si tu factura califica necesito tres datos.\n\n¿De cuánto es la factura que quieres adelantar? Escribe el monto en pesos, por ejemplo: 180000. Si solo quieres saber hasta cuánto te podemos adelantar, escribe omitir.',
  invalid_amount: 'No pude leer el monto. Escríbelo en pesos, solo con números, por ejemplo: 180000 o 180 mil. O escribe omitir.',
  ask_buyer: '¿A qué cadena o empresa le facturaste? Escribe su nombre, por ejemplo: Cadena Comercial del Norte. Si no quieres decirlo, escribe omitir.',
  invalid_buyer: 'No pude leer el nombre. Escríbelo completo o escribe omitir.',
  ask_maturity: '¿Cuándo vence la factura? Escribe la fecha como 20/12/2026. Si no la sabes, escribe omitir.',
  invalid_maturity: 'No pude leer la fecha. Escríbela como día/mes/año, por ejemplo: 20/12/2026, o escribe omitir.',
  past_maturity: 'Esa fecha ya pasó. Escribe el vencimiento de la factura, por ejemplo: 20/12/2026, o escribe omitir.',
  pending_first: 'Antes de recibir otro documento necesito los datos de la factura del estado de cuenta que ya mandaste.',
  analyzing: (summary: string | null) => `Gracias. ${summary ? `Reviso ${summary}.` : 'Reviso hasta cuánto te podemos adelantar.'} Te aviso el resultado por aquí en unos minutos.`,
} as const

const MONTHS: Record<string, number> = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 }

/** "omitir", "no sé", "ninguno"… */
export function isSkip(text: string): boolean {
  return /^(omitir|omite|saltar|no s[eé]|no lo s[eé]|ninguno|ninguna|n\/a|na|-)$/.test(text.trim().toLowerCase())
}

/** Pesos: "180000", "$180,000.50", "180 mil", "1.2 millones", "250k". Entre 1 y 1,000 millones. */
export function parseAmount(text: string): number | null {
  const t = text.toLowerCase().replace(/mxn|pesos|\$/g, '').trim()
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(mil|k|millones|millón|millon|m)?$/.exec(t) ?? /^(\d+)(?:[.,](\d+))?\s*(mil|k|millones|millón|millon|m)$/.exec(t)
  if (!m?.[1]) return null
  const base = Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`)
  const unit = m[3]
  const amount = unit === 'mil' || unit === 'k' ? base * 1_000 : unit ? base * 1_000_000 : base
  if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000_000) return null
  return Math.round(amount * 100) / 100
}

/**
 * Fecha de vencimiento: "20/12/2026", "20-12-26", "2026-12-20" o "20 de diciembre de 2026".
 * `{ past: true }` si es anterior a `today` (AAAA-MM-DD); null si no se entiende o no existe.
 */
export function parseMaturity(text: string, today: string): { date: string } | { past: true } | null {
  const t = text.trim().toLowerCase()
  let y: number, mo: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)
  const named = /^(\d{1,2})\s*(?:de\s+)?([a-zé]+)\.?\s*(?:de(?:l)?\s+)?(\d{4})$/.exec(t)
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (dmy) [d, mo, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3])]
  else if (named?.[2] && MONTHS[named[2].slice(0, 3)]) [d, mo, y] = [Number(named[1]), MONTHS[named[2].slice(0, 3)] ?? 0, Number(named[3])]
  else return null
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  const out = date.toISOString().slice(0, 10)
  return out < today ? { past: true } : { date: out }
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "$149,937.00 pesos": con centavos y la moneda dicha, para que no se confunda con miles ni dólares. */
export function formatPesos(amount: number): string {
  return `${MXN.format(amount)} pesos`
}

/** "tu factura de $180,000 a Cadena Norte con vencimiento el 20/12/2026", o null sin monto. */
export function describeInvoice(req: { amount: number | null; maturity: string | null; buyer: { name: string } | null } | null): string | null {
  if (req?.amount == null) return null
  const [y, m, d] = (req.maturity ?? '').split('-')
  // Solo el monto (lo que pidió después de la oferta, ADR 0053): no es necesariamente una factura.
  if (!req.buyer && !req.maturity) return `tu solicitud de adelanto de ${formatPesos(req.amount)}`
  return `tu factura de ${formatPesos(req.amount)}${req.buyer ? ` a ${req.buyer.name}` : ''}${req.maturity ? ` con vencimiento el ${String(d)}/${String(m)}/${String(y)}` : ''}`
}

/**
 * Después de ofrecer la línea máxima (ADR 0053): el proveedor dice cuánto quiere adelantar y la
 * solicitud se decide de nuevo con ese monto. El brief no pide el monto al recibir el documento.
 */
export const AMOUNT_OFFER = {
  ask: (max: number) => `¿Cuánto quieres adelantar? Escribe el monto en pesos, hasta ${formatPesos(max)}. Si por ahora no quieres, escribe omitir.`,
  invalid: (max: number) => `No pude leer el monto. Escríbelo en pesos, solo con números, por ejemplo: 80000 o 80 mil (hasta ${formatPesos(max)}). O escribe omitir.`,
  over: (max: number) => `Ese monto pasa del máximo que te podemos adelantar, ${formatPesos(max)}. Escribe un monto igual o menor.`,
  reviewing: (amount: number) => `Va, reviso tu solicitud de adelanto de ${formatPesos(amount)}. En un momento te confirmo.`,
  skipped: 'Va. Si más adelante quieres un adelanto, mándanos tu estado de cuenta más reciente por aquí.',
} as const

/**
 * Aviso del veredicto al proveedor (ADR 0039). Plantillas fijas: el resultado y, si califica, el
 * monto. Nunca saldos, RFC, CLABE ni los motivos del motor, que pueden citar cifras del documento.
 */
export function renderVerdict(v: {
  status: 'qualified' | 'qualified_with_limit' | 'not_qualified' | 'human_review' | 'failed'
  limit: number | null
  request: { amount: number | null; maturity: string | null; buyer: { name: string } | null } | null
  tenantName: string
  /** Solo en `failed`: el motivo leído con `describeFailure` (ADR 0041). */
  failure?: Pick<FailureInfo, 'kind' | 'documentType'> | null
  /** Solo en `not_qualified`: las causas en palabras simples (`notQualifiedReasons`, ADR 0048). */
  reasons?: readonly string[]
}): string {
  const invoice = describeInvoice(v.request)
  const limit = v.limit === null ? null : formatPesos(v.limit)
  switch (v.status) {
    case 'qualified':
      return invoice ? `Buenas noticias: ${invoice} califica para adelanto con ${v.tenantName}. Te contactaremos para los siguientes pasos.` : `Buenas noticias: calificas para adelanto con ${v.tenantName}${limit ? ` hasta por ${limit}` : ''}. Te contactaremos para los siguientes pasos.`
    case 'qualified_with_limit':
      // Lo que pidió cabe en la línea: se aprueba completo; "con límite" solo si pidió más (ADR 0053).
      if (invoice && v.request?.amount != null && v.limit !== null && v.request.amount <= v.limit + 0.005) return `Buenas noticias: ${invoice} está aprobada con ${v.tenantName}. Te contactaremos para los siguientes pasos.`
      return invoice ? `Revisamos ${invoice}. Califica con un límite: podemos adelantarte hasta ${limit ?? 'un monto menor al de la factura'}. Te contactaremos para los siguientes pasos.` : `Revisamos tu estado de cuenta. Podemos adelantarte hasta ${limit ?? 'un monto limitado'} con ${v.tenantName}. Te contactaremos para los siguientes pasos.`
    case 'not_qualified': {
      const why = v.reasons?.length ? ` porque ${listEs(v.reasons)}` : ''
      return `Revisamos ${invoice ?? 'tu estado de cuenta'}. Por ahora ${invoice ? 'no califica' : 'no calificas'} para adelanto con ${v.tenantName}${why}. Si tu situación cambia, mándanos un estado de cuenta más reciente.`
    }
    case 'human_review':
      return `Revisamos ${invoice ?? 'tu estado de cuenta'} y un analista de ${v.tenantName} necesita confirmar algunos datos antes de darte una respuesta. Te avisaremos por aquí.`
    case 'failed':
      return failureNotice(v.failure ?? null)
  }
}

function listEs(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`
}

/**
 * Por qué no califica, en palabras simples y sin cifras del documento (ADR 0048): una regla que lo
 * descarta (atrasos) o las dos dimensiones del puntaje que más puntos perdieron. Sin una causa clara,
 * nada: el mensaje dice solo que no califica.
 */
export function notQualifiedReasons(decision: Pick<Decision, 'evaluation'> | null | undefined, max = 2): string[] {
  if (!decision) return []
  const { gates, dimensions } = decision.evaluation
  const gate = gates.find((g) => g.outcome === 'fail' && g.effect === 'not_qualified')
  if (gate) return [GATE_REASON[gate.feature] ?? 'no cumples uno de los requisitos del programa']
  return dimensions
    .filter((d) => d.used && d.value !== null && d.weight > 0 && d.points < d.weight / 2)
    .sort((a, b) => b.weight - b.points - (a.weight - a.points))
    .map((d) => DIMENSION_REASON[d.feature]?.(d.value ?? 0, d.relative_to) ?? null)
    .filter((r): r is string => r !== null)
    .slice(0, max)
}

const GATE_REASON: Partial<Record<string, string>> = {
  existing_exposure_days_past_due: 'tienes pagos atrasados en un adelanto anterior',
}

const DIMENSION_REASON: Partial<Record<string, (value: number, relativeTo: string | null) => string>> = {
  debt_service_monthly: (v) => (v >= 0.8 ? 'tus pagos a créditos se llevan casi todo lo que te entra' : 'tus pagos a créditos son altos para lo que te entra'),
  payment_capacity_pct: (v) => (v < 0 ? 'en el periodo salió más dinero del que entró' : 'te queda poco dinero libre después de tus gastos'),
  operating_income_monthly: (_, rel) => (rel === 'requested_amount' ? 'tus ingresos son bajos para el monto que pides' : 'tus ingresos del mes son bajos'),
  buyer_payments_count: () => 'no vemos pagos de tu cliente en tu cuenta',
  recurring_income_share: () => 'tus ingresos varían mucho de un mes a otro',
  months_of_history: () => 'tu estado de cuenta cubre muy poco tiempo',
}

/**
 * Repreguntas cuando el mensaje no contesta (ADR 0040): no se entendió, o es una consulta que el bot
 * no atiende (docs/05 §2b, "el bot no contesta preguntas"). Siempre van seguidas de la pregunta
 * pendiente.
 */
export const CONVERSATION_FALLBACKS = {
  not_understood: 'No entendí tu respuesta.',
  off_topic: 'Por este chat solo puedo pedirte los datos de tu solicitud. Para otras dudas, contacta a quien te ofreció el adelanto.',
} as const

const ASK_BANK_STATEMENT = 'Para revisar tu solicitud necesitamos el estado de cuenta de tu cuenta de cheques o débito, donde recibes los pagos de tus clientes. Mándalo en PDF por este chat, tal como lo descargaste de tu banco.'

/**
 * Por qué no se pudo revisar, dicho al proveedor (ADR 0041): qué mandó y qué necesitamos, sin datos
 * del documento ni detalles técnicos.
 */
export function failureNotice(failure: Pick<FailureInfo, 'kind' | 'documentType'> | null): string {
  if (failure?.kind === 'not_bank_statement') {
    if (failure.documentType === 'credit_card_statement') return `Lo que mandaste es un estado de cuenta de tarjeta de crédito. ${ASK_BANK_STATEMENT}`
    if (failure.documentType === 'invoice') return `Lo que mandaste parece una factura, no un estado de cuenta. ${ASK_BANK_STATEMENT} Los datos de la factura te los pedimos por aquí.`
    return `Lo que mandaste no parece un estado de cuenta bancario. ${ASK_BANK_STATEMENT}`
  }
  if (failure?.kind === 'password_protected') return DOCUMENT_REPLIES.password_protected
  if (failure?.kind === 'multiple_statements') return 'Tu PDF trae más de un estado de cuenta. Mándanos cada estado de cuenta en un PDF aparte, tal como lo descargaste de tu banco.'
  if (failure?.kind === 'scanned_unreadable') return 'No pude leer tu estado de cuenta: parece escaneado o una foto. Descárgalo en PDF desde el portal o la app de tu banco.'
  if (failure?.kind === 'extraction_failed') return 'No pudimos leer tu estado de cuenta. Mándalo de nuevo como PDF descargado directamente de tu banco (no foto ni escaneo).'
  return 'No pudimos terminar de revisar tu estado de cuenta por un problema de nuestro lado. Ya lo estamos viendo; si quieres, vuelve a mandarlo en unos minutos.'
}

/*
 * Resumen, confirmación y varias respuestas en un mensaje (ADR 0051). Todo es genérico sobre
 * `Question.kind` y `options`: cada respuesta se sigue leyendo con `parseReply` contra su pregunta.
 */

/** Índices de las preguntas que se hacen por el chat, en el orden en que se hacen. */
export function conversationalIndexes(questions: readonly Question[]): number[] {
  return questions.flatMap((q, i) => (isConversational(q) ? [i] : []))
}

/** La pregunta en `index` con su "Pregunta N de M", contando solo las que se hacen por el chat. */
export function renderQuestionAt(questions: readonly Question[], index: number): string {
  const convo = conversationalIndexes(questions)
  return renderQuestion(questions[index] as Question, convo.indexOf(index) + 1, convo.length)
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** "2026-09-15" → "15 de septiembre". */
function dayOf(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const month = m ? MONTH_NAMES[Number(m[2]) - 1] : undefined
  return m && month ? `${String(Number(m[3]))} de ${month}` : null
}

/**
 * De qué trata la pregunta en pocas palabras: "abono de $150,000 del 15 de septiembre" si cita un
 * movimiento; si no, su primera oración. Solo cifras de los hechos de la pregunta (docs/04 §4).
 */
export function questionSubject(q: Question): string {
  const fact = (name: string) => q.facts.find((f) => f.name === name)?.value ?? null
  const amount = fact('monto')
  const date = fact('fecha')
  if (typeof amount === 'number') {
    const day = typeof date === 'string' ? dayOf(date) : null
    return `${q.kind === 'deposit' ? 'abono' : q.kind === 'charge' ? 'cargo' : 'movimiento'} de ${formatPesos(amount)}${day ? ` del ${day}` : ''}`
  }
  const first = q.text.split(/(?<=[.?!])\s/)[0] ?? q.text
  return first.length > 90 ? `${first.slice(0, 87)}...` : first
}

/** Lo que contestó, en palabras: la etiqueta de la opción elegida, el texto libre o "No lo sé". */
export function answerLabel(q: Question, a: OwnerAnswer | undefined): string {
  if (!a) return 'sin respuesta'
  if (a.kind === 'decline') return 'No lo sé'
  const values: unknown[] = Object.entries(a)
    .filter(([k]) => k !== 'question_id' && k !== 'kind')
    .map(([, v]) => v)
  const option = q.options.find((o) => values.includes(o.value))
  if (option) return option.label
  const text = values.find((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return text ?? 'respondida'
}

/** "Esto es lo que entendí: 1) …: …" con las respuestas de las preguntas que se hicieron por el chat. */
export function renderSummary(questions: readonly Question[], answers: readonly OwnerAnswer[]): string {
  const lines = conversationalIndexes(questions).map((i, n) => {
    const q = questions[i] as Question
    return `${String(n + 1)}) ${questionSubject(q)}: ${answerLabel(q, answers.find((a) => a.question_id === q.id))}`
  })
  return `Esto es lo que entendí:\n${lines.join('\n')}\n\n¿Es correcto? Responde sí para enviarlo a evaluación, o el número de la respuesta que quieres cambiar.`
}

export const CONFIRMATION_REPLIES = {
  which: '¿Qué respuesta quieres cambiar? Responde con su número.',
  changed: (n: number) => `Listo, cambié la respuesta ${String(n)}.`,
  no_such: (n: number, total: number) => `No hay una respuesta ${String(n)}: ${total === 1 ? 'solo hay una' : `son ${String(total)}`}.`,
  sent: 'Gracias. Envié tus respuestas a evaluación; en unos minutos te aviso el resultado por aquí.',
  sent_analyst: `Gracias, quedaron guardadas tus respuestas. ${ANALYST_NOTICE}`,
  too_many: (given: number, pending: number) => `Recibí ${String(given)} respuestas, pero ${pending === 1 ? 'solo queda una pregunta' : `quedan ${String(pending)} preguntas`}.`,
} as const

const ORDINALS: readonly (readonly [RegExp, number])[] = [
  [/^primer[oa]?$/, 1],
  [/^segund[oa]$/, 2],
  [/^tercer[oa]?$/, 3],
  [/^cuart[oa]$/, 4],
  [/^quint[oa]$/, 5],
  [/^sext[oa]$/, 6],
  [/^(?:septim|setim)[oa]$/, 7],
  [/^octav[oa]$/, 8],
  [/^noven[oa]$/, 9],
  [/^decim[oa]$/, 10],
]
const ORDINAL_WORD = /\b(?:(?:el|la) )?(primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|septim[oa]|setim[oa]|octav[oa]|noven[oa]|decim[oa])\b/g

function ordinalOf(word: string): number {
  return ORDINALS.find(([re]) => re.test(word))?.[1] ?? 0
}

/** Lo que va antes de la respuesta en "el 2 era préstamo" o "el primero es cliente". */
const LEAD = /^(?:(?:es|era|eran|fue|son|seria|en realidad|realmente|debe ser|deberia ser|mas bien|cambialo a|cambiala a|cambiar a|a|por|y|que|la|el|lo)\s+)*/

function stripLead(t: string): string {
  return t.trim().replace(LEAD, '').trim()
}

/** Lo que trae un mensaje con varias respuestas, o null si no es de esa forma. */
export type MultiReply = { kind: 'answers'; answers: OwnerAnswer[] } | { kind: 'too_many'; given: number; pending: number } | { kind: 'invalid' }

/**
 * Varias respuestas en un mensaje para las preguntas pendientes (`pending`, la actual primero):
 * "1, 3, 1", "1 3 1", "el primero es cliente y el segundo préstamo" o "cliente, préstamo". Solo para
 * preguntas con opciones; cada parte se lee con `parseReply` contra su pregunta. Null si el mensaje
 * no tiene esa forma (se lee como una sola respuesta); `invalid` si la tiene y algo no se entiende.
 */
export function parseMultipleReplies(text: string, pending: readonly Question[]): MultiReply | null {
  const closed: Question[] = []
  for (const q of pending) {
    if (q.options.length === 0) break
    closed.push(q)
  }
  if (closed.length === 0) return null
  const t = normalize(text)

  // Solo números: "1, 3, 1", "1 3 1", "1 y 3".
  if (/^\d{1,2}(?: (?:y )?\d{1,2})+$/.test(t)) {
    const nums = t.split(' ').filter((x) => x !== 'y')
    if (nums.length > pending.length) return { kind: 'too_many', given: nums.length, pending: pending.length }
    if (nums.length > closed.length) return { kind: 'invalid' }
    const answers = nums.map((n, i) => parseReply(n, closed[i] as Question))
    return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : { kind: 'invalid' }
  }

  // Ordinales: "el primero es cliente y el segundo préstamo" (el primero es la pregunta actual).
  const marks = [...t.matchAll(ORDINAL_WORD)]
  if (marks.length >= 2) {
    const read: { ord: number; answer: OwnerAnswer }[] = []
    for (const [k, m] of marks.entries()) {
      const ord = ordinalOf(m[1] ?? '')
      const q = closed[ord - 1]
      const end = marks[k + 1]?.index ?? t.length
      const answer = q ? parseReply(stripLead(t.slice(m.index + m[0].length, end).trim().replace(/\s*\by$/, '')), q) : null
      if (!answer || read.some((r) => r.ord === ord)) return { kind: 'invalid' }
      read.push({ ord, answer })
    }
    return { kind: 'answers', answers: read.sort((a, b) => a.ord - b.ord).map((r) => r.answer) }
  }

  // Partes cortas separadas: "cliente, préstamo", una por renglón o "cliente y préstamo". Si alguna
  // no se lee, el mensaje se toma como una sola respuesta ("pago de cliente, de Cadena Norte").
  const parts = text
    .split(/[\n;,]+|\s+y\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length < 2 || parts.length > closed.length || parts.some((p) => normalize(p).split(' ').length > 6)) return null
  const answers = parts.map((p, i) => parseReply(p, closed[i] as Question))
  return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : null
}

/** Lo que contestó al resumen. `number` es el de la lista del resumen (desde 1). */
export type ConfirmationRead = { kind: 'confirm' } | { kind: 'reject' } | { kind: 'change'; number: number } | { kind: 'correct'; number: number; answer: OwnerAnswer }

/**
 * Lee la respuesta al resumen: "sí" confirma; un número pide cambiar esa respuesta; "el 2 era
 * préstamo" o "me equivoqué en la segunda, es un traspaso" la corrige (se lee con `parseReply` contra
 * esa pregunta); "no" pregunta cuál cambiar. Null si no se entiende.
 */
export function parseConfirmation(text: string, questions: readonly Question[]): ConfirmationRead | null {
  const t = normalize(text)
  if (!t) return null
  const convo = conversationalIndexes(questions).map((i) => questions[i] as Question)
  const bare = /^(?:(?:la|el|numero|pregunta|respuesta|cambiar|cambia|cambio|quiero cambiar)\s+)*(\d{1,2})$/.exec(t)
  if (bare) return { kind: 'change', number: Number(bare[1]) }

  const byNumber = /(?:^|\b(?:la|el|numero|pregunta|respuesta)\s+)(\d{1,2})\b/.exec(t)
  const byOrdinal = byNumber ? null : [...t.matchAll(ORDINAL_WORD)][0]
  const ref = byNumber ? { number: Number(byNumber[1]), index: byNumber.index, length: byNumber[0].length } : byOrdinal ? { number: ordinalOf(byOrdinal[1] ?? ''), index: byOrdinal.index, length: byOrdinal[0].length } : null
  if (ref && ref.number > 0) {
    const q = convo[ref.number - 1]
    if (!q) return { kind: 'change', number: ref.number }
    const after = stripLead(t.slice(ref.index + ref.length))
    const before = stripLead(t.slice(0, ref.index).trim().replace(/\s*\b(?:era|es|fue)$/, ''))
    const answer = (after ? parseReply(after, q) : null) ?? (before ? parseReply(before, q) : null)
    return answer ? { kind: 'correct', number: ref.number, answer } : { kind: 'change', number: ref.number }
  }

  if (parseYesNo(text) === true) return { kind: 'confirm' }
  if (/^(si|correcto|todo (esta )?bien|esta bien|perfecto|ok|okay|de acuerdo|asi es|exacto|listo|adelante|envialo|enviar)\b/.test(t) && !/\b(no|pero|cambi\w*)\b/.test(t)) return { kind: 'confirm' }
  if (parseYesNo(text) === false || /^(no|incorrecto)\b/.test(t)) return { kind: 'reject' }
  return null
}
