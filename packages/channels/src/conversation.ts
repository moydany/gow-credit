/**
 * WhatsApp / email conversation: one question at a time, numbered options, and the reply is read
 * against the question being waited on. Deposits, charges, the main client (free text) and account
 * use are asked here; identity and new documents need a second-factor channel (one-time link or
 * backoffice), so they go through the API. Exceptions: a statement PDF from a verified WhatsApp
 * link (opens a request) and that same PDF when requested in full for missing pages (answers the
 * question, see `isDocumentRequest`).
 *
 * A reply is read as an option number, an option name or keywords. If two categories match, or
 * none, we do not guess: the question is asked again with numbered options. Text never authorizes
 * anything; it is only compared against the open question for that number.
 */
import type { AccountUse, ChargeAnswerCategory, Decision, DepositAnswerCategory, DiscardReason, FailureInfo, OwnerAnswer, Question } from '@gow/contracts'

export const GENERIC_NO_PENDING = 'Hola. No tenemos una solicitud pendiente de aclarar para este número. Si crees que es un error, contacta a quien te pidió la información.'

/**
 * Fixed replies to a document received over WhatsApp. They say nothing about the content or the
 * result: the verdict is only available through the API or backoffice, never this channel.
 */
export const DOCUMENT_REPLIES = {
  received: 'Recibimos tu estado de cuenta. Lo estoy revisando y en unos minutos te digo hasta cuánto te podemos adelantar.',
  duplicate: 'Ya habíamos recibido este estado de cuenta y sigue en revisión. No hace falta mandarlo de nuevo.',
  rejected: 'No pudimos recibir el documento. Mándalo de nuevo como archivo PDF de hasta 40 MB, tal como lo descargaste de tu banco.',
  /** Password-protected PDF: answered right away, no request is opened. */
  password_protected: 'Tu PDF tiene contraseña y no lo puedo abrir. Descárgalo de nuevo desde tu banco sin contraseña (o quítasela) y mándamelo por aquí.',
  ambiguous: 'Este número está registrado con más de una empresa, así que no sabemos a cuál corresponde el documento. Pide a quien te contactó que lo suba por su sistema.',
  no_link: 'Hola. Este número no está registrado para recibir documentos. Si crees que es un error, contacta a quien te pidió la información.',
  /** The PDF answers the missing-pages question (`isDocumentRequest`): the request continues with it. */
  answer_received: 'Recibimos tu estado de cuenta completo. Lo estoy revisando y en unos minutos te aviso el resultado por aquí.',
  /** Same, but the clarification still has questions only an analyst can answer. */
  answer_for_review: 'Recibimos tu estado de cuenta completo. Un analista revisará tu solicitud y te avisaremos el resultado por este chat.',
  /** Same file sent again, still missing pages. */
  answer_same_file: 'Este es el mismo archivo que ya recibimos y le faltan páginas. Descarga el estado de cuenta completo desde tu banco y mándalo por aquí.',
  /** Text sent while the PDF is expected. */
  send_pdf: 'Para continuar necesito el PDF completo de tu estado de cuenta. Mándalo por este chat, tal como lo descargaste de tu banco.',
  /** The PDF answers the statement-with-address question: the request continues with it. */
  address_received: 'Recibimos tu estado de cuenta. Lo estoy revisando y en unos minutos te aviso el resultado por aquí.',
  address_for_review: 'Recibimos tu estado de cuenta. Un analista revisará tu solicitud y te avisaremos el resultado por este chat.',
  /** Same file sent again, still without the address. */
  address_same_file: 'Este es el mismo archivo que ya recibimos y no trae tu domicilio. Descarga un estado de cuenta que sí lo traiga y mándalo por aquí.',
  /**
   * The tenant's policy evaluates three months (ADR 0072): added wherever the statement is asked
   * for. WhatsApp has no message with several files: the PDFs picked together arrive one after the
   * other and are joined into one request.
   */
  three_months: 'Para esta evaluación necesito tus estados de cuenta de los 3 meses más recientes, de meses seguidos. Selecciona los 3 PDF y mándalos juntos, en un solo envío. También sirve un solo PDF que traiga los 3 meses.',
  /** Another PDF of the same send: it joins the request opened by the first one. */
  batch_joined: 'Recibí otro estado de cuenta y lo reviso junto con los que ya mandaste.',
  /** The missing months arrived (`additional_months`): the other PDFs of the same send join them. */
  months_received: 'Recibimos tus estados de cuenta. Los reviso junto con los que ya teníamos y en unos minutos te aviso el resultado por aquí.',
  months_for_review: 'Recibimos tus estados de cuenta. Un analista revisará tu solicitud y te avisaremos el resultado por este chat.',
  months_same_file: 'Este estado de cuenta ya lo teníamos. Necesito los de los meses que faltan, seguidos: mándalos juntos, en un solo envío.',
  months_send_pdf: 'Para continuar necesito los estados de cuenta de los meses que faltan, de meses seguidos. Selecciona los PDF y mándalos juntos por este chat, en un solo envío.',
  /** Text sent while the PDF with address is expected. */
  address_send_pdf: 'Para continuar necesito un estado de cuenta en PDF que traiga tu domicilio. Mándalo por este chat, tal como lo descargaste de tu banco.',
} as const

/** `DOCUMENT_REPLIES` for the PDF that was requested: the complete one or one with an address. */
export function documentRequestReplies(q: Question): { received: string; forReview: string; sameFile: string; sendPdf: string } {
  const r = DOCUMENT_REPLIES
  if (q.topic === 'additional_months') return { received: r.months_received, forReview: r.months_for_review, sameFile: r.months_same_file, sendPdf: r.months_send_pdf }
  return q.topic === 'statement_with_address'
    ? { received: r.address_received, forReview: r.address_for_review, sameFile: r.address_same_file, sendPdf: r.address_send_pdf }
    : { received: r.answer_received, forReview: r.answer_for_review, sameFile: r.answer_same_file, sendPdf: r.send_pdf }
}

/**
 * The case is left to an analyst: the clarification only has questions that are not asked over
 * chat, rounds ran out, or identity could not be confirmed. The supplier always gets a reply.
 */
export const ANALYST_NOTICE = 'Un analista revisará tu estado de cuenta y te avisaremos el resultado por este chat.'

/** Reply to a photo, voice note, video or sticker: only the PDF is read. */
export const MEDIA_UNSUPPORTED = 'Solo puedo leer el estado de cuenta en PDF, tal como lo descargas de tu banco.'

const ASK_STATEMENT = 'Mándame por este chat tu estado de cuenta bancario más reciente en PDF, tal como lo descargaste de tu banco.'
const ASK_CONTACT_NAME = 'Para empezar, ¿cómo te llamas?'
const ASK_AMOUNT = '¿Cuánto quieres adelantar? Escribe el monto en pesos, por ejemplo: 150000 o 150 mil. Si todavía no lo sabes, escribe omitir y te digo hasta cuánto te podemos adelantar.'
const YES_NO = 'Responde sí o no.'

/** Why the RFC is asked: no homoclave, incomplete, or the supplier corrected the data. */
export type RfcAskReason = { kind: 'root'; root: string } | { kind: 'missing' } | { kind: 'corrected' }

/**
 * First-time supplier registration (demo only, `WHATSAPP_SELF_REGISTRATION`). On greeting, the
 * contact's name and the amount they want; then the statement. Once read, the holder and RFC found
 * are shown to the sender to confirm or correct, then anything missing is asked. The result goes
 * out when registration finishes.
 */
export const REGISTRATION_REPLIES = {
  /** `received`: a PDF came with the first message and waits for the name and amount. */
  welcome: (tenantName: string, received = false, note: string | null = null) =>
    `Hola, te escribe el asistente de ${tenantName}. ${received ? 'Ya recibí tu estado de cuenta; antes de revisarlo necesito dos datos.' : 'Reviso tu estado de cuenta para decirte cuánto te podemos adelantar del pago de tus facturas. Antes necesito dos datos.'}\n\n${note ? `${note}\n\n` : ''}${ASK_CONTACT_NAME}`,
  ask_contact_name: ASK_CONTACT_NAME,
  invalid_contact_name: 'No pude leer tu nombre. Escríbelo, por ejemplo: Ana López.',
  ask_amount: (contactName: string | null) => (contactName ? `Mucho gusto, ${contactName}. ${ASK_AMOUNT}` : ASK_AMOUNT),
  invalid_amount: 'No pude leer el monto. Escríbelo en pesos, solo con números, por ejemplo: 150000 o 150 mil. O escribe omitir.',
  /** Asked once the name and amount are in, with or without an amount. */
  ask_statement_for: (amount: number | null) =>
    `${amount === null ? 'Va, entonces te digo hasta cuánto te podemos adelantar.' : `Perfecto, reviso tu solicitud de adelanto de ${formatPesos(amount)}.`} Ahora ${ASK_STATEMENT.charAt(0).toLowerCase()}${ASK_STATEMENT.slice(1)}`,
  ask_statement: ASK_STATEMENT,
  /** A PDF while the name or amount is awaited: it is kept and read once both are given. */
  statement_kept: 'Ya tengo tu estado de cuenta; lo reviso en cuanto me des este dato.',
  reading: 'Recibí tu estado de cuenta y lo estoy leyendo. En un momento te pido que confirmes tus datos.',
  still_reading: 'Sigo leyendo tu estado de cuenta. En un momento te pido que confirmes tus datos; no hace falta mandarlo de nuevo.',
  /** The holder as read, with or without a full RFC. An RFC without homoclave is asked separately later. */
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
  /** A PDF or text while a registration field is awaited. */
  pending_first: 'Antes de recibir otro documento necesito que terminemos con tus datos.',
  thanks: (name: string) => `Gracias, quedaron registrados los datos de ${name}.`,
  finishing: 'Estoy terminando la revisión; en un momento te mando el resultado.',
  analyst: ANALYST_NOTICE,
  idle: (legalName: string, contactName: string | null = null) => `Hola${contactName ? `, ${contactName}` : ''}. Ya tienes registrada a ${legalName}. Si quieres que revisemos un estado de cuenta, mándalo en PDF por este chat.`,
} as const

/** "sí" / "no" and common variants; anything else is null. */
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

/**
 * A person's name as they write it ("Ana", "me llamo Ana López", "soy Ana"): without the lead-in,
 * 2 to 80 chars, letters only. A greeting, a yes/no or "omitir" is not a name.
 */
export function parseContactName(text: string): string | null {
  const name = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)[,.!\s]+/i, '')
    .replace(/^(me llamo|mi nombre es|soy|habla|le habla|te habla)\s+/i, '')
    .replace(/[.!,;]+$/, '')
    .trim()
  if (name.length < 2 || name.length > 80 || !/^[\p{L}][\p{L}\p{M}' .-]*$/u.test(name)) return null
  const plain = name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|que tal|hey|hi|hello|si|no|ok|okay|gracias|omitir|ayuda|info|informacion)$/.test(plain)) return null
  return name
}

/** Persona moral (12 chars) or física (13), by RFC length. */
export function personTypeOf(rfc: string): 'moral' | 'fisica' {
  return rfc.length === 12 ? 'moral' : 'fisica'
}

/** Readable legal name: normalized spaces, 3 to 200 chars, at least one letter. */
export function parseLegalName(text: string): string | null {
  const name = text.replace(/\s+/g, ' ').trim()
  return name.length >= 3 && name.length <= 200 && /\p{L}/u.test(name) ? name : null
}

/** RFC of a persona moral (12) or física (13), uppercase, no spaces or hyphens. */
export function parseRfc(text: string): string | null {
  const rfc = text.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(rfc) ? rfc : null
}

/** Questions asked over a conversational channel. */
export function isConversational(q: Question): boolean {
  return q.kind === 'deposit' || q.kind === 'charge' || q.kind === 'buyer' || q.kind === 'account_use'
}

/**
 * Document question the supplier answers by sending the new PDF in the same chat: missing pages
 * and statement with address. Other document questions go through the API or backoffice. Not
 * conversational: text does not answer it, the PDF does.
 */
export function isDocumentRequest(q: Question): boolean {
  return q.kind === 'documents' && (q.topic === 'missing_pages' || q.topic === 'statement_with_address' || q.topic === 'additional_months')
}

/** The `isDocumentRequest` question as sent over chat: the text and how to answer it. */
export function renderDocumentRequest(q: Question): string {
  // The missing months (ADR 0072): several PDFs, picked together and sent at once.
  if (q.topic === 'additional_months' && q.facts.find((f) => f.name === 'meses_faltantes')?.value !== 1) return `${q.text}\n\nSelecciona los PDF y mándalos juntos por este chat, en un solo envío, tal como los descargaste de tu banco.`
  return `${q.text}\n\nMándalo por este chat como PDF, tal como lo descargaste de tu banco.`
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

/** Charges. "Pago de mi tarjeta personal" matches two categories: ask again. */
const CHARGE_KEYWORDS: readonly (readonly [ChargeAnswerCategory | 'decline', RegExp])[] = [
  ['decline', DECLINE],
  ['own_transfer', /\btraspaso\b|\b(a |de )?(mi|mis) (otra )?cuentas?\b|\bcuenta (mia|propia)\b|\bentre (mis )?cuentas\b|\bme (lo )?(pase|mande|transferi)\b/],
  ['loan_payment', /\bprestamo\b|\bcredito\b|\bfinanciera\b|\bmensualidad\b|\btarjeta\b|\bhipoteca\b|\barrendamiento\b/],
  ['supplier_payment', /\bproveedor(es)?\b|\bmercancia\b|\binsumos?\b|\bmateriales?\b|\bdel negocio\b|\bde la empresa\b|\brenta del (local|negocio)\b/],
  ['personal_expense', /\bpersonal(es)?\b|\bde la casa\b|\bfamilia(r)?\b|\bgasto mio\b/],
  ['other', /\botra cosa\b|\botro\b/],
]

/** Account use. "Solo negocio, nada personal" matches both: ask again. */
const ACCOUNT_USE_KEYWORDS: readonly (readonly [AccountUse | 'decline', RegExp])[] = [
  ['decline', DECLINE],
  ['business_only', /\bsolo (para |de |es )?(el |mi |la )?(negocio|empresa|trabajo)\b|\bsolo negocio\b|\bexclusiva(mente)?\b|\bnada mas (para |de )?(el |mi )?negocio\b/],
  ['mixed', /\bpersonal(es)?\b|\btambien\b|\bambos\b|\bambas\b|\blas dos\b|\bmixt[ao]\b|\bde todo\b/],
]

/** Replies that give no client name: treated as "don't know". */
const NO_BUYER = /^(no (lo )?(se|recuerdo|tengo|hay|estoy segur[oa])|ni idea|omitir|omite|ninguno|ninguna|nadie|varios|muchos|no tengo (uno|cliente principal)|n a|na)$/
/** Greetings, courtesies and yes/no are not a name: ask again. */
const NOT_A_NAME = /^(hola|buen(os|as)|que tal|hey|gracias|ok|okay|si|no|sale|va|listo|claro|perdon|disculpa)\b/
/** What is stripped from "mi cliente es X" or "se llama X" before reading the name. */
const BUYER_PREFIX = /^\s*(?:(?:mi )?(?:cliente(?: principal)?|comprador)\s+(?:es|se llama)\s+|(?:es|se llama|son)\s+)/i

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The chosen option: number, option name or keywords (one category only). "decline" is "no sé";
 * null when it cannot be read without guessing.
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
  // "pago de cliente" and "otro" can both match in a long phrase: the specific one wins.
  const specific = hits.filter((c) => c !== 'other')
  const chosen = specific.length > 0 ? specific : hits
  return chosen.length === 1 ? (chosen[0] ?? null) : null
}

/**
 * Main client name as free text: "mi cliente es" is stripped; valid if `parseLegalName` accepts
 * it, it is not a question and it is at most 120 chars.
 */
function readBuyerName(text: string): { name: string } | 'decline' | null {
  const t = normalize(text)
  if (NO_BUYER.test(t) || isSkip(text)) return 'decline'
  if (DECLINE.test(t) && t.split(' ').length <= 6) return 'decline'
  if (/[?¿]/.test(text) || /^\d+$/.test(t) || NOT_A_NAME.test(t)) return null
  const name = parseLegalName(text.replace(BUYER_PREFIX, '').replace(/[.!¡]+$/u, ''))
  return name !== null && name.length <= 120 ? { name } : null
}

/** The reply to a conversational question, or null if it cannot be read without guessing. */
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

/** Index of the next conversational question from `from` (inclusive), or -1. */
export function nextConversational(questions: readonly Question[], from: number): number {
  for (let i = Math.max(0, from); i < questions.length; i++) if (questions[i] && isConversational(questions[i] as Question)) return i
  return -1
}

/** Every question has an answer (including "no sé"): the clarification can resume. */
export function isComplete(questions: readonly Question[], answers: readonly OwnerAnswer[]): boolean {
  const answered = new Set(answers.map((a) => a.question_id))
  return questions.every((q) => answered.has(q.id))
}

/**
 * Invoice the supplier wants to advance: asked over chat after the statement arrives and before
 * it is analyzed, so the verdict answers "does this invoice qualify?". "omitir" for the amount
 * analyzes without an invoice and the result is the maximum line.
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

/** "omitir", "no sé", "ninguno"... */
export function isSkip(text: string): boolean {
  return /^(omitir|omite|saltar|no s[eé]|no lo s[eé]|ninguno|ninguna|n\/a|na|-)$/.test(text.trim().toLowerCase())
}

/** Pesos: "180000", "$180,000.50", "180 mil", "1.2 millones", "250k". Between 1 and 1,000 million. */
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
 * Due date: "20/12/2026", "20-12-26", "2026-12-20" or "20 de diciembre de 2026".
 * `{ past: true }` if before `today` (YYYY-MM-DD); null if not understood or not a real date.
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

/** "$149,937.00 pesos": cents and currency spelled out so it is not mistaken for thousands or dollars. */
export function formatPesos(amount: number): string {
  return `${MXN.format(amount)} pesos`
}

/** "tu factura de $180,000 a Cadena Norte con vencimiento el 20/12/2026", or null without an amount. */
export function describeInvoice(req: { amount: number | null; maturity: string | null; buyer: { name: string } | null } | null): string | null {
  if (req?.amount == null) return null
  const [y, m, d] = (req.maturity ?? '').split('-')
  // Amount only (what they sent after the offer): not necessarily an invoice.
  if (!req.buyer && !req.maturity) return `tu solicitud de adelanto de ${formatPesos(req.amount)}`
  return `tu factura de ${formatPesos(req.amount)}${req.buyer ? ` a ${req.buyer.name}` : ''}${req.maturity ? ` con vencimiento el ${String(d)}/${String(m)}/${String(y)}` : ''}`
}

/**
 * After the maximum line is offered: the supplier says how much to advance and the request is
 * decided again with that amount.
 */
export const AMOUNT_OFFER = {
  ask: (max: number) => `¿Cuánto quieres adelantar? Escribe el monto en pesos, hasta ${formatPesos(max)}. Si por ahora no quieres, escribe omitir.`,
  invalid: (max: number) => `No pude leer el monto. Escríbelo en pesos, solo con números, por ejemplo: 80000 o 80 mil (hasta ${formatPesos(max)}). O escribe omitir.`,
  over: (max: number) => `Ese monto pasa del máximo que te podemos adelantar, ${formatPesos(max)}. Escribe un monto igual o menor.`,
  reviewing: (amount: number) => `Va, reviso tu solicitud de adelanto de ${formatPesos(amount)}. En un momento te confirmo.`,
  skipped: 'Va. Si más adelante quieres un adelanto, mándanos tu estado de cuenta más reciente por aquí.',
} as const

/**
 * Verdict notice to the supplier. Fixed templates: the result and, if it qualifies, the amount.
 * Never balances, RFC, CLABE or engine reasons, which can quote figures from the document.
 */
export function renderVerdict(v: {
  status: 'qualified' | 'qualified_with_limit' | 'not_qualified' | 'human_review' | 'failed'
  limit: number | null
  request: { amount: number | null; maturity: string | null; buyer: { name: string } | null } | null
  tenantName: string
  /** Only on `failed`: the reason read with `describeFailure`. */
  failure?: Pick<FailureInfo, 'kind' | 'documentType'> | null
  /** Only on `not_qualified`: the causes in plain words (`notQualifiedReasons`). */
  reasons?: readonly string[]
}): string {
  const invoice = describeInvoice(v.request)
  const limit = v.limit === null ? null : formatPesos(v.limit)
  switch (v.status) {
    case 'qualified':
      return invoice ? `Buenas noticias: ${invoice} califica para adelanto con ${v.tenantName}. Te contactaremos para los siguientes pasos.` : `Buenas noticias: calificas para adelanto con ${v.tenantName}${limit ? ` hasta por ${limit}` : ''}. Te contactaremos para los siguientes pasos.`
    case 'qualified_with_limit':
      // The request fits under the line: approved in full; "con límite" only if they asked for more.
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

/** Why the analyst discarded the document, in words for the supplier. Never accuses: `altered` only says it could not be validated. */
const DISCARD_NOTICE_REASON: Record<DiscardReason, string> = {
  wrong_document: 'el documento que mandaste no es un estado de cuenta bancario a tu nombre',
  illegible: 'no pudimos leer el documento que mandaste',
  altered: 'no pudimos validar el documento que mandaste',
  incomplete: 'al documento que mandaste le faltan páginas o periodos',
}

/**
 * Notice when an analyst discards the document in human review: the request closes without a
 * score, so it says why in a closed phrase (no figures, no free text) and asks for another PDF.
 */
export function renderDiscardNotice(v: { reason: DiscardReason; request: { amount: number | null; maturity: string | null; buyer: { name: string } | null } | null; tenantName: string }): string {
  const invoice = describeInvoice(v.request)
  return `Revisamos ${invoice ?? 'tu estado de cuenta'}. Por ahora ${invoice ? 'no califica' : 'no calificas'} para adelanto con ${v.tenantName} porque ${DISCARD_NOTICE_REASON[v.reason]}. Si quieres volver a intentarlo, mándanos el estado de cuenta en PDF por este chat, tal como lo descargaste de tu banco.`
}

function listEs(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`
}

/**
 * Why it does not qualify, in plain words and without document figures: a rule that rules it out
 * (arrears) or the two score dimensions that lost the most points. With no clear cause, nothing:
 * the message just says it does not qualify.
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
 * Follow-ups when the message does not answer: not understood, or a query the bot does not
 * handle. Always followed by the pending question.
 */
export const CONVERSATION_FALLBACKS = {
  not_understood: 'No entendí tu respuesta.',
  off_topic: 'Por este chat solo puedo pedirte los datos de tu solicitud. Para otras dudas, contacta a quien te ofreció el adelanto.',
} as const

const ASK_BANK_STATEMENT = 'Para revisar tu solicitud necesitamos el estado de cuenta de tu cuenta de cheques o débito, donde recibes los pagos de tus clientes. Mándalo en PDF por este chat, tal como lo descargaste de tu banco.'

/**
 * Why the document could not be reviewed, told to the supplier: what they sent and what we need,
 * with no document data or technical detail.
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
 * Summary, confirmation and several answers in one message. Everything is generic over
 * `Question.kind` and `options`: each answer is still read with `parseReply` against its question.
 */

/** Indexes of the chat questions, in the order they are asked. */
export function conversationalIndexes(questions: readonly Question[]): number[] {
  return questions.flatMap((q, i) => (isConversational(q) ? [i] : []))
}

/** The question at `index` with its "Pregunta N de M", counting only chat questions. */
export function renderQuestionAt(questions: readonly Question[], index: number): string {
  const convo = conversationalIndexes(questions)
  return renderQuestion(questions[index] as Question, convo.indexOf(index) + 1, convo.length)
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** "2026-09-15" -> "15 de septiembre". */
function dayOf(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const month = m ? MONTH_NAMES[Number(m[2]) - 1] : undefined
  return m && month ? `${String(Number(m[3]))} de ${month}` : null
}

/**
 * What the question is about in a few words: "abono de $150,000 del 15 de septiembre" if it cites
 * a movement, otherwise its first sentence. Only figures from the question's own facts.
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

/** What they answered, in words: the chosen option label, the free text or "No lo sé". */
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

/** "Esto es lo que entendí: 1) ...: ..." with the answers to the chat questions. */
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

/** What precedes the answer in "el 2 era préstamo" or "el primero es cliente". */
const LEAD = /^(?:(?:es|era|eran|fue|son|seria|en realidad|realmente|debe ser|deberia ser|mas bien|cambialo a|cambiala a|cambiar a|a|por|y|que|la|el|lo)\s+)*/

function stripLead(t: string): string {
  return t.trim().replace(LEAD, '').trim()
}

/** What a multi-answer message carries, or null if it is not shaped like one. */
export type MultiReply = { kind: 'answers'; answers: OwnerAnswer[] } | { kind: 'too_many'; given: number; pending: number } | { kind: 'invalid' }

/**
 * Several answers in one message for the pending questions (`pending`, current first): "1, 3, 1",
 * "1 3 1", "el primero es cliente y el segundo préstamo" or "cliente, préstamo". Only for
 * questions with options; each part is read with `parseReply` against its question. Null if the
 * message is not shaped like that (read as a single answer); `invalid` if it is but something is
 * not understood.
 */
export function parseMultipleReplies(text: string, pending: readonly Question[]): MultiReply | null {
  const closed: Question[] = []
  for (const q of pending) {
    if (q.options.length === 0) break
    closed.push(q)
  }
  if (closed.length === 0) return null
  const t = normalize(text)

  // Numbers only: "1, 3, 1", "1 3 1", "1 y 3".
  if (/^\d{1,2}(?: (?:y )?\d{1,2})+$/.test(t)) {
    const nums = t.split(' ').filter((x) => x !== 'y')
    if (nums.length > pending.length) return { kind: 'too_many', given: nums.length, pending: pending.length }
    if (nums.length > closed.length) return { kind: 'invalid' }
    const answers = nums.map((n, i) => parseReply(n, closed[i] as Question))
    return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : { kind: 'invalid' }
  }

  // Ordinals: "el primero es cliente y el segundo préstamo" (the first is the current question).
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

  // Short separate parts: "cliente, préstamo", one per line or "cliente y préstamo". If any part
  // is unreadable, the message is taken as a single answer ("pago de cliente, de Cadena Norte").
  const parts = text
    .split(/[\n;,]+|\s+y\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length < 2 || parts.length > closed.length || parts.some((p) => normalize(p).split(' ').length > 6)) return null
  const answers = parts.map((p, i) => parseReply(p, closed[i] as Question))
  return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : null
}

/** What they answered to the summary. `number` is the summary list's number (from 1). */
export type ConfirmationRead = { kind: 'confirm' } | { kind: 'reject' } | { kind: 'change'; number: number } | { kind: 'correct'; number: number; answer: OwnerAnswer }

/**
 * Reads the reply to the summary: "sí" confirms; a number asks to change that answer; "el 2 era
 * préstamo" or "me equivoqué en la segunda, es un traspaso" corrects it (read with `parseReply`
 * against that question); "no" asks which to change. Null if not understood.
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
