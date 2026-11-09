import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  STATEMENT_SCHEMA_VERSION,
  StatementExtraction,
  type DocumentFlag,
  type DocumentType,
  type FiscalDocument,
  type ModelCall,
  type TokenUsage,
  type Transaction,
} from '@gow/contracts'
import { addUsage, EXTRACTION_MODEL, ZERO_USAGE } from '@gow/llm'
import { type AssembledSummary } from './assemble.ts'
import { IssueSink } from './issues.ts'
import { type LoadedPdf } from './pdf.ts'

export interface BuildInput {
  extractionModel: string
  pdf: LoadedPdf
  route: 'text_and_vision' | 'vision_only'
  started: Date
  documentType: DocumentType
  classConfidence: number
  classifierBank: string | null
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean }
  summary: AssembledSummary | null
  fiscal: FiscalDocument[]
  periodsTx: Map<string, Transaction[]>
  issues: IssueSink
  flags: Set<DocumentFlag>
  calls: ModelCall[]
  failureReason: string | null
  status: 'complete' | 'partial' | 'failed'
}

const missingField = {
  value: null,
  source: null,
  verification: 'unverified' as const,
  confidence: 0,
  provenance: 'extracted' as const,
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

type ZodIssueLike = { path: PropertyKey[]; message: string }

function dropContractInvalidRows(copy: Record<string, unknown>, dropRows: Map<string, Set<number>>): boolean {
  for (const [key, rows] of dropRows) {
    let list: unknown = copy
    for (const k of key.split('.')) list = (list as Record<string, unknown> | undefined)?.[k]
    if (!Array.isArray(list)) return false
    const arr = list as unknown[]
    const kept = arr.filter((_, i) => !rows.has(i))
    arr.splice(0, arr.length, ...kept)
  }
  return true
}

export function repairAgainstContract(
  doc: StatementExtraction,
  problems: readonly ZodIssueLike[],
  issues: IssueSink,
): StatementExtraction | null {
  const copy = structuredClone(doc) as unknown as Record<string, unknown>
  const dropRows = new Map<string, Set<number>>()
  for (const p of problems) {
    const path = p.path.map(String)
    const where = path.join('.')
    const txAt = path.indexOf('transactions')
    if (txAt >= 0 && path[txAt + 1] !== undefined) {
      const key = path.slice(0, txAt + 1).join('.')
      const set = dropRows.get(key) ?? new Set<number>()
      set.add(Number(path[txAt + 1]))
      dropRows.set(key, set)
      issues.add({
        code: 'missing_required_field',
        severity: 'error',
        message: `Se quitó un movimiento que no cumple el contrato (${path.slice(txAt + 2).join('.')}: ${p.message}).`,
        path: `/${path.slice(0, txAt + 2).join('/')}`,
      })
      continue
    }
    const valueAt = path.lastIndexOf('value')
    if (valueAt <= 0) return null
    let parent: unknown = copy
    for (const k of path.slice(0, valueAt)) parent = (parent as Record<string, unknown> | undefined)?.[k]
    if (typeof parent !== 'object' || parent === null) return null
    Object.assign(parent, { value: null, source: null, verification: 'unverified', confidence: 0 })
    issues.add({
      code: 'missing_required_field',
      severity: 'warning',
      message: `Un valor no cumple el contrato y quedó como desconocido (${where}: ${p.message}).`,
      path: `/${path.join('/')}`,
    })
  }
  if (!dropContractInvalidRows(copy, dropRows)) return null
  const again = StatementExtraction.safeParse({ ...copy, issues: issues.issues })
  return again.success ? again.data : null
}

export function build(b: BuildInput): StatementExtraction {
  const finished = new Date()
  const usage = b.calls.reduce<TokenUsage>((acc, c) => addUsage(acc, c.usage), ZERO_USAGE)
  const cost = round6(b.calls.reduce((s, c) => s + c.cost_usd, 0))
  const accounts = (b.summary?.accounts ?? []).map((a) => ({
    ...a,
    periods: a.periods.map((p) => ({ ...p, transactions: b.periodsTx.get(p.id) ?? [] })),
  }))
  const doc: StatementExtraction = {
    schema_version: STATEMENT_SCHEMA_VERSION,
    document: {
      file_name: b.pdf.fileName,
      sha256: b.pdf.sha256,
      size_bytes: b.pdf.sizeBytes,
      page_count: Math.max(1, b.pdf.pageCount),
      text_layer: b.pdf.textLayer,
      route: b.route,
    },
    classification: { document_type: b.documentType, confidence: b.classConfidence, bank: b.classifierBank },
    bank_name: b.summary?.bankName ?? missingField,
    holder: b.summary?.holder ?? {
      name: missingField,
      rfc: missingField,
      holder_type: missingField,
      address: missingField,
    },
    accounts,
    fiscal_documents: b.fiscal,
    issues: b.issues.issues,
    flags: [...b.flags],
    extraction: {
      status: b.status,
      started_at: b.started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: finished.getTime() - b.started.getTime(),
      extraction_model: b.extractionModel,
      classifier: b.classifier,
      prompts: Object.fromEntries(
        [...new Set(b.calls.map((c) => c.prompt).filter((p): p is string => p !== null))].map((id) => [
          id.split('.v')[0] ?? id,
          `v${id.split('.v')[1] ?? '?'}`,
        ]),
      ),
      calls: b.calls,
      usage,
      cost_usd: cost,
      failure_reason: b.failureReason,
    },
  }
  const parsed = StatementExtraction.safeParse(doc)
  if (parsed.success) return parsed.data
  const repaired = repairAgainstContract(doc, parsed.error.issues, b.issues)
  if (repaired) return repaired
  const where = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
  return {
    ...doc,
    accounts: [],
    issues: [
      ...b.issues.issues,
      {
        id: `i${String(b.issues.issues.length + 1).padStart(4, '0')}`,
        code: 'block_failed',
        severity: 'error',
        message: `La extracción no validó contra el contrato y se descartó: ${where}`,
        page: null,
        path: null,
        account_id: null,
        period_id: null,
        transaction_id: null,
        details: {},
      },
    ],
    extraction: { ...doc.extraction, status: 'failed', failure_reason: `contrato inválido: ${where}` },
  }
}

export function buildFailedExtraction(
  b: Omit<BuildInput, 'summary' | 'fiscal' | 'periodsTx' | 'status'>,
): StatementExtraction {
  return build({ ...b, summary: null, fiscal: [], periodsTx: new Map(), status: 'failed' })
}

export function finalizeFailed(
  path: string,
  bytes: Buffer,
  started: Date,
  reason: string,
): StatementExtraction {
  const sha = createHash('sha256').update(bytes).digest('hex')
  const pdf: LoadedPdf = {
    fileName: basename(path),
    bytes: new Uint8Array(),
    base64: '',
    sha256: sha,
    sizeBytes: bytes.byteLength,
    pageCount: 1,
    pageTexts: [''],
    textLayer: 'absent',
    textRepaired: false,
    pagination: [{ page: 1, printed: null, total: null }],
    duplicatePages: [],
    duplicates: [],
    rotatedPages: [],
    straightened: false,
  }
  const issues = new IssueSink()
  issues.add({ code: 'page_unreadable', severity: 'error', message: reason })
  return build({
    extractionModel: EXTRACTION_MODEL,
    pdf,
    route: 'vision_only',
    started,
    documentType: 'other',
    classConfidence: 0,
    classifierBank: null,
    classifier: { implementation: 'claude', model: 'none', fallback: true },
    summary: null,
    fiscal: [],
    periodsTx: new Map(),
    issues,
    flags: new Set(['partial_extraction']),
    calls: [],
    failureReason: reason,
    status: 'failed',
  })
}
