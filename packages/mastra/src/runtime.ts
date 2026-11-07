/**
 * Mastra instance for standalone: the workflow on libSQL in a file in the output folder. Starting
 * and resuming return the same thing: the request's state and, if paused, the step path to
 * resume it in another CLI invocation.
 */
import { Mastra } from '@mastra/core'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { LibSQLStore } from '@mastra/libsql'
import { AppState, AskSuspend, type AppInput, type AskResume } from './state.ts'
import { createProcessApplication, resolveAnswerPaths, WORKFLOW_ID, type WorkflowDeps } from './workflow.ts'

export interface RunOutcome {
  runId: string
  status: 'success' | 'suspended' | 'failed'
  state: AppState | null
  suspendedStep: string[] | null
  error: string | null
}

/** `storage`: libSQL file (standalone) or an existing store (PostgresStore in full mode, shared). */
export function createRuntime(deps: WorkflowDeps, storage: string | MastraCompositeStore) {
  const processApplication = createProcessApplication(deps)
  const store = typeof storage === 'string' ? new LibSQLStore({ id: 'gow-standalone', url: `file:${storage}` }) : storage
  const mastra = new Mastra({ storage: store, workflows: { processApplication }, logger: false })
  return mastra.getWorkflow('processApplication')
}
export type Runtime = ReturnType<typeof createRuntime>

/** The suspend payload comes nested per sub-workflow; the one for `askOwner` is looked up. */
function findSuspend(payload: unknown): AskSuspend | null {
  const parsed = AskSuspend.safeParse(payload)
  if (parsed.success) return parsed.data
  if (payload !== null && typeof payload === 'object') {
    for (const v of Object.values(payload)) {
      const found = findSuspend(v)
      if (found) return found
    }
  }
  return null
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'error').slice(0, 300) : String(err)
}

type RunResult = Awaited<ReturnType<Awaited<ReturnType<Runtime['createRun']>>['start']>>

function outcome(runId: string, res: RunResult): RunOutcome {
  if (res.status === 'success') return { runId, status: 'success', state: AppState.parse(res.result), suspendedStep: null, error: null }
  if (res.status === 'suspended') {
    const s = findSuspend(res.suspendPayload)
    return { runId, status: 'suspended', state: s?.state ?? null, suspendedStep: res.suspended.at(0) ?? null, error: s ? null : 'la solicitud se pausó sin preguntas legibles' }
  }
  return { runId, status: 'failed', state: null, suspendedStep: null, error: res.status === 'failed' ? errorText(res.error) : `estado inesperado del workflow: ${res.status}` }
}

export async function startApplication(wf: Runtime, input: AppInput): Promise<RunOutcome> {
  const run = await wf.createRun()
  try {
    return outcome(run.runId, await run.start({ inputData: input }))
  } catch (err) {
    // A schema error in the input throws instead of returning failed.
    return { runId: run.runId, status: 'failed', state: null, suspendedStep: null, error: errorText(err) }
  }
}

export async function resumeApplication(wf: Runtime, runId: string, step: string[], resume: AskResume): Promise<RunOutcome> {
  const run = await wf.createRun({ runId })
  try {
    return outcome(runId, await run.resume({ step, resumeData: resolveAnswerPaths(resume) }))
  } catch (err) {
    return { runId, status: 'failed', state: null, suspendedStep: null, error: errorText(err) }
  }
}

export { WORKFLOW_ID }
