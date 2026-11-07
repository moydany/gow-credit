/**
 * Reads stored extractions: verification stats, payload calls and journey documents. All
 * defensive: an older payload may lack fields.
 */
import { arr, count, get, isRec, ms, num, pageNumber, parseMs, str, type CallInfo, type ExtractionInfo, type Rec } from './timeline-build-base.ts'
import type { TimelineDocument } from './timeline.ts'
import type { TimelineSources } from './timeline-sources.ts'

type Verification = 'verified' | 'unverified' | 'conflict'

export interface PayloadStats {
  verified: number
  unverified: number
  conflict: number
  pagesWithIssues: number[]
  issuesByPage: Map<number, number>
  txByPage: Map<number, number>
  worstByPage: Map<number, Verification>
  flags: string[]
}

const WORST: Record<Verification, number> = { verified: 1, unverified: 2, conflict: 3 }
const isVerification = (v: unknown): v is Verification => v === 'verified' || v === 'unverified' || v === 'conflict'

function noteVerification(out: PayloadStats, x: Rec, v: Verification): void {
  out[v]++
  const page = pageNumber(get(x, 'source', 'page'))
  if (page === null) return
  const cur = out.worstByPage.get(page)
  if (cur === undefined || WORST[v] > WORST[cur]) out.worstByPage.set(page, v)
}

function walkVerification(out: PayloadStats, x: unknown, depth: number): void {
  if (depth > 40) return
  if (Array.isArray(x)) {
    for (const v of x) walkVerification(out, v, depth + 1)
    return
  }
  if (!isRec(x)) return
  if (isVerification(x.verification)) noteVerification(out, x, x.verification)
  for (const k of Object.keys(x)) walkVerification(out, x[k], depth + 1)
}

function bump(map: Map<number, number>, page: number | null): void {
  if (page !== null) map.set(page, (map.get(page) ?? 0) + 1)
}

/** Counts values by verification state, transactions and issues per page, and flags. */
export function payloadStats(payload: unknown): PayloadStats {
  const out: PayloadStats = { verified: 0, unverified: 0, conflict: 0, pagesWithIssues: [], issuesByPage: new Map(), txByPage: new Map(), worstByPage: new Map(), flags: [] }
  walkVerification(out, payload, 0)
  const transactions = arr(get(payload, 'accounts')).flatMap((a) => arr(get(a, 'periods')).flatMap((p) => arr(get(p, 'transactions'))))
  for (const t of transactions) bump(out.txByPage, pageNumber(get(t, 'source', 'page')))
  for (const i of arr(get(payload, 'issues'))) bump(out.issuesByPage, pageNumber(get(i, 'page')))
  out.pagesWithIssues = [...out.issuesByPage.keys()].sort((a, b) => a - b)
  out.flags = arr(get(payload, 'flags')).filter((f): f is string => typeof f === 'string')
  return out
}

/** Model calls the extraction left in its payload. */
export function callsOf(payload: unknown): CallInfo[] {
  return arr(get(payload, 'extraction', 'calls'))
    .filter(isRec)
    .map(
      (c, index): CallInfo => ({
        index,
        purpose: str(c.purpose) ?? 'unknown',
        model: str(c.model) ?? 'desconocido',
        prompt: str(c.prompt),
        effort: str(c.effort),
        pages: arr(c.pages).map(pageNumber).filter((p): p is number => p !== null),
        inputTokens: count(get(c, 'usage', 'input_tokens')),
        outputTokens: count(get(c, 'usage', 'output_tokens')),
        costUsd: Math.max(0, num(c.cost_usd) ?? 0),
        latencyMs: Math.max(0, Math.round(num(c.latency_ms) ?? 0)),
        cacheHit: c.response_cache_hit === true,
      }),
    )
}

/** Stored extractions of the documents, with their time window. */
export function extractionsOf(src: TimelineSources): ExtractionInfo[] {
  const out: ExtractionInfo[] = []
  src.documents.forEach((doc, docIndex) => {
    if (!doc.extraction) return
    const payload: unknown = doc.extraction.payload
    const startMs = parseMs(get(payload, 'extraction', 'started_at')) ?? ms(doc.extraction.createdAt)
    const finishedMs = Math.max(startMs, parseMs(get(payload, 'extraction', 'finished_at')) ?? startMs)
    out.push({ docIndex, doc, extractionId: doc.extraction.id, payload, startMs, finishedMs, calls: callsOf(payload) })
  })
  return out.sort((a, b) => a.startMs - b.startMs || a.docIndex - b.docIndex)
}

export function extractionStatus(payload: unknown): 'complete' | 'partial' | 'failed' | null {
  const s = str(get(payload, 'extraction', 'status'))
  return s === 'complete' || s === 'partial' || s === 'failed' ? s : null
}

function pagesOf(payload: unknown, pageCount: number | null): TimelineDocument['pages'] {
  if (pageCount === null) return []
  const st = payloadStats(payload)
  const pages: TimelineDocument['pages'] = []
  for (let page = 1; page <= Math.min(pageCount, 2000); page++) {
    pages.push({ page, transactions: st.txByPage.get(page) ?? 0, issues: st.issuesByPage.get(page) ?? 0, verification: st.worstByPage.get(page) ?? 'none' })
  }
  return pages
}

/** One PDF per request document, with its pages. */
export function documentsOf(src: TimelineSources): TimelineDocument[] {
  return src.documents.map((d) => {
    const payload: unknown = d.extraction?.payload ?? null
    const route = str(get(payload, 'document', 'route'))
    const pageCount = pageNumber(get(payload, 'document', 'page_count'))
    return {
      document_id: d.documentId,
      origin: d.origin,
      page_count: pageCount,
      route: route === 'text_and_vision' || route === 'vision_only' ? route : null,
      extraction_status: extractionStatus(payload),
      pages: payload === null ? [] : pagesOf(payload, pageCount),
    }
  })
}
