import {
  type DocumentFlag,
  type DocumentType,
  type FiscalDocument,
  type Period,
  type Transaction,
} from '@gow/contracts'
import {
  LlmCallError,
  loadPrompt,
  type Effort,
} from '@gow/llm'
import {
  assembleSummary,
  placeRows,
  type AssembledSummary,
  type PlacedRow,
} from './assemble.ts'
import { applyHeaderDoubleRead, headerDoubleRead } from './double-read.ts'
import {
  type CallRecorder,
  type Classified,
  type ExtractDeps,
  type ExtractOptions,
} from './extract-types.ts'
import { assembleFiscal, crossCheckFiscal } from './fiscal.ts'
import { type IssueSink } from './issues.ts'
import { type ExtractionChunk, type SummaryOut } from './llm-schema.ts'
import { type PageText, textUsable } from './page-text.ts'
import { type LoadedPdf } from './pdf.ts'
import { checkAccountFormats, checkDates, checkRfcField, reportPeriodIssues } from './period-checks.ts'
import { printedOf, reconcilePeriod, type PeriodReconciliation } from './reconcile.ts'
import { type ReconciledState } from './extract-retry.ts'
import { type ModelPlan } from './router.ts'

export {
  reconcileAndRetryStage,
  reconcileAll,
  type ReconciledState,
  type ReconcileAndRetryResult,
} from './extract-retry.ts'

export type ChunkCaller = (
  purpose: string,
  promptId: string,
  instruction: string,
  effort: Effort,
  pages: number[],
  maxOutputTokens: number,
  model?: string,
) => Promise<ExtractionChunk>

export interface ClassifiedResult {
  documentType: DocumentType
  classConfidence: number
  classifierBank: string | null
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean }
  classified: Classified | null
}

export function errorText(err: unknown): string {
  if (err instanceof LlmCallError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message.split('\n')[0] ?? 'error' : String(err)
}

export function chunkPages(pages: number[], size: number): number[][] {
  const blocks: number[][] = []
  for (let i = 0; i < pages.length; i += size) blocks.push(pages.slice(i, i + size))
  return blocks
}

export async function classifyDocumentStage(
  pdf: LoadedPdf,
  pdfInput: { base64: string; sha256: string; cache: boolean },
  deps: ExtractDeps,
  opts: ExtractOptions,
  inherited: Classified | null,
  flags: Set<DocumentFlag>,
  issues: IssueSink,
  record: CallRecorder,
): Promise<ClassifiedResult> {
  if (inherited) {
    for (const f of inherited.flags) flags.add(f)
    return {
      documentType: inherited.documentType,
      classConfidence: inherited.classConfidence,
      classifierBank: inherited.classifierBank,
      classifier: inherited.classifier,
      classified: inherited,
    }
  }

  try {
    const sample = textUsable(pdf) ? pdf.pageTexts.slice(0, 2).join('\n').slice(0, 6000) : null
    const c = await opts.limit(() => deps.classifier.classify({ textSample: sample, pdf: { ...pdfInput, cache: false } }))
    const classifierBank = c.bank === 'other' ? null : c.bank
    const classifier = { implementation: c.implementation, model: c.model, fallback: c.fallback }
    if (c.fallback) flags.add('classifier_fallback')
    if (c.containsInstructionsToAi) flags.add('possible_prompt_injection')
    record('classify', c.promptId, c.implementation === 'claude' ? 'low' : null, [], c)
    const classified: Classified = {
      documentType: c.documentType,
      classConfidence: c.confidence,
      classifierBank,
      classifier,
      flags: [...flags].filter((f) => f === 'classifier_fallback' || f === 'possible_prompt_injection'),
    }
    return { documentType: c.documentType, classConfidence: c.confidence, classifierBank, classifier, classified }
  } catch (err) {
    issues.add({
      code: 'block_failed',
      severity: 'warning',
      message: `Falló la clasificación (${errorText(err)}); se continúa con la extracción.`,
    })
    return {
      documentType: 'other',
      classConfidence: 0,
      classifierBank: null,
      classifier: { implementation: 'claude', model: 'none', fallback: true },
      classified: null,
    }
  }
}

export interface SummaryPassInput {
  callChunk: ChunkCaller
  pdf: LoadedPdf
  pdfInput: { base64: string; sha256: string; cache: boolean }
  deps: ExtractDeps
  plan: ModelPlan
  route: 'text_and_vision' | 'vision_only'
  system: string
  visionNote: string
  text: PageText
  opts: ExtractOptions
  flags: Set<DocumentFlag>
  issues: IssueSink
  outcome: { partial: boolean; providerDown: string | null }
  record: CallRecorder
  progress: (m: string) => void
  documentType: DocumentType
  classConfidence: number
}

export interface SummaryPassResult {
  summary: AssembledSummary | null
  fiscal: FiscalDocument[]
  failureReason: string | null
}

async function requestSummaryWithRetries(
  input: SummaryPassInput,
  summaryPrompt: ReturnType<typeof loadPrompt>,
): Promise<SummaryOut | null> {
  let summaryOut: SummaryOut | null = null
  for (let attempt = 1; attempt <= 2 && summaryOut === null; attempt++) {
    try {
      input.progress(`pasada 1 (intento ${String(attempt)})`)
      const res = await input.callChunk('summary', summaryPrompt.id, summaryPrompt.text, input.opts.summaryEffort, [], 16_000)
      summaryOut = res.summary
      if (summaryOut === null) {
        input.issues.add({ code: 'block_failed', severity: 'warning', message: 'La pasada 1 no devolvió resumen.' })
      }
    } catch (err) {
      input.issues.add({
        code: 'block_failed',
        severity: attempt === 2 ? 'error' : 'warning',
        message: `Falló la pasada 1 (intento ${String(attempt)}): ${errorText(err)}`,
      })
      if (err instanceof LlmCallError && err.code === 'missing_api_key') break
    }
  }
  return summaryOut
}

function flagSuspiciousSummary(
  summaryOut: SummaryOut,
  input: SummaryPassInput,
): void {
  if (summaryOut.document_kind !== 'bank_statement' || (input.documentType !== 'bank_statement' && input.classConfidence >= 0.7)) {
    input.flags.add('not_a_bank_statement')
    input.issues.add({
      code: 'not_a_bank_statement',
      severity: 'warning',
      message: `El documento no parece un estado de cuenta bancario (clasificador: ${input.documentType}; extractor: ${summaryOut.document_kind}). Se extrae igual y no se calcula perfil.`,
    })
  }
  if (summaryOut.suspicious_instructions.length > 0) {
    input.flags.add('possible_prompt_injection')
    for (const s of summaryOut.suspicious_instructions.slice(0, 5)) {
      input.issues.add({
        code: 'possible_prompt_injection',
        severity: 'warning',
        message: 'El documento contiene texto dirigido a un sistema automatizado; se ignoró.',
        page: input.text.validPage(s.page) ? s.page : null,
        details: { snippet: s.snippet.slice(0, 200) },
      })
    }
  }
}

export async function runSummaryPassStage(input: SummaryPassInput): Promise<SummaryPassResult> {
  const summaryPrompt = loadPrompt('extract_summary', { page_count: input.pdf.pageCount })
  const summaryOut = await requestSummaryWithRetries(input, summaryPrompt)

  if (summaryOut === null && input.outcome.providerDown !== null) {
    return { summary: null, fiscal: [], failureReason: input.outcome.providerDown }
  }
  if (summaryOut === null) {
    return { summary: null, fiscal: [], failureReason: 'no se obtuvo el resumen del documento (pasada 1)' }
  }

  flagSuspiciousSummary(summaryOut, input)
  const summary = assembleSummary(summaryOut, input.text)

  if (input.route === 'vision_only') {
    const read = await headerDoubleRead(input.deps, summaryOut, input.pdfInput, {
      text: input.text,
      model: input.plan.doubleRead,
      firstModel: input.plan.primary,
      system: input.system,
      instruction: summaryPrompt.text + input.visionNote,
      promptVersion: summaryPrompt.id,
      limit: input.opts.limit,
      record: input.record,
    })
    if (applyHeaderDoubleRead(read, summary, input.issues)) input.flags.add('header_double_read')
  }

  const fiscal = assembleFiscal(summaryOut.fiscal_documents, input.text, input.issues)
  if (fiscal.length > 0) input.flags.add('fiscal_document_present')
  if (summary.accounts.length > 1) input.flags.add('multi_account')
  if (summary.accounts.some((a) => a.periods.length > 1)) input.flags.add('multi_period')

  return { summary, fiscal, failureReason: null }
}

interface BlockContext {
  blockPages: number[]
  orderBase: number
  depth: number
  summary: AssembledSummary
  duplicatePages: Set<number>
  listing: string
  callChunk: ChunkCaller
  plan: ModelPlan
  extractionModel: string
  opts: ExtractOptions
  flags: Set<DocumentFlag>
  issues: IssueSink
  outcome: { partial: boolean; providerDown: string | null }
  progress: (m: string) => void
}

async function handleBlockFailure(ctx: BlockContext, err: unknown): Promise<PlacedRow[]> {
  const { blockPages, orderBase, depth, summary, duplicatePages, listing, callChunk, plan, extractionModel, opts, flags, issues, outcome, progress } = ctx
  const first = blockPages[0] ?? 1
  const last = blockPages.at(-1) ?? first

  if (err instanceof LlmCallError && err.code === 'max_tokens' && blockPages.length > 1) {
    const mid = Math.ceil(blockPages.length / 2)
    const [a, b] = await Promise.all([
      executeSingleBlock({ ...ctx, blockPages: blockPages.slice(0, mid), depth: depth + 1 }),
      executeSingleBlock({ ...ctx, blockPages: blockPages.slice(mid), orderBase: orderBase + 50_000, depth: depth + 1 }),
    ])
    return [...a, ...b]
  }
  if (outcome.providerDown !== null) return []
  if (depth === 0 && !(err instanceof LlmCallError && err.code === 'missing_api_key')) {
    return executeSingleBlock({ ...ctx, depth: depth + 1 })
  }
  if (depth === 1 && err instanceof LlmCallError && err.code === 'invalid_output' && plan.qualityFallback !== extractionModel) {
    try {
      progress(`bloque páginas ${String(first)}-${String(last)} con ${plan.qualityFallback}`)
      const prompt = loadPrompt('extract_transactions', { first_page: first, last_page: last, accounts: listing })
      const chunk = await callChunk('transactions', prompt.id, prompt.text, opts.transactionsEffort, blockPages, 32_000, plan.qualityFallback)
      flags.add('quality_fallback')
      return placeRows(chunk.transactions, blockPages, summary, orderBase, issues, duplicatePages)
    } catch {
      void 0
    }
  }
  outcome.partial = true
  issues.add({
    code: 'block_failed',
    severity: 'error',
    message: `No se pudieron extraer los movimientos de las páginas ${String(first)}-${String(last)}: ${errorText(err)}`,
    page: first,
    details: { pages: blockPages },
  })
  return []
}

async function executeSingleBlock(ctx: BlockContext): Promise<PlacedRow[]> {
  const { blockPages, orderBase, summary, duplicatePages, listing, callChunk, opts, issues, progress } = ctx
  const first = blockPages[0] ?? 1
  const last = blockPages.at(-1) ?? first
  const prompt = loadPrompt('extract_transactions', { first_page: first, last_page: last, accounts: listing })
  try {
    progress(`bloque páginas ${String(first)}-${String(last)}`)
    const chunk = await callChunk('transactions', prompt.id, prompt.text, opts.transactionsEffort, blockPages, 32_000)
    return placeRows(chunk.transactions, blockPages, summary, orderBase, issues, duplicatePages)
  } catch (caught) {
    return handleBlockFailure(ctx, caught)
  }
}

export async function extractTransactionBlocksStage(
  pages: number[],
  summary: AssembledSummary,
  duplicatePages: Set<number>,
  listing: string,
  callChunk: ChunkCaller,
  plan: ModelPlan,
  extractionModel: string,
  opts: ExtractOptions,
  flags: Set<DocumentFlag>,
  issues: IssueSink,
  outcome: { partial: boolean; providerDown: string | null },
  progress: (m: string) => void,
): Promise<PlacedRow[]> {
  const blocks = chunkPages(pages, Math.max(1, opts.blockPages))
  const blockResults = await Promise.all(
    blocks.map((b, i) =>
      executeSingleBlock({
        blockPages: b,
        orderBase: i * 100_000,
        depth: 0,
        summary,
        duplicatePages,
        listing,
        callChunk,
        plan,
        extractionModel,
        opts,
        flags,
        issues,
        outcome,
        progress,
      }),
    ),
  )
  return blockResults.flat()
}

function computeRowConfidence(
  balanceOk: boolean | null,
  onPage: boolean | null,
  reconciled: boolean,
): { ok: boolean; confidence: number } {
  const ok = balanceOk === true || (onPage === true && reconciled) || (onPage === null && reconciled)
  if (balanceOk === true && onPage !== false) return { ok: true, confidence: 1 }
  if (balanceOk === true) return { ok: true, confidence: 0.9 }
  if (ok) return { ok: true, confidence: 0.85 }
  if (onPage === true) return { ok: false, confidence: 0.6 }
  return { ok: false, confidence: 0.4 }
}

function verifyPeriodTransactions(
  txs: Transaction[],
  rec: PeriodReconciliation,
  text: PageText,
  conflictIds: Set<string>,
  missingOnPage: Map<number, number>,
): Transaction[] {
  const reconciled = rec.reconciliation.status === 'reconciled'
  const rowOk = new Map(rec.rows.map((r) => [r.transactionId, r.ok]))
  return txs.map((t) => {
    const balanceOk = rowOk.get(t.id) ?? null
    const onPage = text.usable ? text.amountOnPage(t.source.page, t.amount) : null
    if (onPage === false) missingOnPage.set(t.source.page, (missingOnPage.get(t.source.page) ?? 0) + 1)
    if (conflictIds.has(t.id)) return { ...t, verification: 'conflict' as const, confidence: 0.3 }
    const { ok, confidence } = computeRowConfidence(balanceOk, onPage, reconciled)
    return { ...t, verification: ok ? ('verified' as const) : ('unverified' as const), confidence }
  })
}

function finalizePeriodSummary(p: Period, reconciled: boolean): void {
  if (!reconciled) return
  for (const key of ['opening_balance', 'closing_balance', 'total_credits', 'total_debits'] as const) {
    const f = p.summary[key]
    if (f.value !== null && f.source !== null) {
      p.summary[key] = { ...f, verification: 'verified', confidence: 1 }
    }
  }
}

export function verifyAndFinalizePeriodsStage(
  summary: AssembledSummary,
  state: ReconciledState,
  text: PageText,
  conflictIds: Set<string>,
  retried: Set<number>,
  fiscal: FiscalDocument[],
  issues: IssueSink,
  flags: Set<DocumentFlag>,
): Map<string, Transaction[]> {
  const periodsTx = new Map<string, Transaction[]>()
  for (const acc of summary.accounts) {
    for (const p of acc.periods) {
      const txs = state.tx.get(p.id) ?? []
      const rec = state.recs.get(p.id) ?? reconcilePeriod(txs, printedOf(p))
      p.reconciliation = rec.reconciliation
      const missingOnPage = new Map<number, number>()
      const verified = verifyPeriodTransactions(txs, rec, text, conflictIds, missingOnPage)
      periodsTx.set(p.id, verified)
      reportPeriodIssues(p, rec, issues, missingOnPage, retried)
      checkDates(p, verified, issues)
      if (rec.reconciliation.status === 'not_reconciled') flags.add('reconciliation_failed')
      finalizePeriodSummary(p, rec.reconciliation.status === 'reconciled')
    }
    checkAccountFormats(acc, issues)
  }
  checkRfcField(summary.holder.rfc, issues)
  crossCheckFiscal(fiscal, summary.holder, summary.accounts.flatMap((a) => a.periods), issues)
  return periodsTx
}
