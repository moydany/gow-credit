/**
 * Prompt loader: without a database it reads the file the catalog pins; with active versions
 * loaded from the database it reads those, and anything unusable falls back to the file. The
 * response cache key changes with the prompt text and stays the same if the text is the file's.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROMPT_CATALOG, PROMPT_NAMES, promptPlaceholders, splitPromptFile } from '@gow/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clearActivePrompts, loadPrompt, loadPromptFile, promptCacheTag, setActivePrompts } from './prompts.ts'
import { requestKey } from './response-cache.ts'

/** The `extract_summary` file version the catalog pins. */
const SUMMARY = PROMPT_CATALOG.extract_summary.version

const DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const sha = (t: string) => createHash('sha256').update(t).digest('hex')

function keyFor(name: 'extract_summary') {
  const p = loadPrompt(name, { page_count: 4 })
  return requestKey({ purpose: 'summary', model: 'm', system: 's', document: null, instruction: p.text, schema: z.object({ a: z.string() }), schemaName: 'x.v1', promptVersion: p.id, effort: 'low', maxOutputTokens: 10, serverFallback: false })
}

afterEach(() => {
  clearActivePrompts()
})

describe('catálogo y archivos', () => {
  it.each(PROMPT_NAMES)('%s: el archivo por defecto existe y usa exactamente las variables del catálogo', (name) => {
    const path = `${DIR}${name}.v${String(PROMPT_CATALOG[name].version)}.md`
    expect(existsSync(path)).toBe(true)
    const { body } = splitPromptFile(readFileSync(path, 'utf8'))
    expect(promptPlaceholders(body).sort()).toEqual([...PROMPT_CATALOG[name].variables].sort())
  })
})

describe('sin base (modo standalone)', () => {
  it('sale del archivo que fija el catálogo, sin el bloque de metadatos', () => {
    const p = loadPrompt('extract_summary', { page_count: 7 })
    expect(p).toMatchObject({ id: `extract_summary.v${String(SUMMARY)}`, source: 'file' })
    expect(p.text).toBe(loadPromptFile('extract_summary', SUMMARY, { page_count: 7 }).text)
    expect(p.text.startsWith('<!--')).toBe(false)
    expect(p.text).toContain('7')
    expect(promptCacheTag('extract_summary')).toBeNull()
  })

  it('una variable que falta es un error', () => {
    expect(() => loadPrompt('extract_summary')).toThrow(/page_count/)
  })
})

describe('con versiones activas de la base (modo full)', () => {
  it('usa la versión activa; su id lleva el número y la huella, y cambia la llave de caché', () => {
    const before = keyFor('extract_summary')
    const text = 'Resume el estado de cuenta de {{page_count}} páginas.'
    const report = setActivePrompts([{ name: 'extract_summary', version: 3, source: 'backoffice', fileVersion: null, text, sha256: sha(text) }])
    expect(report).toEqual({ loaded: [`extract_summary.db3-${sha(text).slice(0, 8)}`], rejected: [] })
    const p = loadPrompt('extract_summary', { page_count: 5 })
    expect(p).toMatchObject({ id: `extract_summary.db3-${sha(text).slice(0, 8)}`, source: 'db', text: 'Resume el estado de cuenta de 5 páginas.' })
    expect(promptCacheTag('extract_summary')).toBe(p.id)
    expect(keyFor('extract_summary')).not.toBe(before)
    // The other prompts still come from their file.
    expect(loadPrompt('extract_system')).toMatchObject({ id: 'extract_system.v1', source: 'file' })
  })

  it('la versión de archivo sembrada en la base conserva la id y la llave de caché del archivo', () => {
    const before = keyFor('extract_summary')
    const body = loadPromptFile('extract_summary', SUMMARY, { page_count: '{{page_count}}' }).text
    setActivePrompts([{ name: 'extract_summary', version: SUMMARY, source: 'file', fileVersion: SUMMARY, text: body, sha256: sha(body) }])
    expect(loadPrompt('extract_summary', { page_count: 4 })).toMatchObject({ id: `extract_summary.v${String(SUMMARY)}`, source: 'db' })
    expect(promptCacheTag('extract_summary')).toBeNull()
    expect(keyFor('extract_summary')).toBe(before)
  })

  it('activar una versión de archivo anterior también cambia la etiqueta de caché', () => {
    const body = loadPromptFile('classify_document', 1, { banks: '{{banks}}', text_sample: '{{text_sample}}' }).text
    setActivePrompts([{ name: 'classify_document', version: 1, source: 'file', fileVersion: 1, text: body, sha256: sha(body) }])
    expect(promptCacheTag('classify_document')).toBe('classify_document.v1')
  })

  it('una versión con variables que el código no pasa, o fuera del catálogo, se ignora y sigue el archivo', () => {
    const bad = 'Usa {{page_count}} y {{inventada}}.'
    const report = setActivePrompts([
      { name: 'extract_summary', version: 4, source: 'backoffice', fileVersion: null, text: bad, sha256: sha(bad) },
      { name: 'otro', version: 1, source: 'backoffice', fileVersion: null, text: 'x', sha256: sha('x') },
    ])
    expect(report.loaded).toEqual([])
    expect(report.rejected).toEqual(['extract_summary: usa {{inventada}}', 'otro: no está en el catálogo'])
    expect(loadPrompt('extract_summary', { page_count: 1 }).id).toBe(`extract_summary.v${String(SUMMARY)}`)
  })

  it('clearActivePrompts vuelve a los archivos', () => {
    setActivePrompts([{ name: 'next_steps', version: 2, source: 'backoffice', fileVersion: null, text: 'Pasos: {{steps}}', sha256: sha('Pasos: {{steps}}') }])
    clearActivePrompts()
    expect(loadPrompt('next_steps', { steps: '[]' }).id).toBe('next_steps.v1')
  })
})
