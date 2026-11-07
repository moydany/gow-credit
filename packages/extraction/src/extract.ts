/**
 * Extracción de un estado de cuenta (docs/02 §2, docs/04 §2-3, docs/07 I):
 *
 *   PDF → texto local → clasificación → pasada 1 (resumen) → pasada 2 (bloques de páginas,
 *   en paralelo, leyendo el documento de la caché) → verificación aritmética →
 *   reintento dirigido y doble lectura de las páginas que rompen el saldo → verificación de
 *   cada valor → StatementExtraction válida.
 *
 * Nunca lanza: ante cualquier falla devuelve una extracción válida con `status` parcial o
 * fallida, issues y banderas (prioridad del brief: no crashear sobre documentos nuevos).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  PDF_PASSWORD_FAILURE,
  PDF_UNREADABLE_PREFIX,
  STATEMENT_SCHEMA_VERSION,
  StatementExtraction,
  type DocumentFlag,
  type DocumentType,
  type FiscalDocument,
  type ModelCall,
  type TokenUsage,
  type Transaction,
} from '@gow/contracts'
import { addUsage, EXTRACTION_MODEL, LlmCallError, loadPrompt, readGoogleEnv, ZERO_USAGE, type Classifier, type Effort, type Limiter, type StructuredLlm } from '@gow/llm'
import { assembleSummary, materialize, placeRows, type AssembledSummary, type PlacedRow } from './assemble.ts'
import { applyHeaderDoubleRead, headerDoubleRead } from './double-read.ts'
import { assembleFiscal, crossCheckFiscal } from './fiscal.ts'
import { IssueSink } from './issues.ts'
import { ExtractionChunk, EXTRACTION_SCHEMA_NAME, type SummaryOut } from './llm-schema.ts'
import { PageText, textUsable } from './page-text.ts'
import { checkAccountFormats, checkDates, checkRfcField, reportPeriodIssues } from './period-checks.ts'
import { isPdfPasswordError, loadPdf, multipleStatementsReason, reportFiscalStatements, reportPageChecks, type LoadedPdf } from './pdf.ts'
import { pagesWithBreaks, printedOf, reconcilePeriod, reconciliationScore, type PeriodReconciliation } from './reconcile.ts'
import { isProviderFailure, planModels, supportsServerFallback, type ModelPlan } from './router.ts'

export interface ExtractOptions {
  /** Fuerza el modelo principal (experimentos). Sin él decide el router (ADR 0011). */
  extractionModel?: string
  /** Si hay llave de Google; por defecto se lee del entorno. */
  googleAvailable?: boolean
  /** Interno: llamadas y motivo de una corrida anterior que cayó por falla del proveedor. */
  providerFallback?: { calls: ModelCall[]; from: string; reason: string; classification: Classified | null }
  blockPages: number
  summaryEffort: Effort
  transactionsEffort: Effort
  retryEffort: Effort
  /** Tope de páginas que se releen por documento (costo acotado). */
  maxRetryPages: number
  limit: Limiter
  onProgress?: (message: string) => void
  /**
   * Solo el modo full (ADR 0002 y 0042): si el clasificador dice que no es un estado de cuenta
   * bancario con al menos esta confianza, no se extrae. Sin él (standalone, `evaluate`), la
   * clasificación etiqueta y no bloquea.
   */
  rejectNotStatementAbove?: number
  /**
   * Solo el modo full (ADR 0057, como el corte de ADR 0042): un PDF con más de un estado de cuenta no se
   * extrae; falla con `multipleStatementsReason`. Sin él (standalone, `evaluate`) se extrae igual y la
   * bandera `multiple_statements` queda.
   */
  rejectMultipleStatements?: boolean
}

interface Classified {
  documentType: DocumentType
  classConfidence: number
  classifierBank: string | null
  classifier: { implementation: 'jev' | 'claude'; model: string; fallback: boolean }
  flags: DocumentFlag[]
}

export interface ExtractDeps {
  llm: StructuredLlm
  classifier: Classifier
}

export const DEFAULT_OPTIONS = {
  blockPages: 4,
  summaryEffort: 'medium',
  transactionsEffort: 'low',
  retryEffort: 'high',
  maxRetryPages: 4,
} as const satisfies Partial<ExtractOptions>

function chunkPages(pages: readonly number[], size: number): number[][] {
  const blocks: number[][] = []
  for (let i = 0; i < pages.length; i += size) blocks.push(pages.slice(i, i + size))
  return blocks
}

function errorText(err: unknown): string {
  if (err instanceof LlmCallError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message.split('\n')[0] ?? 'error' : String(err)
}

function accountsListing(s: AssembledSummary): string {
  return s.periods.map((p) => `- account_ref ${p.accountRef}, period_ref ${p.periodRef}: ${p.label}${p.movementPages.length ? `, movimientos en páginas ${p.movementPages.join(', ')}` : ''}`).join('\n')
}

export async function extractStatement(path: string, deps: ExtractDeps, opts: ExtractOptions): Promise<StatementExtraction> {
  const started = new Date()
  const issues = new IssueSink()
  const calls: ModelCall[] = []
  const flags = new Set<DocumentFlag>()
  const progress = (m: string) => opts.onProgress?.(m)
  let failureReason: string | null = null
  // Objeto mutable: se marca desde los bloques en paralelo (closures).
  const outcome = { partial: false, providerDown: null as string | null }
  const plan: ModelPlan = planModels({ requested: opts.extractionModel, googleAvailable: opts.googleAvailable ?? readGoogleEnv().apiKey !== null, retryEffort: opts.retryEffort })
  if (opts.providerFallback) {
    calls.push(...opts.providerFallback.calls)
    flags.add('provider_fallback')
    issues.add({ code: 'block_failed', severity: 'warning', message: `Falló el proveedor de ${opts.providerFallback.from} (${opts.providerFallback.reason}); el documento se extrajo completo con ${plan.primary}.` })
  } else if (plan.note) {
    issues.add({ code: 'block_failed', severity: 'info', message: `Router: ${plan.note}.` })
  }
  /** Repite el documento entero con el modelo de emergencia del otro proveedor. */
  const fallBackToOtherProvider = (reason: string) =>
    extractStatement(path, deps, {
      ...opts,
      extractionModel: plan.providerFallback,
      providerFallback: { calls, from: plan.primary, reason, classification: classified },
    })

  // ---------- PDF y texto local
  let pdf: LoadedPdf
  try {
    pdf = await loadPdf(path)
  } catch (err) {
    const bytes = await readFile(path).catch(() => Buffer.alloc(0))
    // Un PDF con contraseña de apertura falla con su motivo propio (ADR 0049).
    return finalizeFailed(path, bytes, started, isPdfPasswordError(err) ? PDF_PASSWORD_FAILURE : `${PDF_UNREADABLE_PREFIX}: ${errorText(err)}`)
  }
  const text = new PageText(pdf)
  const route = pdf.textLayer === 'corrupt' || pdf.textLayer === 'absent' ? 'vision_only' : 'text_and_vision'
  if (route === 'vision_only') flags.add('vision_only')
  if (pdf.textLayer === 'corrupt') {
    issues.add({ code: 'page_unreadable', severity: 'info', message: pdf.textRepaired ? 'La capa de texto venía en EBCDIC; se decodificó para verificar montos. El modelo lee las imágenes.' : 'La capa de texto está corrupta; la extracción va por visión y la verificación queda en la aritmética. Sin texto no se puede saber si las páginas vienen giradas ni leer su numeración impresa.' })
  }
  const pdfInput = { base64: pdf.base64, sha256: pdf.sha256, cache: true }

  // ---------- Paginación, páginas repetidas y giradas (ADR 0057). Gratis: sin modelos.
  const pageChecks = reportPageChecks(pdf, issues, flags)
  const duplicatePages = new Set(pdf.duplicatePages)
  if (opts.rejectMultipleStatements && pageChecks.statements.documents > 1) {
    return build({ extractionModel: plan.primary, pdf, route, started, documentType: 'other', classConfidence: 0, classifierBank: null, classifier: { implementation: 'claude', model: 'none', fallback: true }, summary: null, fiscal: [], periodsTx: new Map(), issues, flags, calls, failureReason: multipleStatementsReason(pageChecks.statements.documents), status: 'failed' })
  }

  const record = (purpose: string, prompt: string | null, effort: Effort | null, pages: number[], r: { model: string; usage: TokenUsage; costUsd: number; latencyMs: number; responseCacheHit: boolean }) => {
    calls.push({ purpose, model: r.model, prompt, effort, pages, usage: r.usage, cost_usd: r.costUsd, latency_ms: r.latencyMs, response_cache_hit: r.responseCacheHit })
  }

  // ---------- Clasificación (etiqueta, no bloquea: ADR 0002)
  let documentType: DocumentType = 'other'
  let classConfidence = 0
  let classifierBank: string | null = null
  let classifier = { implementation: 'claude' as 'jev' | 'claude', model: 'none', fallback: true }
  let classified: Classified | null = null
  const inherited = opts.providerFallback?.classification ?? null
  if (inherited) {
    // Repetición por falla del proveedor: la clasificación ya se hizo y se pagó.
    ;({ documentType, classConfidence, classifierBank, classifier } = inherited)
    for (const f of inherited.flags) flags.add(f)
    classified = inherited
  } else try {
    const sample = textUsable(pdf) ? pdf.pageTexts.slice(0, 2).join('\n').slice(0, 6000) : null
    const c = await opts.limit(() => deps.classifier.classify({ textSample: sample, pdf: { ...pdfInput, cache: false } }))
    documentType = c.documentType
    classConfidence = c.confidence
    classifierBank = c.bank === 'other' ? null : c.bank
    classifier = { implementation: c.implementation, model: c.model, fallback: c.fallback }
    if (c.fallback) flags.add('classifier_fallback')
    if (c.containsInstructionsToAi) flags.add('possible_prompt_injection')
    record('classify', c.promptId, c.implementation === 'claude' ? 'low' : null, [], c)
    classified = { documentType, classConfidence, classifierBank, classifier, flags: [...flags].filter((f) => f === 'classifier_fallback' || f === 'possible_prompt_injection') }
  } catch (err) {
    issues.add({ code: 'block_failed', severity: 'warning', message: `Falló la clasificación (${errorText(err)}); se continúa con la extracción.` })
  }

  // ---------- Corte temprano del modo full (ADR 0002 y 0042): un documento que con seguridad no es
  // estado de cuenta no se extrae. Sin clasificación (falló) siempre se extrae.
  if (classified && opts.rejectNotStatementAbove !== undefined && documentType !== 'bank_statement' && classConfidence >= opts.rejectNotStatementAbove) {
    flags.add('not_a_bank_statement')
    issues.add({ code: 'block_failed', severity: 'info', message: `El clasificador lo marcó como ${documentType} con confianza ${classConfidence.toFixed(2)}; no se extrajo.` })
    return build({ extractionModel: plan.primary, pdf, route, started, documentType, classConfidence, classifierBank, classifier, summary: null, fiscal: [], periodsTx: new Map(), issues, flags, calls, failureReason: `no es un estado de cuenta bancario (${documentType}); no se extrajo`, status: 'failed' })
  }

  // ---------- Pasada 1
  const system = loadPrompt('extract_system').text
  const extractionModel = plan.primary
  const visionNote = route === 'vision_only' ? '\n\nLa capa de texto de este PDF está corrupta: lee las imágenes de las páginas.' : ''
  const callChunk = async (purpose: string, promptId: string, instruction: string, effort: Effort, pages: number[], maxOutputTokens: number, model: string = extractionModel) => {
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

  const summaryPrompt = loadPrompt('extract_summary', { page_count: pdf.pageCount })
  let summaryOut: SummaryOut | null = null
  for (let attempt = 1; attempt <= 2 && summaryOut === null; attempt++) {
    try {
      progress(`pasada 1 (intento ${String(attempt)})`)
      summaryOut = (await callChunk('summary', summaryPrompt.id, summaryPrompt.text, opts.summaryEffort, [], 16_000)).summary
      if (summaryOut === null) issues.add({ code: 'block_failed', severity: 'warning', message: 'La pasada 1 no devolvió resumen.' })
    } catch (err) {
      issues.add({ code: 'block_failed', severity: attempt === 2 ? 'error' : 'warning', message: `Falló la pasada 1 (intento ${String(attempt)}): ${errorText(err)}` })
      if (err instanceof LlmCallError && err.code === 'missing_api_key') break
    }
  }
  if (summaryOut === null && outcome.providerDown !== null) return fallBackToOtherProvider(outcome.providerDown)
  if (summaryOut === null) {
    failureReason = 'no se obtuvo el resumen del documento (pasada 1)'
    return build({ extractionModel, pdf, route, started, documentType, classConfidence, classifierBank, classifier, summary: null, fiscal: [], periodsTx: new Map(), issues, flags, calls, failureReason, status: 'failed' })
  }
  if (summaryOut.document_kind !== 'bank_statement' || (documentType !== 'bank_statement' && classConfidence >= 0.7)) {
    flags.add('not_a_bank_statement')
    issues.add({ code: 'not_a_bank_statement', severity: 'warning', message: `El documento no parece un estado de cuenta bancario (clasificador: ${documentType}; extractor: ${summaryOut.document_kind}). Se extrae igual y no se calcula perfil.` })
  }
  if (summaryOut.suspicious_instructions.length > 0) {
    flags.add('possible_prompt_injection')
    for (const s of summaryOut.suspicious_instructions.slice(0, 5)) {
      issues.add({ code: 'possible_prompt_injection', severity: 'warning', message: 'El documento contiene texto dirigido a un sistema automatizado; se ignoró.', page: text.validPage(s.page) ? s.page : null, details: { snippet: s.snippet.slice(0, 200) } })
    }
  }
  const summary = assembleSummary(summaryOut, text)
  // Sin texto local no hay contra qué verificar el encabezado: lo relee la otra familia (docs/04 §3.6, ADR 0011).
  if (route === 'vision_only') {
    const read = await headerDoubleRead(deps, summaryOut, pdfInput, { text, model: plan.doubleRead, firstModel: extractionModel, system, instruction: summaryPrompt.text + visionNote, promptVersion: summaryPrompt.id, limit: opts.limit, record })
    if (applyHeaderDoubleRead(read, summary, issues)) flags.add('header_double_read')
  }
  const fiscal = assembleFiscal(summaryOut.fiscal_documents, text, issues)
  if (fiscal.length > 0) flags.add('fiscal_document_present')
  if (summary.accounts.length > 1) flags.add('multi_account')
  if (summary.accounts.some((a) => a.periods.length > 1)) flags.add('multi_period')
  // Sin numeración impresa que lo diga, los CFDI de ingreso timbrados en días distintos son varios estados (ADR 0057).
  const byCfdi = pageChecks.paginated ? null : reportFiscalStatements(fiscal, issues, flags)
  if (byCfdi && opts.rejectMultipleStatements) {
    return build({ extractionModel, pdf, route, started, documentType, classConfidence, classifierBank, classifier, summary: null, fiscal: [], periodsTx: new Map(), issues, flags, calls, failureReason: multipleStatementsReason(byCfdi.documents), status: 'failed' })
  }

  // ---------- Pasada 2 por bloques (después de la pasada 1: la caché ya está escrita)
  const allPages = Array.from({ length: pdf.pageCount }, (_, i) => i + 1)
  const movementPages = [...new Set(summary.periods.flatMap((p) => p.movementPages))].sort((a, b) => a - b)
  // Una página repetida no se extrae otra vez (sus filas se descartan de todos modos en `placeRows`).
  const pages = (movementPages.length > 0 ? movementPages : allPages).filter((p) => !duplicatePages.has(p))
  const listing = accountsListing(summary)

  const runBlock = async (blockPages: number[], orderBase: number, depth = 0): Promise<PlacedRow[]> => {
    const first = blockPages[0] ?? 1
    const last = blockPages.at(-1) ?? first
    const prompt = loadPrompt('extract_transactions', { first_page: first, last_page: last, accounts: listing })
    try {
      progress(`bloque páginas ${String(first)}-${String(last)}`)
      const chunk = await callChunk('transactions', prompt.id, prompt.text, opts.transactionsEffort, blockPages, 32_000)
      return placeRows(chunk.transactions, blockPages, summary, orderBase, issues, duplicatePages)
    } catch (caught) {
      let err = caught
      // Si se cortó por longitud, se parte el bloque; si no, un reintento y luego salida parcial.
      if (err instanceof LlmCallError && err.code === 'max_tokens' && blockPages.length > 1) {
        const mid = Math.ceil(blockPages.length / 2)
        const [a, b] = await Promise.all([runBlock(blockPages.slice(0, mid), orderBase, depth + 1), runBlock(blockPages.slice(mid), orderBase + 50_000, depth + 1)])
        return [...a, ...b]
      }
      if (outcome.providerDown !== null) return []
      if (depth === 0 && !(err instanceof LlmCallError && err.code === 'missing_api_key')) return runBlock(blockPages, orderBase, depth + 1)
      // Dos salidas inválidas seguidas: falla de calidad, el bloque se repite con el modelo de emergencia.
      if (depth === 1 && err instanceof LlmCallError && err.code === 'invalid_output' && plan.qualityFallback !== extractionModel) {
        try {
          progress(`bloque páginas ${String(first)}-${String(last)} con ${plan.qualityFallback}`)
          const chunk = await callChunk('transactions', prompt.id, prompt.text, opts.transactionsEffort, blockPages, 32_000, plan.qualityFallback)
          flags.add('quality_fallback')
          return placeRows(chunk.transactions, blockPages, summary, orderBase, issues, duplicatePages)
        } catch (err2) {
          err = err2
        }
      }
      outcome.partial = true
      issues.add({ code: 'block_failed', severity: 'error', message: `No se pudieron extraer los movimientos de las páginas ${String(first)}-${String(last)}: ${errorText(err)}`, page: first, details: { pages: blockPages } })
      return []
    }
  }
  const blocks = chunkPages(pages, Math.max(1, opts.blockPages))
  const blockResults = await Promise.all(blocks.map((b, i) => runBlock(b, i * 100_000)))
  if (outcome.providerDown !== null) return fallBackToOtherProvider(outcome.providerDown)
  let placed = blockResults.flat()

  // ---------- Verificación aritmética y reintento dirigido
  const reconcileAll = (rows: PlacedRow[]) => {
    const tx = materialize(rows)
    const recs = new Map<string, PeriodReconciliation>()
    for (const acc of summary.accounts) for (const p of acc.periods) recs.set(p.id, reconcilePeriod(tx.get(p.id) ?? [], printedOf(p)))
    return { tx, recs }
  }
  let state = reconcileAll(placed)
  const conflictIds = new Set<string>()
  const retried = new Set<number>()
  const problems = new Map<number, string>()
  for (const acc of summary.accounts)
    for (const p of acc.periods) {
      const rec = state.recs.get(p.id)?.reconciliation
      if (!rec || rec.status !== 'not_reconciled') continue
      const broken = pagesWithBreaks(rec)
      const meta = summary.periods.find((m) => m.id === p.id)
      // Sin saldo por fila no se puede localizar: se relee solo si el periodo es corto.
      const candidates = (broken.length > 0 ? broken : (meta?.movementPages.length ?? 99) <= 2 ? (meta?.movementPages ?? []) : []).filter((page) => !duplicatePages.has(page))
      for (const page of candidates) {
        const b = rec.running_balance?.breaks.filter((x) => x.page === page) ?? []
        const why = b.length > 0
          ? `en ${String(b.length)} filas el saldo impreso no coincide con el saldo anterior más o menos el monto (por ejemplo, se esperaba ${String(b[0]?.expected_balance)} y está impreso ${String(b[0]?.printed_balance)}).`
          : `la suma de los movimientos no cuadra con los totales del periodo (diferencia de abonos ${String(rec.totals.credits.difference)}, de cargos ${String(rec.totals.debits.difference)}).`
        if (!problems.has(page)) problems.set(page, why)
      }
    }
  for (const [page, problem] of [...problems.entries()].slice(0, opts.maxRetryPages)) {
    retried.add(page)
    const prompt = loadPrompt('extract_retry_page', { page, accounts: listing, problem })
    try {
      progress(`relectura página ${String(page)}`)
      // Doble lectura con otra familia de modelos (ADR 0011): menos sesgos compartidos.
      const chunk = await callChunk('retry_page', prompt.id, prompt.text, opts.retryEffort, [page], 32_000, plan.doubleRead)
      const firstOrder = placed.find((r) => r.tx.source.page === page)?.order ?? page * 1000
      const fresh = placeRows(chunk.transactions, [page], summary, firstOrder, issues, duplicatePages)
      const candidate = [...placed.filter((r) => r.tx.source.page !== page), ...fresh]
      const next = reconcileAll(candidate)
      const affected = new Set([...placed, ...fresh].filter((r) => r.tx.source.page === page).map((r) => r.periodId))
      const score = (s: typeof state) => [...affected].reduce((acc, id) => acc + reconciliationScore(s.recs.get(id)?.reconciliation ?? emptyRec()), 0)
      const before = score(state)
      const after = score(next)
      const disagree = differs(placed.filter((r) => r.tx.source.page === page), fresh)
      if (after < before) {
        placed = candidate
        state = next
        issues.add({ code: 'double_read_conflict', severity: 'info', message: `La relectura de la página ${String(page)} mejoró el cuadre; se usó la segunda lectura.`, page })
      }
      // Doble lectura: si las dos lecturas difieren y la página sigue sin cuadrar, sus filas quedan en conflicto.
      const stillBroken = [...affected].some((id) => (state.recs.get(id)?.reconciliation.running_balance?.breaks ?? []).some((b) => b.page === page))
      if (disagree && stillBroken) {
        for (const [, list] of state.tx) for (const t of list) if (t.source.page === page) conflictIds.add(t.id)
        issues.add({ code: 'double_read_conflict', severity: 'warning', message: `Dos lecturas de la página ${String(page)} no coinciden y ninguna cuadra; sus movimientos quedan en conflicto.`, page })
      }
    } catch (err) {
      issues.add({ code: 'block_failed', severity: 'warning', message: `Falló la relectura de la página ${String(page)}: ${errorText(err)}`, page })
    }
  }
  if (problems.size > opts.maxRetryPages) {
    issues.add({ code: 'running_balance_break', severity: 'warning', message: `Hay ${String(problems.size)} páginas con problemas aritméticos; solo se releyeron ${String(opts.maxRetryPages)} para acotar el costo.` })
  }

  // ---------- Verificación final de cada valor
  const periodsTx = new Map<string, Transaction[]>()
  for (const acc of summary.accounts) {
    for (const p of acc.periods) {
      const txs = state.tx.get(p.id) ?? []
      const rec = state.recs.get(p.id) ?? reconcilePeriod(txs, printedOf(p))
      p.reconciliation = rec.reconciliation
      const reconciled = rec.reconciliation.status === 'reconciled'
      const rowOk = new Map(rec.rows.map((r) => [r.transactionId, r.ok]))
      const missingOnPage = new Map<number, number>()
      const verified = txs.map((t) => {
        const balanceOk = rowOk.get(t.id) ?? null
        const onPage = text.usable ? text.amountOnPage(t.source.page, t.amount) : null
        if (onPage === false) missingOnPage.set(t.source.page, (missingOnPage.get(t.source.page) ?? 0) + 1)
        if (conflictIds.has(t.id)) return { ...t, verification: 'conflict' as const, confidence: 0.3 }
        const ok = balanceOk === true || (onPage === true && reconciled) || (onPage === null && reconciled)
        const confidence = balanceOk === true && onPage !== false ? 1 : balanceOk === true ? 0.9 : ok ? 0.85 : onPage === true ? 0.6 : 0.4
        return { ...t, verification: ok ? ('verified' as const) : ('unverified' as const), confidence }
      })
      periodsTx.set(p.id, verified)
      reportPeriodIssues(p, rec, issues, missingOnPage, retried)
      checkDates(p, verified, issues)
      if (rec.reconciliation.status === 'not_reconciled') flags.add('reconciliation_failed')
      if (reconciled) {
        for (const key of ['opening_balance', 'closing_balance', 'total_credits', 'total_debits'] as const) {
          const f = p.summary[key]
          if (f.value !== null && f.source !== null) p.summary[key] = { ...f, verification: 'verified', confidence: 1 }
        }
      }
    }
    checkAccountFormats(acc, issues)
  }
  checkRfcField(summary.holder.rfc, issues)
  crossCheckFiscal(fiscal, summary.holder, summary.accounts.flatMap((a) => a.periods), issues)
  if (outcome.partial) flags.add('partial_extraction')

  return build({ extractionModel, pdf, route, started, documentType, classConfidence, classifierBank, classifier, summary, fiscal, periodsTx, issues, flags, calls, failureReason, status: outcome.partial ? 'partial' : 'complete' })
}

// ---------------------------------------------------------------- helpers

function emptyRec() {
  return reconcilePeriod([], { opening: null, closing: null, totalCredits: null, totalDebits: null, creditsCount: null, debitsCount: null }).reconciliation
}

function differs(a: readonly PlacedRow[], b: readonly PlacedRow[]): boolean {
  const key = (r: PlacedRow) => `${r.tx.date}|${String(r.tx.amount)}|${r.tx.type}|${String(r.tx.balance)}`
  const sa = a.map(key).sort().join('\n')
  const sb = b.map(key).sort().join('\n')
  return sa !== sb
}

interface BuildInput {
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

const missingField = { value: null, source: null, verification: 'unverified' as const, confidence: 0, provenance: 'extracted' as const }

function build(b: BuildInput): StatementExtraction {
  const finished = new Date()
  const usage = b.calls.reduce<TokenUsage>((acc, c) => addUsage(acc, c.usage), ZERO_USAGE)
  const cost = round6(b.calls.reduce((s, c) => s + c.cost_usd, 0))
  const accounts = (b.summary?.accounts ?? []).map((a) => ({ ...a, periods: a.periods.map((p) => ({ ...p, transactions: b.periodsTx.get(p.id) ?? [] })) }))
  const doc: StatementExtraction = {
    schema_version: STATEMENT_SCHEMA_VERSION,
    document: { file_name: b.pdf.fileName, sha256: b.pdf.sha256, size_bytes: b.pdf.sizeBytes, page_count: Math.max(1, b.pdf.pageCount), text_layer: b.pdf.textLayer, route: b.route },
    classification: { document_type: b.documentType, confidence: b.classConfidence, bank: b.classifierBank },
    bank_name: b.summary?.bankName ?? missingField,
    holder: b.summary?.holder ?? { name: missingField, rfc: missingField, holder_type: missingField, address: missingField },
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
      prompts: Object.fromEntries([...new Set(b.calls.map((c) => c.prompt).filter((p): p is string => p !== null))].map((id) => [id.split('.v')[0] ?? id, `v${id.split('.v')[1] ?? '?'}`])),
      calls: b.calls,
      usage,
      cost_usd: cost,
      failure_reason: b.failureReason,
    },
  }
  const parsed = StatementExtraction.safeParse(doc)
  if (parsed.success) return parsed.data
  // Degradación elegante: un campo que viola el contrato se vuelve desconocido y una fila que
  // lo viola se quita, cada uno con su issue; el resto de la extracción se conserva.
  const repaired = repairAgainstContract(doc, parsed.error.issues, b.issues)
  if (repaired) return repaired
  // Solo si la reparación no alcanza se entrega lo mínimo válido, con la ruta del error (sin datos).
  const where = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return { ...doc, accounts: [], issues: [...b.issues.issues, { id: `i${String(b.issues.issues.length + 1).padStart(4, '0')}`, code: 'block_failed', severity: 'error', message: `La extracción no validó contra el contrato y se descartó: ${where}`, page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: {} }], extraction: { ...doc.extraction, status: 'failed', failure_reason: `contrato inválido: ${where}` } }
}

type ZodIssueLike = { path: PropertyKey[]; message: string }

export function repairAgainstContract(doc: StatementExtraction, problems: readonly ZodIssueLike[], issues: IssueSink): StatementExtraction | null {
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
      issues.add({ code: 'missing_required_field', severity: 'error', message: `Se quitó un movimiento que no cumple el contrato (${path.slice(txAt + 2).join('.')}: ${p.message}).`, path: `/${path.slice(0, txAt + 2).join('/')}` })
      continue
    }
    const valueAt = path.lastIndexOf('value')
    if (valueAt <= 0) return null
    let parent: unknown = copy
    for (const k of path.slice(0, valueAt)) parent = (parent as Record<string, unknown> | undefined)?.[k]
    if (typeof parent !== 'object' || parent === null) return null
    Object.assign(parent, { value: null, source: null, verification: 'unverified', confidence: 0 })
    issues.add({ code: 'missing_required_field', severity: 'warning', message: `Un valor no cumple el contrato y quedó como desconocido (${where}: ${p.message}).`, path: `/${path.join('/')}` })
  }
  for (const [key, rows] of dropRows) {
    let list: unknown = copy
    for (const k of key.split('.')) list = (list as Record<string, unknown> | undefined)?.[k]
    if (!Array.isArray(list)) return null
    const arr = list as unknown[]
    const kept = arr.filter((_, i) => !rows.has(i))
    arr.splice(0, arr.length, ...kept)
  }
  const again = StatementExtraction.safeParse({ ...copy, issues: issues.issues })
  return again.success ? again.data : null
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

async function finalizeFailed(path: string, bytes: Buffer, started: Date, reason: string): Promise<StatementExtraction> {
  const sha = createHash('sha256').update(bytes).digest('hex')
  const pdf: LoadedPdf = { fileName: basename(path), bytes: new Uint8Array(), base64: '', sha256: sha, sizeBytes: bytes.byteLength, pageCount: 1, pageTexts: [''], textLayer: 'absent', textRepaired: false, pagination: [{ page: 1, printed: null, total: null }], duplicatePages: [], duplicates: [], rotatedPages: [], straightened: false }
  const issues = new IssueSink()
  issues.add({ code: 'page_unreadable', severity: 'error', message: reason })
  return Promise.resolve(
    build({ extractionModel: EXTRACTION_MODEL, pdf, route: 'vision_only', started, documentType: 'other', classConfidence: 0, classifierBank: null, classifier: { implementation: 'claude', model: 'none', fallback: true }, summary: null, fiscal: [], periodsTx: new Map(), issues, flags: new Set(['partial_extraction']), calls: [], failureReason: reason, status: 'failed' }),
  )
}
