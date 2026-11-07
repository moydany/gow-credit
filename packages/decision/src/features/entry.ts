/**
 * A profile entry while it is being computed. The full profile is validated against
 * `ProfileFeatures` at the end (`buildProfile`), so a wrong type here fails in tests instead of
 * reaching the engine.
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

/** Unknown: `value: null` and the reason in `note`. */
export function unknown(note: string, provenance: Provenance = 'extracted'): Entry {
  return { value: null, confidence: 0, verification: 'unverified', provenance, evidence: [], note }
}

const RANK: Record<Verification, number> = { verified: 0, unverified: 1, conflict: 2 }

export function worst(...vs: Verification[]): Verification {
  return vs.reduce<Verification>((a, b) => (RANK[b] > RANK[a] ? b : a), 'verified')
}

/** Provenance of a combined value: a person's answer outweighs what was extracted. */
export function combinedProvenance(ps: Iterable<Provenance>): Provenance {
  let out: Provenance = 'extracted'
  for (const p of ps) {
    if (p === 'analyst_answer') return p
    if (p === 'owner_answer') out = p
  }
  return out
}
