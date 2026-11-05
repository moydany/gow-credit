/**
 * Filtro de cifras (docs/04 §4): todo número y toda fecha de un texto generado para el proveedor
 * tiene que estar en la lista de hechos de donde se redactó. Si no, el texto se descarta y se
 * regenera, y si vuelve a fallar se usa la plantilla del código. Nunca se envía sin pasar aquí.
 *
 * Qué cuenta como cifra: números con dígitos (montos, días, meses, porcentajes, referencias),
 * fechas en palabras o en ISO, y los números escritos con palabras de dos en adelante. Las
 * palabras "mil" y "millón" no se aceptan: los montos se escriben con dígitos.
 */
import type { QuestionFact } from '@gow/contracts'

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const
const MONTH_RE = MONTHS.join('|')

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  noventa: 90,
  cien: 100,
  ciento: 100,
}
const FORBIDDEN_WORDS = ['mil', 'millon', 'millón', 'millones']

interface DateRef {
  y: number | null
  m: number
  d: number | null
}

export interface FigureCheck {
  ok: boolean
  /** Las cifras del texto que no están en los hechos, tal como aparecen. */
  unsupported: string[]
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

function numericVariants(v: number): number[] {
  const out = [v, round(v, 0), round(v, 1), round(v, 2), Math.floor(v), Math.abs(v)]
  if (Math.abs(v) <= 1) out.push(round(v * 100, 0), round(v * 100, 1), round(v * 100, 2))
  return out
}

/** "150,000.50" → 150000.5; "1.234,5" no es formato mexicano y se lee como venga. */
function parseNumber(token: string): number | null {
  const clean = token.replace(/[,\s]/g, '')
  const n = Number(clean)
  return Number.isFinite(n) ? n : null
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g
const WORD_DATE = new RegExp(`\\b(\\d{1,2}) de (${MONTH_RE})(?: (?:de|del) (\\d{4}))?\\b`, 'gi')
const MONTH_YEAR = new RegExp(`\\b(${MONTH_RE}) (?:de|del) (\\d{4})\\b`, 'gi')
/** Un número que no va pegado a letras (q1, T20 o A649 son identificadores, no cifras). */
const NUMBER = /(?<![\p{L}\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\p{L}\d])|(?<![\p{L}\d.,])\d+(?:\.\d+)?(?![\p{L}\d])/gu

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.toLowerCase() as (typeof MONTHS)[number]) + 1
}

/** Quita las fechas del texto y las devuelve aparte, para no contar sus partes como números sueltos. */
function takeDates(text: string): { rest: string; dates: { raw: string; ref: DateRef }[] } {
  const dates: { raw: string; ref: DateRef }[] = []
  let rest = text.replace(ISO_DATE, (raw, y: string, m: string, d: string) => {
    dates.push({ raw, ref: { y: Number(y), m: Number(m), d: Number(d) } })
    return ' '
  })
  rest = rest.replace(SLASH_DATE, (raw, d: string, m: string, y: string) => {
    dates.push({ raw, ref: { y: Number(y), m: Number(m), d: Number(d) } })
    return ' '
  })
  rest = rest.replace(WORD_DATE, (raw, d: string, month: string, y: string | undefined) => {
    dates.push({ raw, ref: { y: y ? Number(y) : null, m: monthIndex(month), d: Number(d) } })
    return ' '
  })
  rest = rest.replace(MONTH_YEAR, (raw, month: string, y: string) => {
    dates.push({ raw, ref: { y: Number(y), m: monthIndex(month), d: null } })
    return ' '
  })
  return { rest, dates }
}

interface Allowed {
  numbers: Set<number>
  dates: DateRef[]
}

function allowedFrom(facts: readonly QuestionFact[]): Allowed {
  const numbers = new Set<number>()
  const dates: DateRef[] = []
  const addNumber = (v: number) => {
    for (const x of numericVariants(v)) numbers.add(x)
  }
  for (const f of facts) {
    if (typeof f.value === 'number') addNumber(f.value)
    else if (typeof f.value === 'string') {
      const { rest, dates: ds } = takeDates(f.value)
      dates.push(...ds.map((d) => d.ref))
      for (const m of rest.matchAll(NUMBER)) {
        const n = parseNumber(m[0])
        if (n !== null) addNumber(n)
      }
    }
  }
  return { numbers, dates }
}

function dateSupported(ref: DateRef, allowed: readonly DateRef[]): boolean {
  return allowed.some((a) => a.m === ref.m && (ref.d === null || a.d === ref.d) && (ref.y === null || a.y === ref.y))
}

export function checkFigures(text: string, facts: readonly QuestionFact[]): FigureCheck {
  const allowed = allowedFrom(facts)
  const unsupported: string[] = []
  const { rest, dates } = takeDates(text)
  for (const d of dates) if (!dateSupported(d.ref, allowed.dates)) unsupported.push(d.raw)
  for (const m of rest.matchAll(NUMBER)) {
    const n = parseNumber(m[0])
    if (n === null || !allowed.numbers.has(n)) unsupported.push(m[0])
  }
  const words = rest.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^a-z]+/)
  for (const w of words) {
    if (FORBIDDEN_WORDS.includes(w)) unsupported.push(w)
    const v = NUMBER_WORDS[w]
    if (v !== undefined && !allowed.numbers.has(v)) unsupported.push(w)
  }
  return { ok: unsupported.length === 0, unsupported }
}

/** Fecha ISO → "15 de junio de 2025", como la escriben las plantillas. */
export function spanishDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${String(d)} de ${MONTHS[(m ?? 1) - 1] ?? ''} de ${String(y)}`
}

/** 150000.5 → "$150,000.50". */
export function pesos(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
