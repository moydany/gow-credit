import { describe, expect, it } from 'vitest'
import { geminiThinkingLevel } from './mastra-structured.ts'
import { costUsd, EXPERIMENT_GEMINI_FLASH, EXTRACTION_MODEL, providerOf } from './models.ts'

describe('proveedores y precios', () => {
  it('enruta por prefijo', () => {
    expect(providerOf('claude-opus-5-5')).toBe('anthropic')
    expect(providerOf('gemini-3.8-flash')).toBe('google')
    expect(() => providerOf('gpt-x')).toThrow('sin proveedor')
  })

  it('Gemini cobra lectura de caché y no escritura', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 }
    expect(costUsd(EXPERIMENT_GEMINI_FLASH, u)).toBe(4.575)
    expect(costUsd(EXTRACTION_MODEL, { ...u, cache_creation_input_tokens: 1_000_000 })).toBe(29.2)
  })

  it('effort → thinkingLevel de Gemini', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => geminiThinkingLevel(e as never))).toEqual(['low', 'medium', 'high', 'high', 'high'])
  })
})
