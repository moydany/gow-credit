/**
 * Extraction of one bank statement:
 *
 *   PDF → local text → classification → pass 1 (summary) → pass 2 (page blocks, in parallel,
 *   reading the document from cache) → arithmetic check →
 *   targeted retry and double read of the pages that break the balance → per-value
 *   verification → valid StatementExtraction.
 *
 * Never throws: on any failure it returns a valid extraction with a partial or failed `status`,
 * issues and flags, so new documents never crash it.
 */
import { readFile } from 'node:fs/promises'
import {
  PDF_PASSWORD_FAILURE,
  PDF_UNREADABLE_PREFIX,
  type DocumentFlag,
  type DocumentType,
  type FiscalDocument,
  type ModelCall,
  type StatementExtraction,
} from '@gow/contracts'
import { loadPrompt, readGoogleEnv } from '@gow/llm'
import { type AssembledSummary } from './assemble.ts'
import {
  build,
  buildFailedExtraction,
  finalizeFailed,
  repairAgainstContract,
} from './extract-build.ts'
import {
  classifyDocumentStage,
  errorText,
  extractTransactionBlocksStage,
  reconcileAndRetryStage,
  runSummaryPassStage,
  verifyAndFinalizePeriodsStage,
  type ChunkCaller,
} from './extract-stages.ts'
import {
  DEFAULT_OPTIONS,
  type CallRecorder,
  type Classified,
  type ExtractDeps,
  type ExtractOptions,
} from './extract-types.ts'
import { IssueSink } from './issues.ts'
import { ExtractionChunk, EXTRACTION_SCHEMA_NAME } from './llm-schema.ts'
import { PageText } from './page-text.ts'
import {
  isPdfPasswordError,
  loadPdf,
  multipleStatementsReason,
  reportFiscalStatements,
  reportPageChecks,
  type LoadedPdf,
} from './pdf.ts'
import { isProviderFailure, planModels, supportsServerFallback, type ModelPlan } from './router.ts'

export type { Classified, ExtractDeps, ExtractOptions }
export { DEFAULT_OPTIONS, repairAgainstContract }

function accountsListing(s: AssembledSummary): string {
  return s.periods
    .map(
      (p) =>
        `- account_ref ${p.accountRef}, period_ref ${p.periodRef}: ${p.label}${
          p.movementPages.length ? `, movimientos en páginas ${p.movementPages.join(', ')}` : ''
        }`,
    )
    .join('\n')
}

function resolveExtractionPages(
  pageCount: number,
  periods: AssembledSummary['periods'],
  duplicatePages: Set<number>,
): number[] {
  const allPages = Array.from({ length: pageCount }, (_, i) => i + 1)
  const movementPages = [...new Set(periods.flatMap((p) => p.movementPages))].sort((a, b) => a - b)
  return (movementPages.length > 0 ? movementPages : allPages).filter((p) => !duplicatePages.has(p))
}

function initProviderFallbackNotes(
  opts: ExtractOptions,
  plan: ModelPlan,
  calls: ModelCall[],
  flags: Set<DocumentFlag>,
  issues: IssueSink,
): void {
  if (opts.providerFallback) {
    calls.push(...opts.providerFallback.calls)
    flags.add('provider_fallback')
    issues.add({
      code: 'block_failed',
      severity: 'warning',
      message: `Falló el proveedor de ${opts.providerFallback.from} (${opts.providerFallback.reason}); el documento se extrajo completo con ${plan.primary}.`,
    })
  } else if (plan.note) {
    issues.add({ code: 'block_failed', severity: 'info', message: `Router: ${plan.note}.` })
  }
}

async function loadAndCheckPdf(
  path: string,
  started: Date,
  issues: IssueSink,
  flags: Set<DocumentFlag>,
): Promise<{ pdf: LoadedPdf; text: PageText; route: 'text_and_vision' | 'vision_only' } | { failure: StatementExtraction }> {
  let pdf: LoadedPdf
  try {
    pdf = await loadPdf(path)
  } catch (err) {
    const bytes = await readFile(path).catch(() => Buffer.alloc(0))
    return {
      failure: finalizeFailed(
        path,
        bytes,
        started,
        isPdfPasswordError(err) ? PDF_PASSWORD_FAILURE : `${PDF_UNREADABLE_PREFIX}: ${errorText(err)}`,
      ),
    }
  }
  const text = new PageText(pdf)
  const route = pdf.textLayer === 'corrupt' || pdf.textLayer === 'absent' ? 'vision_only' : 'text_and_vision'
  if (route === 'vision_only') flags.add('vision_only')
  if (pdf.textLayer === 'corrupt') {
    issues.add({
      code: 'page_unreadable',
      severity: 'info',
      message: pdf.textRepaired
        ? 'La capa de texto venía en EBCDIC; se decodificó para verificar montos. El modelo lee las imágenes.'
        : 'La capa de texto está corrupta; la extracción va por visión y la verificación queda en la aritmética. Sin texto no se puede saber si las páginas vienen giradas ni leer su numeración impresa.',
    })
  }
  return { pdf, text, route }
}

function createRecorder(calls: ModelCall[]): CallRecorder {
  return (purpose, prompt, effort, pages, r) => {
    calls.push({
      purpose,
      model: r.model,
      prompt,
      effort,
      pages,
      usage: r.usage,
      cost_usd: r.costUsd,
      latency_ms: r.latencyMs,
      response_cache_hit: r.responseCacheHit,
    })
  }
}

function createExtractorChunkCaller(
  deps: ExtractDeps,
  opts: ExtractOptions,
  pdfInput: { base64: string; sha256: string; cache: boolean },
  system: string,
  visionNote: string,
  plan: ModelPlan,
  record: CallRecorder,
  outcome: { partial: boolean; providerDown: string | null },
): ChunkCaller {
  return async (purpose, promptId, instruction, effort, pages, maxOutputTokens, model = plan.primary) => {
    const res = await opts.limit(() =>
      deps.llm.call({
        purpose,
        model,
        system,
        document: pdfInput,
        instruction: instruction + visionNote,
        schema: ExtractionChunk,
        schemaName: EXTRACTION_SCHEMA_NAME,
        promptVersion: promptId,
        effort,
        maxOutputTokens,
        serverFallback: supportsServerFallback(model),
      }),
    ).catch((err: unknown) => {
      if (isProviderFailure(err, model, plan)) outcome.providerDown = errorText(err)
      throw err
    })
    record(purpose, promptId, effort, pages, res)
    return res.object
  }
}

function checkNonStatementEarly(
  classified: Classified | null,
  opts: ExtractOptions,
  documentType: DocumentType,
  classConfidence: number,
  plan: ModelPlan,
  pdf: LoadedPdf,
  route: 'text_and_vision' | 'vision_only',
  started: Date,
  classifierBank: string | null,
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean },
  issues: IssueSink,
  flags: Set<DocumentFlag>,
  calls: ModelCall[],
): StatementExtraction | null {
  if (
    classified &&
    opts.rejectNotStatementAbove !== undefined &&
    documentType !== 'bank_statement' &&
    classConfidence >= opts.rejectNotStatementAbove
  ) {
    flags.add('not_a_bank_statement')
    issues.add({
      code: 'block_failed',
      severity: 'info',
      message: `El clasificador lo marcó como ${documentType} con confianza ${classConfidence.toFixed(2)}; no se extrajo.`,
    })
    return buildFailedExtraction({
      extractionModel: plan.primary,
      pdf,
      route,
      started,
      documentType,
      classConfidence,
      classifierBank,
      classifier,
      issues,
      flags,
      calls,
      failureReason: `no es un estado de cuenta bancario (${documentType}); no se extrajo`,
    })
  }
  return null
}

interface PipelineInput {
  deps: ExtractDeps
  opts: ExtractOptions
  pdf: LoadedPdf
  pdfInput: { base64: string; sha256: string; cache: boolean }
  text: PageText
  route: 'text_and_vision' | 'vision_only'
  pageChecks: ReturnType<typeof reportPageChecks>
  duplicatePages: Set<number>
  plan: ModelPlan
  documentType: DocumentType
  classConfidence: number
  classifierBank: string | null
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean }
  started: Date
  issues: IssueSink
  flags: Set<DocumentFlag>
  calls: ModelCall[]
  outcome: { partial: boolean; providerDown: string | null }
  record: CallRecorder
  fallBackToOtherProvider: (reason: string) => Promise<StatementExtraction>
}

async function extractTransactionsAndPeriods(
  input: PipelineInput,
  summary: AssembledSummary,
  fiscal: FiscalDocument[],
  callChunk: ChunkCaller,
  progress: (m: string) => void,
): Promise<StatementExtraction> {
  const { pdf, text, duplicatePages, plan, opts, flags, issues, outcome, started, documentType, classConfidence, classifierBank, classifier, calls, route } = input
  const extractionModel = plan.primary
  const pages = resolveExtractionPages(pdf.pageCount, summary.periods, duplicatePages)
  const placedRows = await extractTransactionBlocksStage(
    pages,
    summary,
    duplicatePages,
    accountsListing(summary),
    callChunk,
    plan,
    extractionModel,
    opts,
    flags,
    issues,
    outcome,
    progress,
  )
  if (outcome.providerDown !== null) return input.fallBackToOtherProvider(outcome.providerDown)

  const reconciledResult = await reconcileAndRetryStage(
    placedRows,
    summary,
    duplicatePages,
    accountsListing(summary),
    callChunk,
    plan,
    opts,
    issues,
    progress,
  )

  const periodsTx = verifyAndFinalizePeriodsStage(
    summary,
    reconciledResult.state,
    text,
    reconciledResult.conflictIds,
    reconciledResult.retried,
    fiscal,
    issues,
    flags,
  )
  if (outcome.partial) flags.add('partial_extraction')

  return build({
    extractionModel,
    pdf,
    route,
    started,
    documentType,
    classConfidence,
    classifierBank,
    classifier,
    summary,
    fiscal,
    periodsTx,
    issues,
    flags,
    calls,
    failureReason: null,
    status: outcome.partial ? 'partial' : 'complete',
  })
}

async function executeExtractionPipeline(input: PipelineInput): Promise<StatementExtraction> {
  const { deps, opts, pdf, pdfInput, text, route, pageChecks, plan, started, issues, flags, calls, outcome, record, fallBackToOtherProvider, documentType, classConfidence, classifierBank, classifier } = input
  const system = loadPrompt('extract_system').text
  const extractionModel = plan.primary
  const visionNote = route === 'vision_only' ? '\n\nLa capa de texto de este PDF está corrupta: lee las imágenes de las páginas.' : ''
  const callChunk = createExtractorChunkCaller(deps, opts, pdfInput, system, visionNote, plan, record, outcome)
  const progress = (m: string) => opts.onProgress?.(m)

  const summaryPass = await runSummaryPassStage({
    callChunk,
    pdf,
    pdfInput,
    deps,
    plan,
    route,
    system,
    visionNote,
    text,
    opts,
    flags,
    issues,
    outcome,
    record,
    progress,
    documentType,
    classConfidence,
  })

  if (summaryPass.summary === null) {
    if (outcome.providerDown !== null) return fallBackToOtherProvider(outcome.providerDown)
    return buildFailedExtraction({
      extractionModel,
      pdf,
      route,
      started,
      documentType,
      classConfidence,
      classifierBank,
      classifier,
      issues,
      flags,
      calls,
      failureReason: summaryPass.failureReason,
    })
  }

  const { summary, fiscal } = summaryPass
  const byCfdi = pageChecks.paginated ? null : reportFiscalStatements(fiscal, issues, flags)
  if (byCfdi && opts.rejectMultipleStatements) {
    return buildFailedExtraction({
      extractionModel,
      pdf,
      route,
      started,
      documentType,
      classConfidence,
      classifierBank,
      classifier,
      issues,
      flags,
      calls,
      failureReason: multipleStatementsReason(byCfdi.documents),
    })
  }

  return extractTransactionsAndPeriods(input, summary, fiscal, callChunk, progress)
}

async function loadAndPreparePdf(
  path: string,
  started: Date,
  issues: IssueSink,
  flags: Set<DocumentFlag>,
): Promise<
  | { failure: StatementExtraction }
  | {
      pdf: LoadedPdf
      text: PageText
      route: 'text_and_vision' | 'vision_only'
      pdfInput: { base64: string; sha256: string; cache: boolean }
      pageChecks: ReturnType<typeof reportPageChecks>
      duplicatePages: Set<number>
    }
> {
  const loaded = await loadAndCheckPdf(path, started, issues, flags)
  if ('failure' in loaded) return loaded
  const { pdf, text, route } = loaded
  const pdfInput = { base64: pdf.base64, sha256: pdf.sha256, cache: true }
  const pageChecks = reportPageChecks(pdf, issues, flags)
  const duplicatePages = new Set(pdf.duplicatePages)
  return { pdf, text, route, pdfInput, pageChecks, duplicatePages }
}

function checkMultipleStatementsEarly(
  opts: ExtractOptions,
  pageChecks: ReturnType<typeof reportPageChecks>,
  plan: ModelPlan,
  pdf: LoadedPdf,
  route: 'text_and_vision' | 'vision_only',
  started: Date,
  issues: IssueSink,
  flags: Set<DocumentFlag>,
  calls: ModelCall[],
): StatementExtraction | null {
  if (opts.rejectMultipleStatements && pageChecks.statements.documents > 1) {
    return buildFailedExtraction({
      extractionModel: plan.primary,
      pdf,
      route,
      started,
      documentType: 'other',
      classConfidence: 0,
      classifierBank: null,
      classifier: { implementation: 'claude', model: 'none', fallback: true },
      issues,
      flags,
      calls,
      failureReason: multipleStatementsReason(pageChecks.statements.documents),
    })
  }
  return null
}

export async function extractStatement(
  path: string,
  deps: ExtractDeps,
  opts: ExtractOptions,
): Promise<StatementExtraction> {
  const started = new Date()
  const issues = new IssueSink()
  const calls: ModelCall[] = []
  const flags = new Set<DocumentFlag>()
  const outcome = { partial: false, providerDown: null as string | null }
  const plan = planModels({
    requested: opts.extractionModel,
    googleAvailable: opts.googleAvailable ?? readGoogleEnv().apiKey !== null,
    retryEffort: opts.retryEffort,
  })

  initProviderFallbackNotes(opts, plan, calls, flags, issues)

  let classified: Classified | null = null
  const fallBackToOtherProvider = (reason: string) =>
    extractStatement(path, deps, {
      ...opts,
      extractionModel: plan.providerFallback,
      providerFallback: { calls, from: plan.primary, reason, classification: classified },
    })

  const prepared = await loadAndPreparePdf(path, started, issues, flags)
  if ('failure' in prepared) return prepared.failure
  const { pdf, text, route, pdfInput, pageChecks, duplicatePages } = prepared

  const multiCut = checkMultipleStatementsEarly(opts, pageChecks, plan, pdf, route, started, issues, flags, calls)
  if (multiCut) return multiCut

  const record = createRecorder(calls)
  const classificationRes = await classifyDocumentStage(
    pdf,
    pdfInput,
    deps,
    opts,
    opts.providerFallback?.classification ?? null,
    flags,
    issues,
    record,
  )
  const { documentType, classConfidence, classifierBank, classifier } = classificationRes
  classified = classificationRes.classified

  const earlyCut = checkNonStatementEarly(
    classified,
    opts,
    documentType,
    classConfidence,
    plan,
    pdf,
    route,
    started,
    classifierBank,
    classifier,
    issues,
    flags,
    calls,
  )
  if (earlyCut) return earlyCut

  return executeExtractionPipeline({
    deps,
    opts,
    pdf,
    pdfInput,
    text,
    route,
    pageChecks,
    duplicatePages,
    plan,
    documentType,
    classConfidence,
    classifierBank,
    classifier,
    started,
    issues,
    flags,
    calls,
    outcome,
    record,
    fallBackToOtherProvider,
  })
}
