/**
 * Caché en disco por hash de la entrada para lo que no pasa por `CachingStructuredLlm` (Jev no es
 * una llamada estructurada de Claude o Gemini). Mismo modo que la caché de respuestas: `off`,
 * `read` (un miss falla: CI sin llaves) o `readwrite`. Vive en data/ (no se versiona: contiene
 * datos del documento).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CacheMode } from './response-cache.ts'

export class CacheMissError extends Error {
  constructor(what: string) {
    super(`${what}: la respuesta no está en caché y la caché es de solo lectura`)
    this.name = 'CacheMissError'
  }
}

export function hashKey(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export class JsonFileCache {
  readonly #dir: string
  readonly mode: CacheMode
  constructor(dir: string, mode: CacheMode) {
    this.#dir = dir
    this.mode = mode
  }

  #path(key: string): string {
    return join(this.#dir, key.slice(0, 2), `${key}.json`)
  }

  get(key: string): unknown {
    if (this.mode === 'off') return null
    const path = this.#path(key)
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null
  }

  set(key: string, value: unknown): void {
    if (this.mode !== 'readwrite') return
    const path = this.#path(key)
    mkdirSync(join(this.#dir, key.slice(0, 2)), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(value))
    renameSync(`${path}.tmp`, path)
  }

  /** Devuelve lo guardado o corre `compute` (si el modo lo permite) y lo guarda. */
  async through<T>(key: string, what: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = this.get(key)
    if (cached !== null) return { value: cached as T, hit: true }
    if (this.mode === 'read') throw new CacheMissError(what)
    const value = await compute()
    this.set(key, value)
    return { value, hit: false }
  }
}
