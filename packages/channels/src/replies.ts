import type { OwnerAnswer, Question } from '@gow/contracts'
import { conversationalIndexes, normalize, parseReply, parseYesNo } from './conversation.ts'

const ORDINAL_WORD = /\b(?:(?:el|la) )?(primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|septim[oa]|setim[oa]|octav[oa]|noven[oa]|decim[oa])\b/g

function ordinalOf(word: string): number {
  const w = word.toLowerCase().replace(/^(?:el|la) /, '')
  const map: Record<string, number> = {
    primer: 1, primero: 1, primera: 1,
    segundo: 2, segunda: 2,
    tercer: 3, tercero: 3, tercera: 3,
    cuarto: 4, cuarta: 4,
    quinto: 5, quinta: 5,
    sexto: 6, sexta: 6,
    septimo: 7, septima: 7, setimo: 7, setima: 7,
    octavo: 8, octava: 8,
    noveno: 9, novena: 9,
    decimo: 10, decima: 10,
  }
  return map[w] ?? 0
}

const LEAD = /^(?:(?:es|era|eran|fue|son|seria|en realidad|realmente|debe ser|deberia ser|mas bien|cambialo a|cambiala a|cambiar a|a|por|y|que|la|el|lo)\s+)*/

function stripLead(t: string): string {
  return t.trim().replace(LEAD, '').trim()
}

export type MultiReply = { kind: 'answers'; answers: OwnerAnswer[] } | { kind: 'too_many'; given: number; pending: number } | { kind: 'invalid' }

function parseNumericReplies(t: string, pendingLength: number, closed: Question[]): MultiReply | null {
  if (!/^\d{1,2}(?: (?:y )?\d{1,2})+$/.test(t)) return null
  const nums = t.split(' ').filter((x) => x !== 'y')
  if (nums.length > pendingLength) return { kind: 'too_many', given: nums.length, pending: pendingLength }
  if (nums.length > closed.length) return { kind: 'invalid' }
  const answers = nums.map((n, i) => parseReply(n, closed[i] as Question))
  return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : { kind: 'invalid' }
}

function parseOrdinalReplies(t: string, closed: Question[]): MultiReply | null {
  const marks = [...t.matchAll(ORDINAL_WORD)]
  if (marks.length < 2) return null
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

function parseDelimitedReplies(text: string, closed: Question[]): MultiReply | null {
  const parts = text
    .split(/[\n;,]+|\s+y\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length < 2 || parts.length > closed.length || parts.some((p) => normalize(p).split(' ').length > 6)) return null
  const answers = parts.map((p, i) => parseReply(p, closed[i] as Question))
  return answers.every((a): a is OwnerAnswer => a !== null) ? { kind: 'answers', answers } : null
}

export function parseMultipleReplies(text: string, pending: readonly Question[]): MultiReply | null {
  const closed: Question[] = []
  for (const q of pending) {
    if (q.options.length === 0) break
    closed.push(q)
  }
  if (closed.length === 0) return null
  const t = normalize(text)
  return parseNumericReplies(t, pending.length, closed) ?? parseOrdinalReplies(t, closed) ?? parseDelimitedReplies(text, closed)
}

export type ConfirmationRead = { kind: 'confirm' } | { kind: 'reject' } | { kind: 'change'; number: number } | { kind: 'correct'; number: number; answer: OwnerAnswer }

function parseCorrectionReference(t: string, convo: Question[]): ConfirmationRead | null {
  const byNumber = /(?:^|\b(?:la|el|numero|pregunta|respuesta)\s+)(\d{1,2})\b/.exec(t)
  const byOrdinal = byNumber ? null : [...t.matchAll(ORDINAL_WORD)][0]
  const ref = byNumber
    ? { number: Number(byNumber[1]), index: byNumber.index, length: byNumber[0].length }
    : byOrdinal
      ? { number: ordinalOf(byOrdinal[1] ?? ''), index: byOrdinal.index, length: byOrdinal[0].length }
      : null
  if (!ref || ref.number <= 0) return null
  const q = convo[ref.number - 1]
  if (!q) return { kind: 'change', number: ref.number }
  const after = stripLead(t.slice(ref.index + ref.length))
  const before = stripLead(t.slice(0, ref.index).trim().replace(/\s*\b(?:era|es|fue)$/, ''))
  const answer = (after ? parseReply(after, q) : null) ?? (before ? parseReply(before, q) : null)
  return answer ? { kind: 'correct', number: ref.number, answer } : { kind: 'change', number: ref.number }
}

function isConfirmationAffirmative(t: string, text: string): boolean {
  if (parseYesNo(text) === true) return true
  return /^(si|correcto|todo (esta )?bien|esta bien|perfecto|ok|okay|de acuerdo|asi es|exacto|listo|adelante|envialo|enviar)\b/.test(t) && !/\b(no|pero|cambi\w*)\b/.test(t)
}

export function parseConfirmation(text: string, questions: readonly Question[]): ConfirmationRead | null {
  const t = normalize(text)
  if (!t) return null
  const convo = conversationalIndexes(questions).map((i) => questions[i] as Question)
  const bare = /^(?:(?:la|el|numero|pregunta|respuesta|cambiar|cambia|cambio|quiero cambiar)\s+)*(\d{1,2})$/.exec(t)
  if (bare) return { kind: 'change', number: Number(bare[1]) }

  const correction = parseCorrectionReference(t, convo)
  if (correction) return correction

  if (isConfirmationAffirmative(t, text)) return { kind: 'confirm' }
  if (parseYesNo(text) === false || /^(no|incorrecto)\b/.test(t)) return { kind: 'reject' }
  return null
}
