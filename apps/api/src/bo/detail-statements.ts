/**
 * The documents of a request for the detail view (ADR 0072): each extraction with the analyst's
 * corrections on that document, and what the profile did with each period against the evaluated
 * months. The window comes from the same code as the profile, so the view and the verdict agree.
 */
import type { Correction, Decision, DetailStatement, StatementExtraction } from '@gow/contracts'
import { periodWindows } from '@gow/decision'
import { applyCorrections } from '@gow/extraction/corrections'

interface DocRow {
  id: string
}
interface LinkRow {
  documentId: string
  origin: DetailStatement['origin']
}
interface ExtractionRow {
  documentId: string
  payload: unknown
}

/** Latest period end of a statement (ISO, comparable as text); '' without dates. */
function lastCutoff(s: StatementExtraction): string {
  return s.accounts.flatMap((a) => a.periods.map((p) => p.period_end.value ?? '')).reduce((a, b) => (b > a ? b : a), '')
}

export function detailStatements(
  docs: readonly DocRow[],
  links: readonly LinkRow[],
  extractions: readonly ExtractionRow[],
  fixes: readonly Correction[],
  decision: Decision | undefined,
): { list: DetailStatement[]; evaluation: { months: number; start: string | null; end: string | null } | null } {
  const list: DetailStatement[] = []
  for (const d of docs) {
    // Extractions come oldest first: the first one of the document is the one the request used.
    const ex = extractions.find((e) => e.documentId === d.id)
    if (!ex) continue
    const extraction = applyCorrections(ex.payload as StatementExtraction, fixes.filter((f) => f.document_id === d.id))
    list.push({ document_id: d.id, origin: links.find((l) => l.documentId === d.id)?.origin ?? 'submitted', extraction, periods: [] })
  }
  list.sort((a, b) => lastCutoff(a.extraction).localeCompare(lastCutoff(b.extraction)) || a.document_id.localeCompare(b.document_id))
  const months = decision?.profile.parameters.evaluation_months ?? 1
  const w = periodWindows(
    list.map((s) => s.extraction),
    months,
  )
  for (const s of list) {
    s.periods = w.periods.filter((p) => p.document_sha256 === s.extraction.document.sha256).map(({ account_id, period_id, start, end, status }) => ({ account_id, period_id, start, end, status }))
  }
  return { list, evaluation: decision ? { months, start: w.start, end: w.end } : null }
}
