/* eslint-disable no-console -- CLI: la salida en consola es el resultado */
/**
 * pnpm extract <pdf|carpeta>... [--out data/out/extractions] [--cache readwrite|read|off]
 *              [--block-pages 4] [--tx-effort low] [--summary-effort medium] [--concurrency 3]
 *
 * Herramienta de desarrollo de la fase 2: extrae, verifica e imprime tokens y costo por
 * documento. El comando para evaluadores (`pnpm run evaluate`) llega en la fase 5 y usa la
 * misma función. La salida tiene datos del documento: por defecto va a data/ (ignorado).
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { StatementExtraction } from '@gow/contracts'
import { CachingStructuredLlm, createClassifier, createLimiter, EXTRACTION_MODEL, loadRootEnv, MastraStructuredLlm, PROVIDER_FALLBACK_MODEL, providerOf, readAnthropicEnv, readGoogleEnv, type CacheMode, type Effort } from '@gow/llm'
import { DEFAULT_OPTIONS, extractStatement } from './extract.ts'

const REPO = resolve(import.meta.dirname, '../../..')
/** pnpm -F corre el script dentro del paquete; las rutas del usuario son relativas a donde lo escribió. */
const USER_CWD = process.env.INIT_CWD ?? process.cwd()
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function effort(v: string | undefined, fallback: Effort): Effort {
  return v && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : fallback
}

function collectPdfs(inputs: string[]): string[] {
  const out: string[] = []
  for (const input of inputs) {
    const p = resolve(USER_CWD, input)
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.toLowerCase().endsWith('.pdf')) out.push(join(p, f))
    } else out.push(p)
  }
  return out
}

function line(doc: StatementExtraction, seconds: number): string {
  const periods = doc.accounts.flatMap((a) => a.periods)
  const txs = periods.reduce((s, p) => s + p.transactions.length, 0)
  const rec = periods.filter((p) => p.reconciliation?.status === 'reconciled').length
  const u = doc.extraction.usage
  const hits = doc.extraction.calls.filter((c) => c.response_cache_hit).length
  return [
    doc.document.file_name.padEnd(36),
    doc.extraction.status.padEnd(8),
    doc.document.route === 'vision_only' ? 'visión ' : 'texto  ',
    `cuentas ${String(doc.accounts.length)}`,
    `periodos ${String(periods.length)}`,
    `mov ${String(txs).padStart(4)}`,
    `cuadran ${String(rec)}/${String(periods.length)}`,
    `llamadas ${String(doc.extraction.calls.length)}${hits ? ` (${String(hits)} de caché)` : ''}`,
    `tokens in ${String(u.input_tokens)} cw ${String(u.cache_creation_input_tokens)} cr ${String(u.cache_read_input_tokens)} out ${String(u.output_tokens)}`,
    `USD ${doc.extraction.cost_usd.toFixed(4)}`,
    `${seconds.toFixed(0)} s`,
  ].join('  ')
}

async function main(): Promise<void> {
  loadRootEnv()
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: join(REPO, 'data/out/extractions') },
      cache: { type: 'string', default: 'readwrite' },
      'cache-dir': { type: 'string', default: join(REPO, 'data/llm-cache') },
      'block-pages': { type: 'string', default: String(DEFAULT_OPTIONS.blockPages) },
      'tx-effort': { type: 'string' },
      'summary-effort': { type: 'string' },
      'retry-effort': { type: 'string' },
      concurrency: { type: 'string', default: '3' },
      model: { type: 'string' },
    },
  })
  if (positionals.length === 0) {
    console.error('uso: pnpm extract <pdf|carpeta>... [--out dir] [--cache readwrite|read|off]')
    process.exit(64)
  }
  const googleAvailable = readGoogleEnv().apiKey !== null
  if (values.model) {
    let provider: string
    try {
      provider = providerOf(values.model)
    } catch {
      console.error(`Modelo desconocido: ${values.model}. Usa claude-* o gemini-*.`)
      process.exit(64)
    }
    if (provider === 'google' && !googleAvailable) {
      console.error('Falta GEMINI_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY (entorno o .env) para usar modelos gemini-*.')
      process.exit(2)
    }
  }
  const primary = values.model ?? (googleAvailable ? EXTRACTION_MODEL : PROVIDER_FALLBACK_MODEL)
  // Aviso a quien ejecuta: con la llave de Google, los PDFs se mandan a Google (ADR 0011).
  if (providerOf(primary) === 'google') console.error(`Extracción con ${primary}: los PDFs se mandan a Google; Claude hace la doble lectura y la emergencia (ADR 0011).`)
  else if (!values.model) console.error(`Sin llave de Google: extracción con ${primary} (ADR 0011).`)
  const mode = (['off', 'read', 'readwrite'].includes(values.cache) ? values.cache : 'readwrite') as CacheMode
  const env = readAnthropicEnv()
  const base = env.apiKey ? new MastraStructuredLlm(env) : null
  if (!base && mode !== 'read') {
    console.error('Falta ANTHROPIC_API_KEY (entorno o .env): la necesitan la clasificación, la doble lectura y la emergencia. Con GEMINI_API_KEY además, la extracción va con Gemini (ADR 0011). Con --cache read se usan solo respuestas guardadas.')
    process.exit(2)
  }
  const llm = new CachingStructuredLlm(base, resolve(USER_CWD, values['cache-dir']), mode)
  const classifier = createClassifier(llm)
  const limit = createLimiter(Math.max(1, Number(values.concurrency) || 3))
  const opts = {
    ...DEFAULT_OPTIONS,
    ...(values.model ? { extractionModel: values.model } : {}),
    googleAvailable,
    blockPages: Math.max(1, Number(values['block-pages']) || DEFAULT_OPTIONS.blockPages),
    transactionsEffort: effort(values['tx-effort'], DEFAULT_OPTIONS.transactionsEffort),
    summaryEffort: effort(values['summary-effort'], DEFAULT_OPTIONS.summaryEffort),
    retryEffort: effort(values['retry-effort'], DEFAULT_OPTIONS.retryEffort),
    limit,
  }

  const outDir = resolve(USER_CWD, values.out)
  mkdirSync(outDir, { recursive: true })
  const pdfs = collectPdfs(positionals)
  let total = 0
  const summary: Record<string, unknown>[] = []
  for (const path of pdfs) {
    const t0 = Date.now()
    const doc = await extractStatement(path, { llm, classifier }, { ...opts, onProgress: (m) => process.stderr.write(`  · ${basename(path)}: ${m}\n`) })
    writeFileSync(join(outDir, `${basename(path, '.pdf')}.json`), `${JSON.stringify(doc, null, 2)}\n`)
    total += doc.extraction.cost_usd
    const periods = doc.accounts.flatMap((a) => a.periods)
    summary.push({
      file: doc.document.file_name,
      status: doc.extraction.status,
      route: doc.document.route,
      accounts: doc.accounts.length,
      periods: periods.length,
      transactions: periods.reduce((n, p) => n + p.transactions.length, 0),
      reconciled: periods.filter((p) => p.reconciliation?.status === 'reconciled').length,
      fiscal_documents: doc.fiscal_documents.length,
      calls: doc.extraction.calls.length,
      response_cache_hits: doc.extraction.calls.filter((c) => c.response_cache_hit).length,
      usage: doc.extraction.usage,
      cost_usd: doc.extraction.cost_usd,
      seconds: Math.round((Date.now() - t0) / 1000),
      errors: doc.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    })
    writeFileSync(join(outDir, 'run-summary.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), options: { extractionModel: primary, blockPages: opts.blockPages, summaryEffort: opts.summaryEffort, transactionsEffort: opts.transactionsEffort, retryEffort: opts.retryEffort }, total_cost_usd: Math.round(total * 1e6) / 1e6, documents: summary }, null, 2)}\n`)
    console.log(line(doc, (Date.now() - t0) / 1000))
    const errors = doc.issues.filter((i) => i.severity === 'error')
    for (const i of errors.slice(0, 4)) console.log(`      ! ${i.code}: ${i.message}`)
    if (errors.length > 4) console.log(`      ! ... y ${String(errors.length - 4)} errores más`)
  }
  console.log(`\n${String(pdfs.length)} documentos · costo total USD ${total.toFixed(4)} · salida en ${outDir}`)
}

await main()
