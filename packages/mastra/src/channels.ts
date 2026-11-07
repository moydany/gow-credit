/**
 * `ClarificationChannel`: how the question reaches the owner. Standalone has two: the file
 * mailbox (the message as it would be sent, next to the results) and the CLI's interactive
 * console, which reads answers from the terminal. Baileys and Resend implement the same
 * interface. Input (answers) does not go through here: it always ends in `run.resume()` with
 * Zod-validated answers.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Question } from '@gow/contracts'

export interface ClarificationChannel {
  readonly name: string
  send(applicationId: string, round: number, questions: readonly Question[]): Promise<void>
}

/** The plain-text message, numbered, as the owner would read it. */
export function renderMessage(questions: readonly Question[]): string {
  const lines = ['Hola. Para terminar de evaluar tu solicitud necesitamos aclarar lo siguiente:', '']
  questions.forEach((q, i) => {
    lines.push(`${String(i + 1)}. ${q.text}`)
    if (q.options.length > 0) lines.push(`   Opciones: ${q.options.map((o) => o.label).join(' / ')}`)
  })
  lines.push('', 'Gracias.')
  return lines.join('\n')
}

/** Writes the message to `<dir>/<solicitud>.ronda-<n>.txt`. Holds document data: output dir, not logs. */
export class OutboxChannel implements ClarificationChannel {
  readonly name = 'outbox'
  readonly #dir: string
  constructor(dir: string) {
    this.#dir = dir
  }

  send(applicationId: string, round: number, questions: readonly Question[]): Promise<void> {
    mkdirSync(this.#dir, { recursive: true })
    writeFileSync(join(this.#dir, `${applicationId}.ronda-${String(round)}.txt`), `${renderMessage(questions)}\n`)
    return Promise.resolve()
  }
}

/** For tests and interactive mode: keeps what was sent in memory. */
export class MemoryChannel implements ClarificationChannel {
  readonly name = 'memory'
  readonly sent: { applicationId: string; round: number; questions: Question[] }[] = []
  send(applicationId: string, round: number, questions: readonly Question[]): Promise<void> {
    this.sent.push({ applicationId, round, questions: [...questions] })
    return Promise.resolve()
  }
}
