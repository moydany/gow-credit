/**
 * Outbound transports. Recipients come only from the outbox (`outbound_messages`), which copies
 * the address of the verified link.
 *
 * - `ResendEmailTransport`: Resend REST API over fetch (no SDK).
 * - WhatsApp (Baileys) lives in apps/whatsapp, the only process holding the session.
 * - `SimulatedTransport`: scenarios; records what was sent so the script can answer.
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
    // Response body left out of the error: it could contain the recipient.
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
