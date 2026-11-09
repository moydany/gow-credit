import { checkRfc, rfcRoot, type SupplierIdentity, type Verification } from '@gow/contracts'
import { type LedgerDocument } from '../ledger.ts'
import { nameSimilarity, normalizeText } from '../util/text.ts'
import { known, unknown, worst, type Entry } from './entry.ts'
import type { StatementContext } from './statement-context.ts'

export type FieldResult = 'match' | 'partial' | 'root' | 'mismatch' | null

const MASK_CHARS = /[*•#]/

function cleanId(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase()
}

export function compareMasked(doc: string, registered: string): FieldResult {
  if (doc.length !== registered.length) return 'mismatch'
  let visible = 0
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i] ?? ''
    if (MASK_CHARS.test(c)) continue
    visible++
    if (c !== registered[i]) return 'mismatch'
  }
  return visible >= 3 ? 'partial' : null
}

export function compareRfc(docRfc: string, registered: string): FieldResult {
  const a = cleanId(docRfc)
  const b = cleanId(registered)
  const root = rfcRoot(a)
  if (root !== null) {
    return checkRfc(b).result === 'valid' && b.length === root.length + 3
      ? b.startsWith(root) ? 'root' : 'mismatch'
      : null
  }
  const check = checkRfc(a)
  if (check.result === 'valid') return check.kind === 'generic' ? null : a === b ? 'match' : 'mismatch'
  if (check.result === 'masked') return compareMasked(a, b)
  return null
}

export function compareName(docName: string, registered: string): FieldResult {
  const sim = nameSimilarity(docName, registered)
  if (normalizeText(docName).length === 0) return null
  return sim >= 0.99 ? 'match' : sim >= 0.5 ? 'partial' : 'mismatch'
}

export interface IdentityComparison {
  field: 'rfc' | 'name'
  result: FieldResult
  verification: Verification
  where: string
}

export function collectDocumentIdentityComparisons(
  doc: LedgerDocument,
  supplier: SupplierIdentity,
): IdentityComparison[] {
  const s = doc.statement
  const results: IdentityComparison[] = []
  if (supplier.rfc !== null) {
    if (s.holder.rfc.value !== null) {
      results.push({
        field: 'rfc',
        result: compareRfc(s.holder.rfc.value, supplier.rfc),
        verification: s.holder.rfc.verification,
        where: `${doc.tag}:holder.rfc`,
      })
    }
    for (const f of s.fiscal_documents) {
      if (f.receiver.rfc.value !== null) {
        results.push({
          field: 'rfc',
          result: compareRfc(f.receiver.rfc.value, supplier.rfc),
          verification: f.receiver.rfc.verification,
          where: `${doc.tag}:${f.id}.receiver.rfc`,
        })
      }
    }
  }
  if (s.holder.name.value !== null) {
    results.push({
      field: 'name',
      result: compareName(s.holder.name.value, supplier.legal_name),
      verification: s.holder.name.verification,
      where: `${doc.tag}:holder.name`,
    })
  }
  return results
}

export function resolveIdentityMatchValue(compared: readonly IdentityComparison[]): 'match' | 'partial' | 'mismatch' {
  if (compared.some((r) => r.result === 'mismatch')) return 'mismatch'
  const has = (field: string, result: FieldResult) => compared.some((r) => r.field === field && r.result === result)
  if (has('rfc', 'match') || (has('name', 'match') && has('rfc', 'root'))) return 'match'
  return 'partial'
}

export function identityMatch(ctx: StatementContext): Entry {
  const supplier = ctx.supplier
  if (supplier === null) return unknown('sin proveedor registrado contra el cual comparar')
  const results = ctx.ledger.documents.flatMap((doc) => collectDocumentIdentityComparisons(doc, supplier))
  const compared = results.filter((r) => r.result !== null)
  if (compared.length === 0) {
    return unknown('titular y RFC no vienen en el documento o no se pueden comparar (redactados o enmascarados)')
  }
  const verification = worst(...compared.map((r) => r.verification))
  const evidence = compared.map((r) => `${r.where}=${r.result ?? ''}`)
  const value = resolveIdentityMatchValue(compared)
  return known(value, { verification, evidence, note: `campos comparados: ${[...new Set(compared.map((r) => r.field))].join(', ')}` })
}
