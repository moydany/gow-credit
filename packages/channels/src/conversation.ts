/**
 * Conversación por WhatsApp o correo (docs/02 §3, docs/05 §2b; ADR 0017): una pregunta a la vez,
 * con opciones numeradas, y la respuesta se lee contra la pregunta que se está esperando. Solo los
 * abonos se preguntan por estos canales; identidad y documentos nuevos exigen un canal con segundo
 * factor (enlace de un solo uso o backoffice), así que van por la API.
 *
 * Lectura de la respuesta: número de opción, nombre de la opción o palabras clave. Si coinciden
 * dos categorías o ninguna, no se adivina: se vuelve a preguntar con las opciones numeradas
 * (docs/04 §4). El texto nunca autoriza nada: solo se compara contra la pregunta abierta de ese
 * número.
 */
import type { DepositAnswerCategory, OwnerAnswer, Question } from '@gow/contracts'

export const GENERIC_NO_PENDING = 'Hola. No tenemos una solicitud pendiente de aclarar para este número. Si crees que es un error, contacta a quien te pidió la información.'

/** Preguntas que se hacen por un canal conversacional. */
export function isConversational(q: Question): boolean {
  return q.kind === 'deposit'
}

export function renderQuestion(q: Question, position: number, total: number): string {
  const head = total > 1 ? `Pregunta ${String(position)} de ${String(total)}. ` : ''
  const options = q.options.map((o, i) => `${String(i + 1)}) ${o.label}`).join('\n')
  return `${head}${q.text}${options ? `\n\nResponde con el número:\n${options}` : ''}`
}

export function renderReask(q: Question): string {
  const options = q.options.map((o, i) => `${String(i + 1)}) ${o.label}`).join('\n')
  return `No entendimos tu respuesta. Responde solo con el número de la opción:\n${options}`
}

const KEYWORDS: readonly (readonly [DepositAnswerCategory | 'decline', RegExp])[] = [
  ['decline', /\bno (lo )?(se|recuerdo|tengo|estoy segur[oa])\b|\bni idea\b/],
  ['own_transfer', /\btraspaso\b|\b(mi|mis) (otra )?cuentas?\b|\bcuenta (mia|propia)\b|\bentre (mis )?cuentas\b|\bmio\b|\bmia\b/],
  ['loan_disbursement', /\bprestamo\b|\bcredito\b|\bfinanciera\b|\bfinanciamiento\b/],
  ['interest', /\binteres(es)?\b|\brendimientos?\b/],
  ['customer_payment', /\bpago de (un |mi )?cliente\b|\bcliente\b|\bventas?\b|\bcobro\b|\bfactura\b|\bme pago\b/],
  ['other', /\botra cosa\b|\botro\b/],
]

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** La respuesta a una pregunta de abono, o null si no se puede leer sin adivinar. */
export function parseReply(text: string, q: Question): OwnerAnswer | null {
  if (q.kind !== 'deposit') return null
  const t = normalize(text)
  const number = /^(?:opcion |la )?(\d)\b/.exec(t)
  if (number) {
    const option = q.options[Number(number[1]) - 1]
    if (option) return { question_id: q.id, kind: 'deposit', category: option.value as DepositAnswerCategory, counterparty: null }
  }
  const byLabel = q.options.filter((o) => t.includes(normalize(o.label)))
  if (byLabel.length === 1 && byLabel[0]) return { question_id: q.id, kind: 'deposit', category: byLabel[0].value as DepositAnswerCategory, counterparty: null }
  const hits = KEYWORDS.filter(([, re]) => re.test(t)).map(([c]) => c)
  // "pago de cliente" y "otro" pueden coincidir juntos en una frase larga: gana lo específico.
  const specific = hits.filter((c) => c !== 'other')
  const chosen = specific.length > 0 ? specific : hits
  if (chosen.length !== 1) return null
  const c = chosen[0]
  if (c === 'decline') return { question_id: q.id, kind: 'decline', note: null }
  return c ? { question_id: q.id, kind: 'deposit', category: c, counterparty: null } : null
}
