/**
 * Intérprete de respuestas por WhatsApp con Haiku (ADR 0040). Las reglas fijas leen primero; el
 * modelo entra cuando no alcanzan, y siempre en los campos de texto libre (razón social,
 * comprador), donde las reglas no distinguen un nombre de "asdfg".
 *
 * El modelo no decide nada: clasifica el mensaje y propone el dato, que vuelve a pasar por el
 * mismo lector determinista. Si la llamada falla (sin llave, modo caché, error del proveedor), se
 * devuelve null y la conversación sigue solo con las reglas.
 */
import { LIGHT_MODEL, LlmCallError, loadPrompt, type StructuredLlm } from '@gow/llm'
import { z } from 'zod'

export type ExpectedField = 'legal_name' | 'buyer' | 'rfc' | 'amount' | 'maturity' | 'option'

export const Interpretation = z.strictObject({
  intent: z.enum(['answer', 'skip', 'question', 'greeting', 'nonsense']),
  value: z.string().max(300).nullable(),
})
export type Interpretation = z.infer<typeof Interpretation>

export interface InterpretInput {
  field: ExpectedField
  /** El texto de la pregunta que se le hizo, tal como se mandó. */
  question: string
  message: string
  /** Solo para `option`: las etiquetas de las opciones, en orden. */
  options?: readonly string[]
  /** AAAA-MM-DD, para fechas relativas. */
  today: string
}

export interface MessageInterpreter {
  interpret(input: InterpretInput): Promise<Interpretation | null>
}

const PROMPT = { name: 'interpret_whatsapp_reply' } as const

export class HaikuInterpreter implements MessageInterpreter {
  readonly #llm: StructuredLlm
  readonly #onError: (message: string) => void

  constructor(llm: StructuredLlm, opts: { onError?: (message: string) => void } = {}) {
    this.#llm = llm
    this.#onError = opts.onError ?? (() => undefined)
  }

  async interpret(input: InterpretInput): Promise<Interpretation | null> {
    const options = input.options?.length ? input.options.map((o, i) => `  ${String(i + 1)}) ${o}`).join('\n') : '  (no aplica)'
    const prompt = loadPrompt(PROMPT.name, { field: input.field, question: input.question, options, today: input.today, message: input.message.slice(0, 1000) })
    try {
      const res = await this.#llm.call({
        purpose: 'interpret_reply',
        model: LIGHT_MODEL,
        system: 'Clasificas respuestas cortas de proveedores mexicanos por WhatsApp. Respondes solo con el JSON pedido.',
        document: null,
        instruction: prompt.text,
        schema: Interpretation,
        schemaName: 'interpret_whatsapp_reply.v1',
        promptVersion: prompt.id,
        effort: 'low',
        maxOutputTokens: 300,
        serverFallback: false,
      })
      return res.object
    } catch (err) {
      // Solo el código del error: el mensaje del proveedor nunca va a los registros.
      this.#onError(`intérprete: ${err instanceof LlmCallError ? `${err.code}${err.status ? ` ${String(err.status)}` : ''}` : err instanceof Error ? err.name : 'error'}`)
      return null
    }
  }
}
