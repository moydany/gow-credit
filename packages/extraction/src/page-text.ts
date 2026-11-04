/**
 * Búsquedas en la capa de texto local para verificar lo que dijo el modelo (docs/04 §3.5).
 * Solo aplican si la capa es usable (ok, parcial o reparada); en visión pura no hay contra
 * qué comparar y la verificación queda en la aritmética.
 */
import { amountForms, normalizeText } from './normalize.ts'
import type { LoadedPdf } from './pdf.ts'

export function textUsable(pdf: Pick<LoadedPdf, 'textLayer' | 'textRepaired'>): boolean {
  return pdf.textLayer === 'ok' || pdf.textLayer === 'partial' || pdf.textRepaired
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class PageText {
  readonly #raw: string[]
  readonly #norm: string[]
  readonly usable: boolean

  constructor(pdf: Pick<LoadedPdf, 'pageTexts' | 'textLayer' | 'textRepaired'>) {
    this.#raw = pdf.pageTexts
    this.#norm = pdf.pageTexts.map(normalizeText)
    this.usable = textUsable(pdf)
  }

  get pageCount(): number {
    return this.#raw.length
  }

  validPage(page: number | null): page is number {
    return page !== null && Number.isInteger(page) && page >= 1 && page <= this.#raw.length
  }

  /** ¿Aparece el monto impreso en la página? Respeta bordes para no confundir 5,000.00 con 15,000.00. */
  amountOnPage(page: number, amount: number): boolean {
    const text = this.#raw[page - 1] ?? ''
    return amountForms(amount).some((form) => new RegExp(`(?<![\\d,.])${escape(form)}(?!\\d)`).test(text))
  }

  /** ¿La mayoría de las palabras del snippet están en la página? Tolera columnas partidas. */
  snippetOnPage(page: number, snippet: string): boolean {
    const page_ = this.#norm[page - 1] ?? ''
    const tokens = normalizeText(snippet)
      .split(' ')
      .filter((t) => t.length >= 3 || /\d/.test(t))
    if (tokens.length === 0) return false
    const found = tokens.filter((t) => page_.includes(t)).length
    return found / tokens.length >= 0.6
  }

  /** Primera página y línea donde aparece el texto (normalizado). */
  locateText(value: string): { page: number; line: string } | null {
    const needle = normalizeText(value)
    if (needle.length < 4) return null
    for (let i = 0; i < this.#raw.length; i++) {
      if (!(this.#norm[i] ?? '').includes(needle)) continue
      const line = (this.#raw[i] ?? '').split('\n').find((l) => normalizeText(l).includes(needle)) ?? value
      return { page: i + 1, line: line.trim().slice(0, 600) }
    }
    return null
  }

  locateAmount(amount: number, pages?: readonly number[]): { page: number; line: string } | null {
    const candidates = pages && pages.length > 0 ? pages : this.#raw.map((_, i) => i + 1)
    for (const p of candidates) {
      if (!this.validPage(p) || !this.amountOnPage(p, amount)) continue
      const forms = amountForms(amount)
      const line = (this.#raw[p - 1] ?? '').split('\n').find((l) => forms.some((f) => l.includes(f))) ?? forms[0] ?? ''
      return { page: p, line: line.trim().slice(0, 600) }
    }
    return null
  }
}
