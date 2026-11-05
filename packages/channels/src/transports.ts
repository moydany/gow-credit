/**
 * Transportes de salida. El adaptador no recibe destinatarios de nadie más que del buzón
 * (`outbound_messages`), que copia el destino del vínculo verificado (docs/05 §2b).
 *
 * - `ResendEmailTransport`: API REST de Resend con fetch (sin SDK).
 * - WhatsApp (Baileys) vive en apps/whatsapp, el único proceso con la sesión.
 * - `SimulatedTransport`: los escenarios; guarda lo enviado para que el guion conteste.
 */

export interface OutboundMessage {
  id: string
  channel: 'whatsapp' | 'email'
  destination: string
  body: string
}

export interface Transport {
  readonly channel: 'whatsapp' | 'email'
  send(message: OutboundMessage): Promise<{ externalId: string | null }>
}

export class ResendEmailTransport implements Transport {
  readonly channel = 'email' as const
  readonly #apiKey: string
  readonly #from: string
  readonly #fetch: typeof fetch

  constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) {
    this.#apiKey = opts.apiKey
    this.#from = opts.from
    this.#fetch = opts.fetch ?? fetch
  }

  async send(message: OutboundMessage): Promise<{ externalId: string | null }> {
    const res = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', 'idempotency-key': message.id },
      body: JSON.stringify({ from: this.#from, to: [message.destination], subject: 'Aclaración sobre tu solicitud', text: message.body }),
    })
    // Sin el cuerpo de la respuesta en el error: podría traer el destinatario.
    if (!res.ok) throw new Error(`Resend respondió ${String(res.status)}`)
    const json = (await res.json()) as { id?: string }
    return { externalId: json.id ?? null }
  }
}

export class SimulatedTransport implements Transport {
  readonly sent: OutboundMessage[] = []
  constructor(readonly channel: 'whatsapp' | 'email') {}
  send(message: OutboundMessage): Promise<{ externalId: string | null }> {
    this.sent.push(message)
    return Promise.resolve({ externalId: `sim-${String(this.sent.length)}` })
  }
}
