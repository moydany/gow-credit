/** Active prompt refresh: loads, changes with the database and survives a failure. */
import { createHash } from 'node:crypto'
import { clearActivePrompts, loadPrompt, type ActivePromptInput } from '@gow/llm'
import { afterEach, describe, expect, it } from 'vitest'
import { startPromptRefresh } from './prompts.ts'

const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const edited = (text: string): ActivePromptInput => ({ name: 'next_steps', version: 2, source: 'backoffice', fileVersion: null, text, sha256: sha(text) })

afterEach(() => {
  clearActivePrompts()
})

describe('startPromptRefresh', () => {
  it('aplica la versión activa, la cambia al refrescar y conserva la última si la base falla', async () => {
    const logs: string[] = []
    let rows: ActivePromptInput[] | Error = [edited('Pasos: {{steps}}')]
    const r = await startPromptRefresh({
      load: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)),
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) },
      intervalMs: 60_000,
    })
    expect(loadPrompt('next_steps', { steps: '[]' }).text).toBe('Pasos: []')
    expect(logs).toEqual([`prompts de la base: 1 activos · distintos al código: next_steps.db2-${sha('Pasos: {{steps}}').slice(0, 8)}`])

    await r.refresh()
    expect(logs).toHaveLength(1)

    rows = Object.assign(new Error('caída'), { code: 'ECONNREFUSED' })
    await r.refresh()
    expect(logs.at(-1)).toBe('ERROR no se pudieron leer los prompts de la base (ECONNREFUSED); siguen los últimos cargados')
    expect(loadPrompt('next_steps', { steps: '[]' }).text).toBe('Pasos: []')

    rows = []
    await r.refresh()
    expect(loadPrompt('next_steps', { steps: '[]' }).id).toBe('next_steps.v1')
    expect(logs.at(-1)).toBe('prompts de la base: 0 activos · todos en la versión del código')
    r.stop()
  })
})
