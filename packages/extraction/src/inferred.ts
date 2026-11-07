/**
 * Account type and currency are model inferences: the bank prints "AHORRO FACIL" or "En Pesos
 * Moneda Nacional", never "savings" or "MXN", so a literal check never verified them and every
 * account showed two "unverified" values with nothing to highlight in the PDF. Here they are
 * verified when a printed word states them, and that printed line becomes their source (a verified
 * value must cite one). For the type: the product name ("AHORRO FACIL", "INVERSION EMPRESARIAL"),
 * or anywhere in the document when no other account of the statement claims the same type (two
 * accounts are often named on one page, so a page-wide word could prove either; account numbers
 * are usually masked, so their line does not help). For the currency: anywhere in the document.
 */
import type { AccountType, SourceRef } from '@gow/contracts'
import { normalizeText } from './normalize.ts'
import type { PageText } from './page-text.ts'

/** Words (normalized: lowercase, no accents) that state each account type. */
const TYPE_WORDS: Record<AccountType, RegExp | null> = {
  checking: /\bcheques?\b|\bchequera\b|\bvista\b|\bnomina\b|cuenta de debito/,
  savings: /\bahorros?\b/,
  investment: /\binversion(es)?\b|\bpagare\b|plazo fijo/,
  credit_card: /tarjeta de credito/,
  other: null,
}

/** Words that state each currency. */
const CURRENCY_WORDS: Readonly<Record<string, RegExp>> = {
  MXN: /moneda nacional|\bpesos\b|\bm\.n\.|\bmxn\b/,
  USD: /\bdolar(es)?\b|\busd\b|\bdlls?\b/,
}

const sourceOf = (hit: { page: number; line: string } | null): SourceRef | null => (hit ? { page: hit.page, snippet: hit.line } : null)

/**
 * Where a printed word states this account type: the product name's own source, or (when this is
 * the only account of the statement with that type; `sameType` counts them) the first line in the
 * document that says it. Null if nothing printed proves it.
 */
export function accountTypeSource(type: AccountType, product: { value: string | null; source: SourceRef | null }, sameType: number, text: PageText): SourceRef | null {
  const words = TYPE_WORDS[type]
  if (!words || !text.usable) return null
  if (product.source && words.test(normalizeText(product.value ?? ''))) return product.source
  return sameType === 1 ? sourceOf(text.lineMatching(words)) : null
}

/** The printed line that states this currency, or null. */
export function currencySource(code: string, text: PageText): SourceRef | null {
  const words = CURRENCY_WORDS[code]
  return words && text.usable ? sourceOf(text.lineMatching(words)) : null
}
