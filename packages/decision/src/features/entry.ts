/**
 * Una entrada del perfil mientras se calcula. El perfil completo se valida contra
 * `ProfileFeatures` al final (`buildProfile`), así que un tipo equivocado aquí truena en los
 * tests en lugar de llegar al motor.
 */
import type { FeatureName, Provenance, Verification } from '@gow/contracts'

export interface Entry {
  value: unknown
  confidence: number
  verification: Verification
  provenance: Provenance
  evidence: string[]
  note: string | null
}

export type Entries = Partial<Record<FeatureName, Entry>>

export const MAX_EVIDENCE = 25

export interface EntryMeta {
  confidence?: number
  verification?: Verification
  provenance?: Provenance
  evidence?: string[]
  note?: string | null
}

export function known(value: unknown, meta: EntryMeta = {}): Entry {
  return {
    value,
    confidence: Math.round((meta.confidence ?? 1) * 10_000) / 10_000,
    verification: meta.verification ?? 'verified',
    provenance: meta.provenance ?? 'extracted',
    evidence: (meta.evidence ?? []).slice(0, MAX_EVIDENCE),
    note: meta.note ?? null,
  }
}

/** Desconocido: `value: null` y la razón en `note` (docs/03, cambios de la fase 1). */
export function unknown(note: string, provenance: Provenance = 'extracted'): Entry {
  return { value: null, confidence: 0, verification: 'unverified', provenance, evidence: [], note }
}

const RANK: Record<Verification, number> = { verified: 0, unverified: 1, conflict: 2 }

export function worst(...vs: Verification[]): Verification {
  return vs.reduce<Verification>((a, b) => (RANK[b] > RANK[a] ? b : a), 'verified')
}

/** Procedencia de un valor combinado: la respuesta de una persona pesa más que lo extraído. */
export function combinedProvenance(ps: Iterable<Provenance>): Provenance {
  let out: Provenance = 'extracted'
  for (const p of ps) {
    if (p === 'analyst_answer') return p
    if (p === 'owner_answer') out = p
  }
  return out
}
