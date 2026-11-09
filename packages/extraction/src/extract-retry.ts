import { loadPrompt } from '@gow/llm'
import {
  materialize,
  placeRows,
  type AssembledSummary,
  type PlacedRow,
} from './assemble.ts'
import {
  errorText,
  type ChunkCaller,
} from './extract-stages.ts'
import { type ExtractOptions } from './extract-types.ts'
import { type IssueSink } from './issues.ts'
import {
  pagesWithBreaks,
  printedOf,
  reconcilePeriod,
  reconciliationScore,
  type PeriodReconciliation,
} from './reconcile.ts'
import { type ModelPlan } from './router.ts'
import type { Transaction } from '@gow/contracts'

function emptyRec() {
  return reconcilePeriod([], { opening: null, closing: null, totalCredits: null, totalDebits: null, creditsCount: null, debitsCount: null }).reconciliation
}

function differs(a: readonly PlacedRow[], b: readonly PlacedRow[]): boolean {
  const key = (r: PlacedRow) => `${r.tx.date}|${String(r.tx.amount)}|${r.tx.type}|${String(r.tx.balance)}`
  const sa = a.map(key).sort().join('\n')
  const sb = b.map(key).sort().join('\n')
  return sa !== sb
}

export interface ReconciledState {
  tx: Map<string, Transaction[]>
  recs: Map<string, PeriodReconciliation>
}

export interface ReconcileAndRetryResult {
  placed: PlacedRow[]
  state: ReconciledState
  conflictIds: Set<string>
  retried: Set<number>
}

export function reconcileAll(rows: PlacedRow[], summary: AssembledSummary): ReconciledState {
  const tx = materialize(rows)
  const recs = new Map<string, PeriodReconciliation>()
  for (const acc of summary.accounts) {
    for (const p of acc.periods) {
      recs.set(p.id, reconcilePeriod(tx.get(p.id) ?? [], printedOf(p)))
    }
  }
  return { tx, recs }
}

function resolvePageProblemText(rec: PeriodReconciliation['reconciliation'], page: number): string {
  const b = rec.running_balance?.breaks.filter((x) => x.page === page) ?? []
  if (b.length > 0) {
    return `en ${String(b.length)} filas el saldo impreso no coincide con el saldo anterior más o menos el monto (por ejemplo, se esperaba ${String(b[0]?.expected_balance)} y está impreso ${String(b[0]?.printed_balance)}).`
  }
  return `la suma de los movimientos no cuadra con los totales del periodo (diferencia de abonos ${String(rec.totals.credits.difference)}, de cargos ${String(rec.totals.debits.difference)}).`
}

function collectPeriodBrokenPages(
  rec: PeriodReconciliation['reconciliation'],
  metaPages: readonly number[],
  duplicatePages: Set<number>,
  problems: Map<number, string>,
): void {
  const broken = pagesWithBreaks(rec)
  const candidates = (broken.length > 0 ? broken : metaPages.length <= 2 ? metaPages : []).filter((page) => !duplicatePages.has(page))
  for (const page of candidates) {
    if (!problems.has(page)) problems.set(page, resolvePageProblemText(rec, page))
  }
}

function collectBrokenPageProblems(
  summary: AssembledSummary,
  state: ReconciledState,
  duplicatePages: Set<number>,
): Map<number, string> {
  const problems = new Map<number, string>()
  for (const acc of summary.accounts) {
    for (const p of acc.periods) {
      const rec = state.recs.get(p.id)?.reconciliation
      if (!rec || rec.status !== 'not_reconciled') continue
      const meta = summary.periods.find((m) => m.id === p.id)
      collectPeriodBrokenPages(rec, meta?.movementPages ?? [], duplicatePages, problems)
    }
  }
  return problems
}

function markPageConflicts(state: ReconciledState, page: number, conflictIds: Set<string>): void {
  for (const [, list] of state.tx) {
    for (const t of list) {
      if (t.source.page === page) conflictIds.add(t.id)
    }
  }
}

async function retryBrokenPage(
  page: number,
  problem: string,
  placed: PlacedRow[],
  state: ReconciledState,
  summary: AssembledSummary,
  duplicatePages: Set<number>,
  listing: string,
  callChunk: ChunkCaller,
  plan: ModelPlan,
  opts: ExtractOptions,
  issues: IssueSink,
  conflictIds: Set<string>,
  progress: (m: string) => void,
): Promise<{ placed: PlacedRow[]; state: ReconciledState }> {
  const prompt = loadPrompt('extract_retry_page', { page, accounts: listing, problem })
  try {
    progress(`relectura página ${String(page)}`)
    const chunk = await callChunk('retry_page', prompt.id, prompt.text, opts.retryEffort, [page], 32_000, plan.doubleRead)
    const firstOrder = placed.find((r) => r.tx.source.page === page)?.order ?? page * 1000
    const fresh = placeRows(chunk.transactions, [page], summary, firstOrder, issues, duplicatePages)
    const candidate = [...placed.filter((r) => r.tx.source.page !== page), ...fresh]
    const next = reconcileAll(candidate, summary)
    const affected = new Set([...placed, ...fresh].filter((r) => r.tx.source.page === page).map((r) => r.periodId))
    const score = (s: ReconciledState) => [...affected].reduce((acc, id) => acc + reconciliationScore(s.recs.get(id)?.reconciliation ?? emptyRec()), 0)
    const before = score(state)
    const after = score(next)
    const disagree = differs(placed.filter((r) => r.tx.source.page === page), fresh)
    if (after < before) {
      issues.add({ code: 'double_read_conflict', severity: 'info', message: `La relectura de la página ${String(page)} mejoró el cuadre; se usó la segunda lectura.`, page })
      return { placed: candidate, state: next }
    }
    const stillBroken = [...affected].some((id) => (state.recs.get(id)?.reconciliation.running_balance?.breaks ?? []).some((b) => b.page === page))
    if (disagree && stillBroken) {
      markPageConflicts(state, page, conflictIds)
      issues.add({ code: 'double_read_conflict', severity: 'warning', message: `Dos lecturas de la página ${String(page)} no coinciden y ninguna cuadra; sus movimientos quedan en conflicto.`, page })
    }
  } catch (err) {
    issues.add({ code: 'block_failed', severity: 'warning', message: `Falló la relectura de la página ${String(page)}: ${errorText(err)}`, page })
  }
  return { placed, state }
}

export async function reconcileAndRetryStage(
  initialPlaced: PlacedRow[],
  summary: AssembledSummary,
  duplicatePages: Set<number>,
  listing: string,
  callChunk: ChunkCaller,
  plan: ModelPlan,
  opts: ExtractOptions,
  issues: IssueSink,
  progress: (m: string) => void,
): Promise<ReconcileAndRetryResult> {
  let placed = initialPlaced
  let state = reconcileAll(placed, summary)
  const conflictIds = new Set<string>()
  const retried = new Set<number>()
  const problems = collectBrokenPageProblems(summary, state, duplicatePages)

  for (const [page, problem] of [...problems.entries()].slice(0, opts.maxRetryPages)) {
    retried.add(page)
    const res = await retryBrokenPage(page, problem, placed, state, summary, duplicatePages, listing, callChunk, plan, opts, issues, conflictIds, progress)
    placed = res.placed
    state = res.state
  }

  if (problems.size > opts.maxRetryPages) {
    issues.add({
      code: 'running_balance_break',
      severity: 'warning',
      message: `Hay ${String(problems.size)} páginas con problemas aritméticos; solo se releyeron ${String(opts.maxRetryPages)} para acotar el costo.`,
    })
  }

  return { placed, state, conflictIds, retried }
}
