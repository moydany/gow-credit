/* eslint-disable no-console -- CLI: console output is the result; only statuses, counts and costs */
/**
 * pnpm run evaluate <folder|pdf>... [--out <dir>] [--request <k=v,...|file.json>]
 *   [--answers <file.json>] [--as-of YYYY-MM-DD] [--policy <file.json|base>] [--interactive]
 *   [--cache readwrite|read|off] [--force] [--concurrency 3] [--help]
 *
 * Standalone mode: for each PDF runs the `processApplication` workflow (extraction, transaction
 * classification, profile, policy, clarification) and writes to the output folder
 * `<id>.extraction.json` (StatementExtraction contract), `<id>.result.json` (ApplicationResult),
 * `<id>.md` (report), `summary.md`, the flat extraction summary (`extraction-summary.json` and
 * `.csv`, for comparing against a reference truth) and, if any request was paused,
 * `answers.template.json`. A paused request resumes in another invocation with `--answers`. The
 * console never shows document data: only statuses, counts and costs (except `--interactive`,
 * which shows the questions for whoever runs the command to answer).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { AnswersFile, ApplicationRequest, ApplicationResult, calendarToday, IsoDate, parsePolicy, StatementExtraction, SupplierIdentity, type Policy, type Question } from '@gow/contracts'
import { BASE_POLICY_ID, basePolicyTemplate } from '@gow/decision'
import { DEFAULT_OPTIONS, extractStatement } from '@gow/extraction'
import {
  CachedClassifier,
  CachingStructuredLlm,
  createClassifier,
  createLimiter,
  createTransactionClassifier,
  EXTRACTION_MODEL,
  JsonFileCache,
  JsonlLlmExchangeSink,
  loadRootEnv,
  MastraStructuredLlm,
  PROVIDER_FALLBACK_MODEL,
  providerOf,
  readAnthropicEnv,
  readGoogleEnv,
  RecordingStructuredLlm,
  withLlmScope,
  type CacheMode,
} from '@gow/llm'
import { z } from 'zod'
import { OutboxChannel } from '../channels.ts'
import { pesos } from '../figures.ts'
import { extractionSummaryCsv, extractionSummaryRows, identityUnverifiable, missingExtractionRow, renderReport, STANDALONE_POLICY_PATH, THREE_MONTHS_POLICY_PATH, toApplicationResult, type ExtractionSummaryRow, type RunInfo } from '../report.ts'
import { createRuntime, resumeApplication, startApplication, WORKFLOW_ID, type RunOutcome } from '../runtime.ts'
import type { AppInput } from '../state.ts'
import { Writer } from '../writer.ts'
import { askInteractively } from './interactive.ts'

const REPO = resolve(import.meta.dirname, '../../../..')
/** pnpm runs the script inside the package; user paths are relative to where they typed it. */
const USER_CWD = process.env.INIT_CWD ?? process.cwd()

const RequestSpec = z.strictObject({
  amount: z.coerce.number().positive().optional(),
  maturity: IsoDate.optional(),
  buyer: z.string().min(1).optional(),
  buyer_rfc: z.string().min(1).optional(),
  buyer_aliases: z.union([z.string(), z.array(z.string())]).optional(),
  supplier_name: z.string().min(1).optional(),
  supplier_rfc: z.string().min(1).optional(),
  supplier_clabe: z.string().min(1).optional(),
})
type RequestSpec = z.infer<typeof RequestSpec>

function fail(message: string, code = 64): never {
  console.error(message)
  process.exit(code)
}

/** One request: its id and its PDFs (more than one when they are sent together). */
interface Group {
  id: string
  pdfs: string[]
}

const isPdf = (f: string) => f.toLowerCase().endsWith('.pdf')

/**
 * Each PDF is a request; a subfolder of a given folder is one request with all its PDFs, as if they
 * were sent together (the three months of a policy with `history.months: 3`).
 */
function collectGroups(inputs: string[]): Group[] {
  const out: Group[] = []
  for (const input of inputs) {
    const p = resolve(USER_CWD, input)
    if (!existsSync(p)) fail(`No existe: ${input}`)
    if (!statSync(p).isDirectory()) {
      out.push({ id: basename(p).replace(/\.pdf$/i, ''), pdfs: [p] })
      continue
    }
    for (const f of readdirSync(p).sort()) {
      const child = join(p, f)
      if (statSync(child).isDirectory()) {
        const pdfs = readdirSync(child).sort().filter(isPdf).map((x) => join(child, x))
        if (pdfs.length > 0) out.push({ id: f, pdfs })
      } else if (isPdf(f)) out.push({ id: f.replace(/\.pdf$/i, ''), pdfs: [child] })
    }
  }
  return out
}

/** `amount=180000,buyer=Cadena Norte` for all, or a JSON `{ "<id>": {...}, "*": {...} }`. */
function loadRequests(arg: string | undefined): (id: string) => RequestSpec | null {
  if (!arg) return () => null
  const path = resolve(USER_CWD, arg)
  if (arg.endsWith('.json') && existsSync(path)) {
    const parsed = z.record(z.string(), RequestSpec).safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) fail(`--request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return (id) => ({ ...parsed.data['*'], ...parsed.data[id] })
  }
  const pairs = Object.fromEntries(arg.split(',').map((kv) => {
    const at = kv.indexOf('=')
    if (at < 1) fail(`--request: "${kv}" no es clave=valor`)
    return [kv.slice(0, at).trim(), kv.slice(at + 1).trim()]
  }))
  const parsed = RequestSpec.safeParse(pairs)
  if (!parsed.success) fail(`--request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return () => parsed.data
}

function toRequest(spec: RequestSpec | null): ApplicationRequest | null {
  if (!spec || (spec.amount === undefined && spec.buyer === undefined && spec.maturity === undefined)) return null
  const aliases = spec.buyer_aliases === undefined ? [] : Array.isArray(spec.buyer_aliases) ? spec.buyer_aliases : spec.buyer_aliases.split('|')
  return ApplicationRequest.parse({ amount: spec.amount ?? null, maturity: spec.maturity ?? null, buyer: spec.buyer ? { name: spec.buyer, rfc: spec.buyer_rfc ?? null, aliases } : null })
}

function toSupplier(spec: RequestSpec | null): SupplierIdentity | null {
  if (!spec?.supplier_name) return null
  return SupplierIdentity.parse({ legal_name: spec.supplier_name, rfc: spec.supplier_rfc ?? null, clabes: spec.supplier_clabe ? [spec.supplier_clabe] : [] })
}

/**
 * Without `--policy`, the standalone example policy: the base template without the `doc_recent`
 * gate, because evaluated documents have unknown dates and the cutoff age must not stop them.
 * `--policy base` uses the base template as is.
 */
function loadPolicyArg(arg: string | undefined): { policy: Policy; id: string } {
  if (arg === 'base') return { policy: basePolicyTemplate(), id: BASE_POLICY_ID }
  const path = arg === undefined ? join(REPO, STANDALONE_POLICY_PATH) : resolve(USER_CWD, arg)
  if (!existsSync(path)) fail(`--policy: no existe ${arg}`)
  const r = parsePolicy(JSON.parse(readFileSync(path, 'utf8')))
  if (!r.ok) fail(`--policy: ${r.message}`)
  return { policy: r.policy, id: basename(path, '.json') }
}

function loadAnswers(arg: string | undefined): { file: AnswersFile; baseDir: string } | null {
  if (!arg) return null
  const path = resolve(USER_CWD, arg)
  if (!existsSync(path)) fail(`--answers: no existe ${arg}`)
  const parsed = AnswersFile.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  // Path and message only: the failing value may carry document data.
  if (!parsed.success) fail(`--answers inválido:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`)
  return { file: parsed.data, baseDir: dirname(path) }
}

/** Answers template: the category lists the options (invalid until one is chosen); identity is null. */
function templateAnswer(q: Question): Record<string, unknown> {
  switch (q.kind) {
    case 'deposit':
      return { question_id: q.id, kind: 'deposit', category: q.options.map((o) => o.value).join(' | '), counterparty: null }
    case 'charge':
      return { question_id: q.id, kind: 'charge', category: q.options.map((o) => o.value).join(' | '), counterparty: null }
    case 'buyer':
      return { question_id: q.id, kind: 'buyer', name: null }
    case 'account_use':
      return { question_id: q.id, kind: 'account_use', use: q.options.map((o) => o.value).join(' | ') }
    case 'identity':
      return { question_id: q.id, kind: 'identity', legal_name: null, rfc: null, clabe: null }
    case 'documents':
      return { question_id: q.id, kind: 'documents', paths: [] }
  }
}

/** Extractions already in the output folder for a request: `<id>.extraction.json`, `<id>.extraction-2.json`, ... */
function readExtractions(outDir: string, id: string): StatementExtraction[] {
  const out: StatementExtraction[] = []
  for (let n = 1; ; n++) {
    const path = join(outDir, `${id}.extraction${n === 1 ? '' : `-${String(n)}`}.json`)
    if (!existsSync(path)) break
    try {
      const parsed = StatementExtraction.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // An unreadable file does not sink the summary: that document is left out.
    }
  }
  return out
}

/**
 * Flat summary rows of a request; with no extraction, one row with the file and, if it failed,
 * its status.
 */
function summaryRowsOf(statements: readonly StatementExtraction[], pdf: string, status: string): ExtractionSummaryRow[] {
  return statements.length > 0 ? statements.flatMap(extractionSummaryRows) : [missingExtractionRow(basename(pdf), status === 'failed')]
}

interface Row {
  id: string
  identity_unverifiable: boolean
  /** No requested amount: the status it would get asking for the maximum line, and that line. */
  max_line: { status: string; amount: number } | null
  status: string
  questions: number
  usd_this_run: number
  cache_hits: number
  calls: number
  classifier: string
  note: string
}

/** One line per request: statuses, counts and cost; never figures or text from the document. */
function printRow(r: Row): void {
  console.log(`${r.id.padEnd(34)} ${r.status.padEnd(20)} preguntas ${String(r.questions).padStart(2)}  movimientos: ${r.classifier.padEnd(6)}  llamadas ${String(r.calls).padStart(3)} (${String(r.cache_hits)} de caché)  USD ${r.usd_this_run.toFixed(4)}${r.max_line ? `  · línea máxima: ${r.max_line.status}` : ''}${r.note ? `  · ${r.note}` : ''}`)
}

const USAGE = `uso: pnpm run evaluate <carpeta|pdf>... [opciones]

Evalúa cada PDF (extracción, perfil, política, aclaración). Una subcarpeta dentro de la carpeta es
una sola solicitud con todos sus PDFs, como si llegaran juntos: los 3 meses de una política con
history.months 3. Escribe en la carpeta de salida
<id>.extraction.json, <id>.result.json, <id>.md, summary.md, summary.json, extraction-summary.json,
extraction-summary.csv (encabezado de cada documento y cuenta, para contrastar con una verdad de
referencia) y, si alguna solicitud quedó pausada, answers.template.json. La consola nunca muestra
datos del documento.

Opciones:
  --out <dir>             Carpeta de salida (por defecto data/out/evaluate)
  --policy <archivo|base> Política del tenant. Por defecto ${STANDALONE_POLICY_PATH}:
                          la plantilla base sin la compuerta de antigüedad del estado de cuenta; evalúa
                          solo el mes más reciente. ${THREE_MONTHS_POLICY_PATH}
                          evalúa 3 meses seguidos. "base" usa la plantilla base tal cual, con esa compuerta.
  --as-of <AAAA-MM-DD>    Fecha de cálculo del perfil (por defecto hoy): contra ella se mide la
                          antigüedad del estado de cuenta (document_age_days). La política por
                          defecto no se detiene por esa antigüedad; la plantilla base
                          (--policy base) sí tiene la compuerta.
  --request <k=v,...|archivo.json>
                          Datos de la solicitud: amount, maturity, buyer, buyer_rfc, buyer_aliases
                          (separados por |), supplier_name, supplier_rfc, supplier_clabe. Un JSON
                          { "<id>": {...}, "*": {...} } da datos por documento. Sin monto, la
                          salida incluye la línea máxima.
  --answers <archivo.json>
                          Respuestas para reanudar solicitudes pausadas (parte de
                          answers.template.json).
  --interactive           Pregunta en la terminal y reanuda en la misma corrida.
  --cache <modo>          readwrite (por defecto), read (solo respuestas guardadas: costo cero,
                          falla si falta una) u off.
  --cache-dir <dir>       Caché de respuestas (por defecto data/llm-cache).
  --force                 Repite documentos ya evaluados en la carpeta de salida.
  --concurrency <n>       Llamadas simultáneas al modelo (por defecto 3).
  -h, --help              Muestra esta ayuda.

Llaves: ANTHROPIC_API_KEY obligatoria (salvo --cache read). Con GEMINI_API_KEY la extracción va
con Gemini 3.8 Flash y los PDFs se mandan a Google; sin ella, con Claude Opus.
TYPESAFE_API_KEY activa Jev para clasificar; sin ella clasifica Haiku.`

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', default: join(REPO, 'data/out/evaluate') },
        request: { type: 'string' },
        answers: { type: 'string' },
        'as-of': { type: 'string' },
        policy: { type: 'string' },
        interactive: { type: 'boolean', default: false },
        cache: { type: 'string', default: 'readwrite' },
        'cache-dir': { type: 'string', default: join(REPO, 'data/llm-cache') },
        force: { type: 'boolean', default: false },
        concurrency: { type: 'string', default: '3' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`)
  }
}

interface EvaluationState {
  rows: Row[]
  summaryRows: ExtractionSummaryRow[]
  pending: Record<string, { round: number; answers: Record<string, unknown>[] }>
  failures: number
}

interface EvaluationConfig {
  values: ReturnType<typeof parseCli>['values']
  positionals: string[]
  outDir: string
  asOf: string
  policy: { policy: Policy; id: string }
  requestFor: (id: string) => RequestSpec | null
  answers: ReturnType<typeof loadAnswers>
  wf: ReturnType<typeof createRuntime>
  exchanges: JsonlLlmExchangeSink
}

function buildSkippedRow(id: string, prevResult: ApplicationResult, pausedRound: number, otherRound: boolean, hasGiven: boolean): Row {
  let note = 'ya evaluada (--force para repetir)'
  if (prevResult.run.status === 'suspended') {
    note = otherRound ? `pausada en la ronda ${String(pausedRound)}; las respuestas son de la ronda ${String(hasGiven ? pausedRound : 0)}` : 'pausada; sin respuestas para ella'
  }
  return {
    id,
    identity_unverifiable: identityUnverifiable(prevResult),
    max_line: prevResult.max_line && { status: prevResult.max_line.status, amount: prevResult.max_line.amount },
    status: prevResult.status,
    questions: prevResult.clarification?.status === 'open' ? prevResult.clarification.questions.length : 0,
    usd_this_run: 0,
    cache_hits: 0,
    calls: 0,
    classifier: prevResult.classification?.implementation ?? '—',
    note,
  }
}

async function handleInteractiveClarification(
  wf: ReturnType<typeof createRuntime>,
  id: string,
  initialOutcome: RunOutcome,
  inScope: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<RunOutcome> {
  let outcome = initialOutcome
  while (outcome.status === 'suspended' && outcome.state && outcome.suspendedStep) {
    console.log(`\n${id}: necesita aclaración.`)
    const answers = await askInteractively(outcome.state.questions)
    const { runId, suspendedStep } = outcome
    outcome = await inScope(() => resumeApplication(wf, runId, suspendedStep, { answers, base_dir: null }))
  }
  return outcome
}

function saveGroupOutcome(
  id: string,
  outcome: RunOutcome,
  callsBefore: number,
  note: string,
  pdf: string,
  cfg: EvaluationConfig,
  state: EvaluationState,
): void {
  const run: RunInfo = { workflow: WORKFLOW_ID, run_id: outcome.runId, status: outcome.status, suspended_step: outcome.suspendedStep }
  const generatedAt = new Date().toISOString()
  const result = toApplicationResult(id, outcome.state, run, generatedAt, outcome.error)
  if (outcome.state) {
    outcome.state.statements.forEach((s, i) => { writeFileSync(join(cfg.outDir, `${id}.extraction${i === 0 ? '' : `-${String(i + 1)}`}.json`), `${JSON.stringify(s, null, 2)}\n`); })
  }
  const resultPath = join(cfg.outDir, `${id}.result.json`)
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(cfg.outDir, `${id}.md`), renderReport(result, outcome.state))
  state.summaryRows.push(...summaryRowsOf(outcome.state?.statements ?? [], pdf, result.status))
  if (outcome.status === 'failed') state.failures++
  if (outcome.status === 'suspended' && result.clarification) state.pending[id] = { round: result.clarification.rounds_used + 1, answers: result.clarification.questions.map(templateAnswer) }
  const newCalls = (outcome.state?.calls ?? []).slice(callsBefore)
  state.rows.push({
    id,
    identity_unverifiable: identityUnverifiable(result),
    max_line: result.max_line && { status: result.max_line.status, amount: result.max_line.amount },
    status: result.status,
    questions: result.clarification?.status === 'open' ? result.clarification.questions.length : 0,
    usd_this_run: Math.round(newCalls.reduce((s, c) => s + c.cost_usd, 0) * 1e6) / 1e6,
    cache_hits: newCalls.filter((c) => c.cache_hit).length,
    calls: newCalls.length,
    classifier: result.classification?.implementation ?? '—',
    note: outcome.error ? `error del workflow: ${outcome.error}` : note,
  })
  printRow(state.rows.at(-1) as Row)
}

async function tryResumeApplication(
  id: string,
  pdf: string,
  prevResult: ApplicationResult,
  cfg: EvaluationConfig,
  state: EvaluationState,
  inScope: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ outcome: RunOutcome; callsBefore: number; note: string } | null> {
  const given = cfg.answers?.file.applications[id]
  const pausedRound = (prevResult.clarification?.rounds_used ?? 0) + 1
  const otherRound = given?.round !== undefined && given.round !== pausedRound
  if (prevResult.run.status === 'suspended' && given && !otherRound && prevResult.run.suspended_step) {
    const callsBefore = prevResult.costs.lines.reduce((n, l) => n + l.calls, 0)
    const outcome = await inScope(() => resumeApplication(cfg.wf, prevResult.run.run_id, prevResult.run.suspended_step as string[], { answers: given.answers, base_dir: cfg.answers?.baseDir ?? null }))
    return { outcome, callsBefore, note: 'reanudada con respuestas' }
  }
  state.rows.push(buildSkippedRow(id, prevResult, pausedRound, otherRound, Boolean(given)))
  if (prevResult.run.status === 'suspended' && prevResult.clarification) {
    state.pending[id] = { round: pausedRound, answers: prevResult.clarification.questions.map(templateAnswer) }
  }
  state.summaryRows.push(...summaryRowsOf(readExtractions(cfg.outDir, id), pdf, prevResult.status))
  printRow(state.rows.at(-1) as Row)
  return null
}

async function startGroupApplication(
  group: Group,
  cfg: EvaluationConfig,
  inScope: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<RunOutcome> {
  const { id, pdfs } = group
  const [pdf, ...extra] = pdfs
  const spec = cfg.requestFor(id)
  const input: AppInput = {
    application_id: id,
    pdf_path: pdf ?? '',
    ...(extra.length > 0 ? { extra_pdf_paths: extra } : {}),
    as_of: cfg.asOf,
    request: toRequest(spec),
    supplier: toSupplier(spec),
    policy: cfg.policy.policy,
    policy_id: cfg.policy.id,
  }
  rmSync(cfg.exchanges.pathFor(id), { force: true })
  return inScope(() => startApplication(cfg.wf, input))
}

async function evaluateGroup(group: Group, cfg: EvaluationConfig, state: EvaluationState): Promise<void> {
  const { id, pdfs } = group
  const [pdf] = pdfs
  if (!pdf) return
  const resultPath = join(cfg.outDir, `${id}.result.json`)
  const previous = existsSync(resultPath) ? ApplicationResult.safeParse(JSON.parse(readFileSync(resultPath, 'utf8'))) : null
  const prevResult = previous?.success ? previous.data : null
  const inScope = <T>(fn: () => Promise<T>) => withLlmScope({ applicationId: id }, fn)

  let outcome: RunOutcome
  let callsBefore = 0
  let note = ''

  if (prevResult && !cfg.values.force) {
    const resumed = await tryResumeApplication(id, pdf, prevResult, cfg, state, inScope)
    if (!resumed) return
    outcome = resumed.outcome
    callsBefore = resumed.callsBefore
    note = resumed.note
  } else {
    outcome = await startGroupApplication(group, cfg, inScope)
  }

  if (cfg.values.interactive) {
    outcome = await handleInteractiveClarification(cfg.wf, id, outcome, inScope)
    note = 'respondida en consola'
  }

  saveGroupOutcome(id, outcome, callsBefore, note, pdf, cfg, state)
}

function writeFinalSummaryFiles(cfg: EvaluationConfig, state: EvaluationState): void {
  const total = state.rows.reduce((s, r) => s + r.usd_this_run, 0)
  const summary = [
    '# Evaluación standalone',
    '',
    `Fecha de cálculo ${cfg.asOf} · política \`${cfg.policy.id}\` · ${String(state.rows.length)} documento(s) · costo de esta corrida USD ${total.toFixed(4)}`,
    '',
    'Sin monto solicitado, el estado evalúa una solicitud sin monto ni comprador; la línea máxima es el mayor monto que la política aprobaría pedido tal cual.',
    '',
    '| Solicitud | Estado | Línea máxima | Preguntas abiertas | Movimientos | USD esta corrida | Nota |',
    '|---|---|---|---|---|---|---|',
    ...state.rows.map((r) => `| [${r.id}](${r.id}.md) | \`${r.status}\` | ${r.max_line ? `${pesos(r.max_line.amount)} (\`${r.max_line.status}\`)` : '—'} | ${String(r.questions)} | ${r.classifier} | ${r.usd_this_run.toFixed(4)} | ${r.note} |`),
    '',
  ].join('\n')
  writeFileSync(join(cfg.outDir, 'summary.md'), summary)
  writeFileSync(join(cfg.outDir, 'extraction-summary.json'), `${JSON.stringify(state.summaryRows, null, 2)}\n`)
  writeFileSync(join(cfg.outDir, 'extraction-summary.csv'), extractionSummaryCsv(state.summaryRows))
  writeFileSync(join(cfg.outDir, 'summary.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), as_of: cfg.asOf, policy: cfg.policy.id, cost_usd_this_run: Math.round(total * 1e6) / 1e6, applications: state.rows }, null, 2)}\n`)
  const pendingIds = Object.keys(state.pending)
  if (pendingIds.length > 0) {
    writeFileSync(join(cfg.outDir, 'answers.template.json'), `${JSON.stringify({ version: 1, applications: state.pending }, null, 2)}\n`)
    console.log(`\n${String(pendingIds.length)} solicitud(es) pausada(s). Las preguntas están en cada <id>.md y en outbox/.`)
    console.log(`Copia ${join(cfg.outDir, 'answers.template.json')}, elige una opción por pregunta (o cambia kind a "decline"), deja solo lo que respondas y corre:`)
    console.log(`  pnpm run evaluate ${cfg.positionals.join(' ')} --out ${cfg.outDir} --answers <archivo>`)
  }
  const unverifiable = state.rows.filter((r) => r.identity_unverifiable).length
  if (unverifiable > 0 && cfg.values.policy === 'base') {
    console.log(`\n${String(unverifiable)} solicitud(es) sin identidad comparable (documento redactado o sin proveedor registrado): la política base lo pregunta.`)
    console.log(`Para ver la decisión sin ese bloqueo, en otra carpeta de salida, quita --policy base (usa ${STANDALONE_POLICY_PATH}) y agrega --out <dir>`)
  }
  console.log(`\n${String(state.rows.length)} documento(s) · costo de esta corrida USD ${total.toFixed(4)} · salida en ${cfg.outDir}`)
  if (state.failures > 0) process.exit(1)
}

function resolveDatesAndPolicy(values: ReturnType<typeof parseCli>['values']) {
  const asOf = values['as-of'] ?? calendarToday()
  if (!IsoDate.safeParse(asOf).success) fail('--as-of debe ser una fecha AAAA-MM-DD')
  const policy = loadPolicyArg(values.policy)
  const isDefaultPolicy = values.policy === undefined
  const asOfNote = values['as-of'] ? '' : ' (hoy; --as-of para otra)'
  const policyMsg = isDefaultPolicy
    ? `Política: ${STANDALONE_POLICY_PATH} (por defecto en standalone: la antigüedad del estado de cuenta no decide; --policy base para la plantilla base) · fecha de cálculo ${asOf}${asOfNote}`
    : `Política: ${policy.id} · fecha de cálculo ${asOf}${asOfNote}`
  console.error(policyMsg)
  return { asOf, policy }
}

function buildEvaluationWorkflow(
  outDir: string,
  cacheDir: string,
  mode: CacheMode,
  anthropic: ReturnType<typeof readAnthropicEnv>,
  googleAvailable: boolean,
  concurrency: string,
) {
  const limit = createLimiter(Math.max(1, Number(concurrency) || 3))
  const exchanges = new JsonlLlmExchangeSink(outDir)
  const llm = new RecordingStructuredLlm(new CachingStructuredLlm(mode !== 'read' && (anthropic.apiKey || googleAvailable) ? new MastraStructuredLlm(anthropic) : null, cacheDir, mode), exchanges, {
    onError: (m) => { console.error(m) },
  })
  const jevKey = process.env.TYPESAFE_API_KEY?.trim()
  const docClassifier = new CachedClassifier(jevKey ? 'jev' : 'haiku', mode === 'read' ? null : createClassifier(llm), join(cacheDir, 'classifier'))
  const txClassifier = createTransactionClassifier(llm, new JsonFileCache(join(cacheDir, 'transactions'), mode))
  console.error(txClassifier.implementation === 'jev' ? 'Movimientos: reglas y Jev donde no alcanzan.' : 'Movimientos: reglas y Haiku donde no alcanzan (sin TYPESAFE_API_KEY no hay Jev; el reporte lo indica).')
  const wf = createRuntime(
    {
      extract: (path) => extractStatement(path, { llm, classifier: docClassifier }, { ...DEFAULT_OPTIONS, googleAvailable, limit }),
      transactionClassifier: txClassifier,
      writer: new Writer(llm, limit),
      channel: new OutboxChannel(join(outDir, 'outbox')),
      limit,
    },
    join(outDir, '.state', 'mastra.db'),
  )
  return { wf, exchanges }
}

async function main(): Promise<void> {
  loadRootEnv()
  const { values, positionals } = parseCli()
  if (values.help) {
    console.log(USAGE)
    return
  }
  if (positionals.length === 0) fail(USAGE)
  const { asOf, policy } = resolveDatesAndPolicy(values)
  const mode = (['off', 'read', 'readwrite'].includes(values.cache) ? values.cache : 'readwrite') as CacheMode
  const anthropic = readAnthropicEnv()
  const googleAvailable = readGoogleEnv().apiKey !== null
  if (!anthropic.apiKey && mode !== 'read') fail('Falta ANTHROPIC_API_KEY (entorno o .env). Con GEMINI_API_KEY además, la extracción va con Gemini. Con --cache read se usan solo respuestas guardadas.', 2)
  const primary = googleAvailable ? EXTRACTION_MODEL : PROVIDER_FALLBACK_MODEL
  console.error(providerOf(primary) === 'google' ? `Extracción con ${primary}: los PDFs se mandan a Google; Claude hace la doble lectura y la emergencia.` : `Sin llave de Google: extracción con ${primary}.`)

  const outDir = resolve(USER_CWD, values.out)
  mkdirSync(join(outDir, '.state'), { recursive: true })
  const cacheDir = resolve(USER_CWD, values['cache-dir'])
  const { wf, exchanges } = buildEvaluationWorkflow(outDir, cacheDir, mode, anthropic, googleAvailable, values.concurrency)

  const cfg: EvaluationConfig = {
    values,
    positionals,
    outDir,
    asOf,
    policy,
    requestFor: loadRequests(values.request),
    answers: loadAnswers(values.answers),
    wf,
    exchanges,
  }
  const state: EvaluationState = { rows: [], summaryRows: [], pending: {}, failures: 0 }
  for (const group of collectGroups(positionals)) {
    await evaluateGroup(group, cfg, state)
  }
  writeFinalSummaryFiles(cfg, state)
}

await main()
