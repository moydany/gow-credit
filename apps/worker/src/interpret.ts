/**
 * WhatsApp reply interpreter using Haiku. The fixed rules read first; the model steps in when they
 * fall short, always on free-text fields (legal name, buyer), where rules cannot tell a name from
 * "asdfg".
 *
 * The model decides nothing: it classifies the message and proposes the value, which goes back
 * through the same deterministic reader. If the call fails (no key, cache mode, provider error),
 * it returns null and the conversation continues with the rules only.
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
  /** The text of the question asked, as sent. */
  question: string
  message: string
  /** `option` only: the option labels, in order. */
  options?: readonly string[]
  /** YYYY-MM-DD, for relative dates. */
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
      // Error code only: the provider's message never goes to the logs.
      this.#onError(`intérprete: ${err instanceof LlmCallError ? `${err.code}${err.status ? ` ${String(err.status)}` : ''}` : err instanceof Error ? err.name : 'error'}`)
      return null
    }
  }
}
