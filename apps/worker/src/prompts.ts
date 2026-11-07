/**
 * Prompts activos de la base (ADR 0065). El worker los carga al arrancar y los refresca cada pocos
 * segundos: activar una versión en el backoffice llega a las llamadas siguientes sin reiniciar. Si la
 * base no responde, siguen los últimos cargados (o los archivos, si nunca cargó). Solo se registran
 * ids de prompt, nunca su texto.
 */
import { PROMPT_CATALOG, filePromptId } from '@gow/contracts'
import { setActivePrompts, type ActivePromptInput } from '@gow/llm'

export interface PromptRefreshDeps {
  load(): Promise<ActivePromptInput[]>
  logger: { info(message: string): void; error(message: string): void }
  intervalMs?: number
}

export interface PromptRefresh {
  /** Recarga ahora; resuelve aunque falle (el error queda en el registro). */
  refresh(): Promise<void>
  stop(): void
}

export async function startPromptRefresh(deps: PromptRefreshDeps): Promise<PromptRefresh> {
  let last = ''
  const refresh = async () => {
    try {
      const report = setActivePrompts(await deps.load())
      // Solo cuando cambia algo: el estado inicial y cada activación.
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
