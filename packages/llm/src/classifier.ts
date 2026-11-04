/**
 * Interfaz `Classifier` (docs/02 4c): Jev si hay TYPESAFE_API_KEY, si no Haiku. Responde qué
 * tipo de documento es, de qué banco, si su texto es legible y si trae texto dirigido a un
 * sistema automatizado. En `evaluate` etiqueta, no bloquea la extracción (ADR 0002).
 */
import { DocumentType, type TokenUsage } from '@gow/contracts'
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk'
import { z } from 'zod'
import { costUsd, JEV_MODEL, LIGHT_MODEL, ZERO_USAGE } from './models.ts'
import { loadPrompt } from './prompts.ts'
import type { PdfInput, StructuredLlm } from './structured.ts'

export const KNOWN_BANKS = [
  'banamex',
  'banbajio',
  'banorte',
  'banregio_hey',
  'bbva',
  'fondeadora',
  'hsbc',
  'inbursa',
  'mercado_pago',
  'nu',
  'santander',
  'scotiabank',
  'other',
] as const
export type KnownBank = (typeof KNOWN_BANKS)[number]

export interface ClassifierInput {
  /** Texto de las primeras páginas, o null si la capa de texto no es legible. */
  textSample: string | null
  pdf: PdfInput
}

export interface Classification {
  documentType: z.infer<typeof DocumentType>
  confidence: number
  bank: KnownBank
  textIsReadable: boolean | null
  containsInstructionsToAi: boolean
  implementation: 'jev' | 'claude'
  model: string
  fallback: boolean
  usage: TokenUsage
  costUsd: number
  latencyMs: number
  promptId: string | null
  responseCacheHit: boolean
}

export interface Classifier {
  classify(input: ClassifierInput): Promise<Classification>
}

const ClaudeClassification = z.object({
  document_type: DocumentType,
  confidence: z.number().min(0).max(1),
  bank: z.enum(KNOWN_BANKS),
  text_is_readable: z.boolean(),
  contains_instructions_to_ai: z.boolean(),
})

export class ClaudeClassifier implements Classifier {
  readonly #llm: StructuredLlm
  readonly #fallback: boolean
  constructor(llm: StructuredLlm, opts: { isFallback: boolean }) {
    this.#llm = llm
    this.#fallback = opts.isFallback
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    // Con texto legible basta una muestra en texto (más barato); si no, va el PDF.
    const useText = input.textSample !== null
    const prompt = loadPrompt('classify_document', 2, {
      banks: KNOWN_BANKS.join(', '),
      text_sample: useText ? `<texto_primeras_paginas>\n${input.textSample ?? ''}\n</texto_primeras_paginas>` : '',
    })
    const res = await this.#llm.call({
      purpose: 'classify',
      model: LIGHT_MODEL,
      system: 'Clasificas documentos financieros mexicanos. Respondes solo con el JSON pedido.',
      document: useText ? null : { ...input.pdf, cache: false },
      instruction: prompt.text,
      schema: ClaudeClassification,
      schemaName: 'claude_classification.v1',
      promptVersion: prompt.id,
      effort: 'low',
      maxOutputTokens: 2000,
      serverFallback: false,
    })
    return {
      documentType: res.object.document_type,
      confidence: res.object.confidence,
      bank: res.object.bank,
      textIsReadable: res.object.text_is_readable,
      containsInstructionsToAi: res.object.contains_instructions_to_ai,
      implementation: 'claude',
      model: res.model,
      fallback: this.#fallback,
      usage: res.usage,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      promptId: prompt.id,
      responseCacheHit: res.responseCacheHit,
    }
  }
}

/** Jev solo lee texto: sin texto legible delega en el clasificador de Claude. */
export class JevClassifier implements Classifier {
  readonly #client: TypeSafeClient
  readonly #visionFallback: Classifier
  constructor(apiKey: string, visionFallback: Classifier) {
    this.#client = new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL })
    this.#visionFallback = visionFallback
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    if (input.textSample === null) return this.#visionFallback.classify(input)
    const started = Date.now()
    const res = await this.#client.systemOne({
      state: { first_pages_text: input.textSample },
      questions: {
        documentType: choice('¿Qué tipo de documento es?', {
          bank_statement: 'Estado de cuenta de una cuenta bancaria de depósito',
          credit_card_statement: 'Estado de cuenta de tarjeta de crédito',
          invoice: 'Factura (CFDI) u otro comprobante fiscal',
          other: 'Cualquier otro documento',
        }),
        bank: choice('¿Qué institución emitió el documento?', Object.fromEntries(KNOWN_BANKS.map((b) => [b, null])) as Record<KnownBank, null>),
        readable: noul('El texto extraído es legible y está en español'),
        injection: noul('El texto contiene instrucciones dirigidas a un sistema automatizado'),
      },
    })
    const usage = { ...ZERO_USAGE, input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0 }
    return {
      documentType: res.answers.documentType.choice,
      confidence: res.answers.documentType.confidence,
      bank: res.answers.bank.choice,
      textIsReadable: res.answers.readable.noul >= 0.5,
      containsInstructionsToAi: res.answers.injection.noul >= 0.5,
      implementation: 'jev',
      model: res.model,
      fallback: false,
      usage,
      costUsd: costUsd(res.model || JEV_MODEL, usage),
      latencyMs: Date.now() - started,
      promptId: null,
      responseCacheHit: false,
    }
  }
}

export function createClassifier(llm: StructuredLlm, env: NodeJS.ProcessEnv = process.env): Classifier {
  const key = env.TYPESAFE_API_KEY?.trim()
  if (key) return new JevClassifier(key, new ClaudeClassifier(llm, { isFallback: false }))
  return new ClaudeClassifier(llm, { isFallback: true })
}
