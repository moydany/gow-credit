/**
 * Closed grammar of `decision.limitFormula`. Not code: it is parsed and validated against the
 * catalog when the policy is saved.
 *
 *   formula := "min" "(" term ("," term)* ")" | term
 *   term    := "band" | feature | feature "-" feature
 *
 * Every feature must be of type `money`, and `band` must appear exactly once (otherwise the band
 * percentage would have no effect).
 */
import { FEATURE_CATALOG, type FeatureName } from './features.ts'

export type LimitTerm =
  | { type: 'band' }
  | { type: 'feature'; feature: FeatureName }
  | { type: 'difference'; minuend: FeatureName; subtrahend: FeatureName }

export interface LimitFormula {
  terms: LimitTerm[]
}

export type ParseLimitFormulaResult = { ok: true; formula: LimitFormula } | { ok: false; error: string }

const IDENT = /^[a-z][a-z0-9_]*$/

function isFeatureName(s: string): s is FeatureName {
  return Object.hasOwn(FEATURE_CATALOG, s)
}

function parseIdent(raw: string, where: string): { ok: true; name: FeatureName | 'band' } | { ok: false; error: string } {
  const s = raw.trim()
  if (s === 'band') return { ok: true, name: 'band' }
  if (!IDENT.test(s)) return { ok: false, error: `${where}: "${s}" no es un término válido; se espera band, una feature o feature - feature` }
  if (!isFeatureName(s)) return { ok: false, error: `${where}: feature desconocida "${s}"` }
  const kind = FEATURE_CATALOG[s].kind
  if (kind !== 'money') return { ok: false, error: `${where}: "${s}" es ${kind}; en la fórmula de línea solo caben features de tipo money` }
  return { ok: true, name: s }
}

function parseTerm(raw: string, index: number): { ok: true; term: LimitTerm } | { ok: false; error: string } {
  const where = `término ${String(index + 1)}`
  const parts = raw.split('-')
  if (parts.length > 2) return { ok: false, error: `${where}: solo se permite una resta (feature - feature)` }
  if (parts.length === 2) {
    const [a = '', b = ''] = parts
    const left = parseIdent(a, where)
    if (!left.ok) return left
    const right = parseIdent(b, where)
    if (!right.ok) return right
    if (left.name === 'band' || right.name === 'band') return { ok: false, error: `${where}: band no puede ir en una resta` }
    return { ok: true, term: { type: 'difference', minuend: left.name, subtrahend: right.name } }
  }
  const single = parseIdent(raw, where)
  if (!single.ok) return single
  return { ok: true, term: single.name === 'band' ? { type: 'band' } : { type: 'feature', feature: single.name } }
}

export function parseLimitFormula(input: string): ParseLimitFormulaResult {
  const src = input.trim()
  if (src.length === 0) return { ok: false, error: 'la fórmula está vacía' }

  let body: string[]
  const call = /^min\s*\((.*)\)$/s.exec(src)
  if (call) {
    const inner = (call[1] ?? '').trim()
    if (inner.length === 0) return { ok: false, error: 'min() necesita al menos un término' }
    if (/[()]/.test(inner)) return { ok: false, error: 'no se permiten paréntesis anidados; la forma es min(t1, t2, ...)' }
    body = inner.split(',')
  } else {
    if (/[(),]/.test(src)) return { ok: false, error: `forma no reconocida "${src}"; se espera min(t1, t2, ...) o un solo término` }
    body = [src]
  }

  const terms: LimitTerm[] = []
  for (const [i, raw] of body.entries()) {
    if (raw.trim().length === 0) return { ok: false, error: `término ${String(i + 1)} vacío` }
    const parsed = parseTerm(raw, i)
    if (!parsed.ok) return parsed
    terms.push(parsed.term)
  }

  const bands = terms.filter((t) => t.type === 'band').length
  if (bands !== 1) return { ok: false, error: `band debe aparecer exactamente una vez (aparece ${String(bands)})` }
  return { ok: true, formula: { terms } }
}

export function formatLimitTerm(t: LimitTerm): string {
  switch (t.type) {
    case 'band':
      return 'band'
    case 'feature':
      return t.feature
    case 'difference':
      return `${t.minuend} - ${t.subtrahend}`
  }
}
