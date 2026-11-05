/**
 * `ClarificationChannel` (docs/02 §3): cómo le llega la pregunta al dueño. En standalone hay dos:
 * el buzón en archivo (el mensaje tal como se enviaría, junto a los resultados) y la consola
 * interactiva del CLI, que lee las respuestas de la terminal. Baileys y Resend son de la fase 6 y
 * cumplen la misma interfaz. La entrada (respuestas) no pasa por aquí: siempre termina en
 * `run.resume()` con respuestas validadas por Zod.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Question } from '@gow/contracts'

export interface ClarificationChannel {
  readonly name: string
  send(applicationId: string, round: number, questions: readonly Question[]): Promise<void>
}

/** El mensaje en texto plano, numerado, como lo leería el dueño. */
export function renderMessage(questions: readonly Question[]): string {
  const lines = ['Hola. Para terminar de evaluar tu solicitud necesitamos aclarar lo siguiente:', '']
  questions.forEach((q, i) => {
    lines.push(`${String(i + 1)}. ${q.text}`)
    if (q.options.length > 0) lines.push(`   Opciones: ${q.options.map((o) => o.label).join(' / ')}`)
  })
  lines.push('', 'Gracias.')
  return lines.join('\n')
}

/** Escribe el mensaje en `<dir>/<solicitud>.ronda-<n>.txt`. Contiene datos del documento: el dir es de salida, no de logs. */
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

/** Para tests y para el modo interactivo: guarda lo enviado en memoria. */
export class MemoryChannel implements ClarificationChannel {
  readonly name = 'memory'
  readonly sent: { applicationId: string; round: number; questions: Question[] }[] = []
  send(applicationId: string, round: number, questions: readonly Question[]): Promise<void> {
    this.sent.push({ applicationId, round, questions: [...questions] })
    return Promise.resolve()
  }
}
