/**
 * Active prompts from the database. The worker loads them at startup and refreshes every few
 * seconds: activating a version in the backoffice reaches later calls without a restart. If the
 * database does not respond, the last loaded ones stay (or the files, if it never loaded). Only
 * prompt ids are logged, never their text.
 */
import { PROMPT_CATALOG, filePromptId } from '@gow/contracts'
import { setActivePrompts, type ActivePromptInput } from '@gow/llm'

export interface PromptRefreshDeps {
  load(): Promise<ActivePromptInput[]>
  logger: { info(message: string): void; error(message: string): void }
  intervalMs?: number
}

export interface PromptRefresh {
  /** Reload now; resolves even on failure (the error is logged). */
  refresh(): Promise<void>
  stop(): void
}

export async function startPromptRefresh(deps: PromptRefreshDeps): Promise<PromptRefresh> {
  let last = ''
  const refresh = async () => {
    try {
      const report = setActivePrompts(await deps.load())
      // Only when something changes: the initial state and each activation.
      const custom = report.loaded.filter((id) => !Object.entries(PROMPT_CATALOG).some(([name, c]) => id === filePromptId(name, c.version)))
      const signature = [...report.loaded, ...report.rejected].join('|')
      if (signature === last) return
      last = signature
      deps.logger.info(`prompts de la base: ${String(report.loaded.length)} activos${custom.length ? ` · distintos al código: ${custom.join(', ')}` : ' · todos en la versión del código'}`)
      for (const r of report.rejected) deps.logger.error(`prompt de la base ignorado, sigue el archivo: ${r}`)
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err instanceof Error ? err.name : 'error')
      deps.logger.error(`no se pudieron leer los prompts de la base (${code}); siguen los últimos cargados`)
    }
  }
  await refresh()
  const timer = setInterval(() => void refresh(), deps.intervalMs ?? 15_000)
  timer.unref()
  return { refresh, stop: () => { clearInterval(timer) } }
}
