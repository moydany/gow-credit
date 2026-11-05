/* eslint-disable no-console -- CLI: la salida en consola es el resultado; solo estados, conteos y costos */
/**
 * pnpm run evaluate <carpeta|pdf>... [--out <dir>] [--request <k=v,...|archivo.json>]
 *   [--answers <archivo.json>] [--as-of YYYY-MM-DD] [--policy <archivo.json>] [--interactive]
 *   [--cache readwrite|read|off] [--force] [--concurrency 3]
 *
 * Modo standalone (docs/07 A): por cada PDF corre el workflow `processApplication` (extracción,
 * clasificación de movimientos, perfil, política, aclaración) y escribe en la carpeta de salida
 * `<id>.extraction.json` (contrato StatementExtraction), `<id>.result.json` (ApplicationResult),
 * `<id>.md` (reporte), `summary.md` y, si alguna quedó pausada, `answers.template.json`. Una
 * solicitud pausada se reanuda en otra invocación con `--answers`. La consola nunca muestra datos
 * del documento: solo estados, conteos y costos (salvo `--interactive`, que muestra las preguntas
 * para que las conteste quien corre el comando).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { AnswersFile, ApplicationRequest, ApplicationResult, IsoDate, parsePolicy, SupplierIdentity, type OwnerAnswer, type Policy, type Question } from '@gow/contracts'
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
  loadRootEnv,
  MastraStructuredLlm,
  PROVIDER_FALLBACK_MODEL,
  providerOf,
  readAnthropicEnv,
  readGoogleEnv,
  type CacheMode,
} from '@gow/llm'
import { z } from 'zod'
import { OutboxChannel } from '../channels.ts'
import { pesos } from '../figures.ts'
import { identityUnverifiable, renderReport, STANDALONE_POLICY_PATH, toApplicationResult, type RunInfo } from '../report.ts'
import { createRuntime, resumeApplication, startApplication, WORKFLOW_ID, type RunOutcome } from '../runtime.ts'
import type { AppInput } from '../state.ts'
import { Writer } from '../writer.ts'

const REPO = resolve(import.meta.dirname, '../../../..')
/** pnpm corre el script dentro del paquete; las rutas del usuario son relativas a donde lo escribió. */
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

function collectPdfs(inputs: string[]): string[] {
  const out: string[] = []
  for (const input of inputs) {
    const p = resolve(USER_CWD, input)
    if (!existsSync(p)) fail(`No existe: ${input}`)
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.toLowerCase().endsWith('.pdf')) out.push(join(p, f))
    } else out.push(p)
  }
  return out
}

/** `amount=180000,buyer=Cadena Norte` para todas, o un JSON `{ "<id>": {...}, "*": {...} }`. */
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

function loadPolicyArg(arg: string | undefined): { policy: Policy; id: string } {
  if (!arg) return { policy: basePolicyTemplate(), id: BASE_POLICY_ID }
  const path = resolve(USER_CWD, arg)
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
  // Solo ruta y mensaje: el valor que falló puede traer datos del documento.
  if (!parsed.success) fail(`--answers inválido:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`)
  return { file: parsed.data, baseDir: dirname(path) }
}

/** Plantilla de respuestas: la categoría lista las opciones (inválida hasta elegir una); identidad en null. */
function templateAnswer(q: Question): Record<string, unknown> {
  switch (q.kind) {
    case 'deposit':
      return { question_id: q.id, kind: 'deposit', category: q.options.map((o) => o.value).join(' | '), counterparty: null }
    case 'identity':
      return { question_id: q.id, kind: 'identity', legal_name: null, rfc: null, clabe: null }
    case 'documents':
      return { question_id: q.id, kind: 'documents', paths: [] }
  }
}

async function askInteractively(questions: readonly Question[]): Promise<OwnerAnswer[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answers: OwnerAnswer[] = []
  try {
    for (const q of questions) {
      console.log(`\n${q.id}. ${q.text}`)
      if (q.kind === 'deposit') {
        q.options.forEach((o, i) => { console.log(`   ${String(i + 1)}) ${o.label}`); })
        const pick = Number((await rl.question('   Opción (vacío = no sé): ')).trim())
        const option = q.options[pick - 1]
        answers.push(option ? { question_id: q.id, kind: 'deposit', category: option.value as Extract<OwnerAnswer, { kind: 'deposit' }>['category'], counterparty: null } : { question_id: q.id, kind: 'decline', note: null })
      } else if (q.kind === 'identity') {
        const legal = (await rl.question('   Razón social o nombre del titular (vacío = no sé): ')).trim()
        const rfc = (await rl.question('   RFC (opcional): ')).trim()
        const clabe = (await rl.question('   CLABE (opcional): ')).trim()
        answers.push(legal ? { question_id: q.id, kind: 'identity', legal_name: legal, rfc: rfc || null, clabe: clabe || null } : { question_id: q.id, kind: 'decline', note: null })
      } else {
        const paths = (await rl.question('   Ruta de los PDF, separadas por coma (vacío = no los tengo): ')).split(',').map((p) => p.trim()).filter(Boolean)
        answers.push(paths.length ? { question_id: q.id, kind: 'documents', paths: paths.map((p) => resolve(USER_CWD, p)) } : { question_id: q.id, kind: 'decline', note: null })
      }
    }
  } finally {
    rl.close()
  }
  return answers
}

interface Row {
  id: string
  identity_unverifiable: boolean
  /** Sin monto solicitado: el estado con el que calificaría pidiendo la línea máxima, y la línea. */
  max_line: { status: string; amount: number } | null
  status: string
  questions: number
  usd_this_run: number
  cache_hits: number
  calls: number
  classifier: string
  note: string
}

/** Una línea por solicitud: estados, conteos y costo; nunca cifras ni textos del documento. */
function printRow(r: Row): void {
  console.log(`${r.id.padEnd(34)} ${r.status.padEnd(20)} preguntas ${String(r.questions).padStart(2)}  movimientos: ${r.classifier.padEnd(6)}  llamadas ${String(r.calls).padStart(3)} (${String(r.cache_hits)} de caché)  USD ${r.usd_this_run.toFixed(4)}${r.max_line ? `  · línea máxima: ${r.max_line.status}` : ''}${r.note ? `  · ${r.note}` : ''}`)
}

async function main(): Promise<void> {
  loadRootEnv()
  const { values, positionals } = parseArgs({
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
    },
  })
  if (positionals.length === 0) fail('uso: pnpm run evaluate <carpeta|pdf>... [--out dir] [--request k=v,...] [--answers archivo.json] [--as-of AAAA-MM-DD] [--policy archivo.json] [--interactive]')
  const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10)
  if (!IsoDate.safeParse(asOf).success) fail('--as-of debe ser una fecha AAAA-MM-DD')
  const mode = (['off', 'read', 'readwrite'].includes(values.cache) ? values.cache : 'readwrite') as CacheMode
  const anthropic = readAnthropicEnv()
  const googleAvailable = readGoogleEnv().apiKey !== null
  if (!anthropic.apiKey && mode !== 'read') fail('Falta ANTHROPIC_API_KEY (entorno o .env). Con GEMINI_API_KEY además, la extracción va con Gemini (ADR 0011). Con --cache read se usan solo respuestas guardadas.', 2)
  const primary = googleAvailable ? EXTRACTION_MODEL : PROVIDER_FALLBACK_MODEL
  console.error(providerOf(primary) === 'google' ? `Extracción con ${primary}: los PDFs se mandan a Google; Claude hace la doble lectura y la emergencia (ADR 0011).` : `Sin llave de Google: extracción con ${primary} (ADR 0011).`)

  const policy = loadPolicyArg(values.policy)
  const requestFor = loadRequests(values.request)
  const answers = loadAnswers(values.answers)
  const outDir = resolve(USER_CWD, values.out)
  mkdirSync(join(outDir, '.state'), { recursive: true })
  const cacheDir = resolve(USER_CWD, values['cache-dir'])

  const limit = createLimiter(Math.max(1, Number(values.concurrency) || 3))
  // Con --cache read no se construye cliente: un miss falla en lugar de llamar al modelo.
  const llm = new CachingStructuredLlm(mode !== 'read' && (anthropic.apiKey || googleAvailable) ? new MastraStructuredLlm(anthropic) : null, cacheDir, mode)
  const jevKey = process.env.TYPESAFE_API_KEY?.trim()
  // Misma llave que la eval de clasificadores: lo que ya clasificó, se reproduce sin costo.
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

  const pdfs = collectPdfs(positionals)
  const rows: Row[] = []
  const pending: Record<string, { answers: Record<string, unknown>[] }> = {}
  let failures = 0

  for (const pdf of pdfs) {
    const id = basename(pdf).replace(/\.pdf$/i, '')
    const resultPath = join(outDir, `${id}.result.json`)
    const previous = existsSync(resultPath) ? ApplicationResult.safeParse(JSON.parse(readFileSync(resultPath, 'utf8'))) : null
    const prevResult = previous?.success ? previous.data : null
    const given = answers?.file.applications[id]
    let outcome: RunOutcome
    let callsBefore = 0
    let note = ''

    if (prevResult && !values.force) {
      if (prevResult.run.status === 'suspended' && given && prevResult.run.suspended_step) {
        callsBefore = prevResult.costs.lines.reduce((n, l) => n + l.calls, 0)
        outcome = await resumeApplication(wf, prevResult.run.run_id, prevResult.run.suspended_step, { answers: given.answers, base_dir: answers.baseDir })
        note = 'reanudada con respuestas'
      } else {
        rows.push({ id, identity_unverifiable: identityUnverifiable(prevResult), max_line: prevResult.max_line && { status: prevResult.max_line.status, amount: prevResult.max_line.amount }, status: prevResult.status, questions: prevResult.clarification?.status === 'open' ? prevResult.clarification.questions.length : 0, usd_this_run: 0, cache_hits: 0, calls: 0, classifier: prevResult.classification?.implementation ?? '—', note: prevResult.run.status === 'suspended' ? 'pausada; sin respuestas para ella' : 'ya evaluada (--force para repetir)' })
        if (prevResult.run.status === 'suspended' && prevResult.clarification) pending[id] = { answers: prevResult.clarification.questions.map(templateAnswer) }
        printRow(rows.at(-1) as Row)
        continue
      }
    } else {
      const spec = requestFor(id)
      const input: AppInput = { application_id: id, pdf_path: pdf, as_of: asOf, request: toRequest(spec), supplier: toSupplier(spec), policy: policy.policy, policy_id: policy.id }
      outcome = await startApplication(wf, input)
    }

    while (values.interactive && outcome.status === 'suspended' && outcome.state && outcome.suspendedStep) {
      console.log(`\n${id}: necesita aclaración.`)
      const given2 = await askInteractively(outcome.state.questions)
      outcome = await resumeApplication(wf, outcome.runId, outcome.suspendedStep, { answers: given2, base_dir: null })
      note = 'respondida en consola'
    }

    const run: RunInfo = { workflow: WORKFLOW_ID, run_id: outcome.runId, status: outcome.status, suspended_step: outcome.suspendedStep }
    const generatedAt = new Date().toISOString()
    const result = toApplicationResult(id, outcome.state, run, generatedAt, outcome.error)
    if (outcome.state) {
      outcome.state.statements.forEach((s, i) => { writeFileSync(join(outDir, `${id}.extraction${i === 0 ? '' : `-${String(i + 1)}`}.json`), `${JSON.stringify(s, null, 2)}\n`); })
    }
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    writeFileSync(join(outDir, `${id}.md`), renderReport(result, outcome.state))
    if (outcome.status === 'failed') failures++
    if (outcome.status === 'suspended' && result.clarification) pending[id] = { answers: result.clarification.questions.map(templateAnswer) }
    const newCalls = (outcome.state?.calls ?? []).slice(callsBefore)
    rows.push({
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
    printRow(rows.at(-1) as Row)
  }

  const total = rows.reduce((s, r) => s + r.usd_this_run, 0)
  const summary = [
    '# Evaluación standalone',
    '',
    `Fecha de cálculo ${asOf} · política \`${policy.id}\` · ${String(rows.length)} documento(s) · costo de esta corrida USD ${total.toFixed(4)}`,
    '',
    'Sin monto solicitado, el estado evalúa una solicitud sin monto ni comprador; la línea máxima es el mayor monto que la política aprobaría pedido tal cual.',
    '',
    '| Solicitud | Estado | Línea máxima | Preguntas abiertas | Movimientos | USD esta corrida | Nota |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| [${r.id}](${r.id}.md) | \`${r.status}\` | ${r.max_line ? `${pesos(r.max_line.amount)} (\`${r.max_line.status}\`)` : '—'} | ${String(r.questions)} | ${r.classifier} | ${r.usd_this_run.toFixed(4)} | ${r.note} |`),
    '',
  ].join('\n')
  writeFileSync(join(outDir, 'summary.md'), summary)
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), as_of: asOf, policy: policy.id, cost_usd_this_run: Math.round(total * 1e6) / 1e6, applications: rows }, null, 2)}\n`)
  const pendingIds = Object.keys(pending)
  if (pendingIds.length > 0) {
    writeFileSync(join(outDir, 'answers.template.json'), `${JSON.stringify({ version: 1, applications: pending }, null, 2)}\n`)
    console.log(`\n${String(pendingIds.length)} solicitud(es) pausada(s). Las preguntas están en cada <id>.md y en outbox/.`)
    console.log(`Copia ${join(outDir, 'answers.template.json')}, elige una categoría por abono (o cambia kind a "decline"), deja solo lo que respondas y corre:`)
    console.log(`  pnpm run evaluate ${positionals.join(' ')} --out ${outDir} --answers <archivo>`)
  }
  const unverifiable = rows.filter((r) => r.identity_unverifiable).length
  if (unverifiable > 0 && values.policy === undefined) {
    console.log(`\n${String(unverifiable)} solicitud(es) sin identidad comparable (documento redactado o sin proveedor registrado): la política base lo pregunta.`)
    console.log(`Para ver la decisión sin ese bloqueo, en otra carpeta de salida: --policy ${STANDALONE_POLICY_PATH} --out <dir>`)
  }
  console.log(`\n${String(rows.length)} documento(s) · costo de esta corrida USD ${total.toFixed(4)} · salida en ${outDir}`)
  if (failures > 0) process.exit(1)
}

await main()
