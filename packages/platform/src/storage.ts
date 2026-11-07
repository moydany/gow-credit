/**
 * Documents. The client does not send the PDF to the API: it asks for a short-lived signed URL
 * and uploads directly. The API never downloads PDFs from user URLs (SSRF): it only reads from
 * its own storage, and the path starts with the tenant.
 *
 * `LocalDocumentStorage` is for development and scenarios: a directory and an HMAC token with
 * expiry that the API itself validates. In production Supabase Storage fulfills the same
 * contract (private bucket, `createSignedUploadUrl`); that adapter belongs to deployment.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024
export const UPLOAD_TTL_SECONDS = 600

export interface SignedUpload {
  url: string
  path: string
  expires_at: string
}

export interface DocumentStorage {
  /** New path under the tenant and its signed upload URL. `extension` only changes in scenarios. */
  createSignedUpload(tenantId: string, ttlSeconds?: number, extension?: string): SignedUpload
  put(path: string, bytes: Buffer): Promise<void>
  read(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>
  /** Deletes the file; if it no longer exists that is not an error. */
  remove(path: string): Promise<void>
}

/** Does the path belong to this tenant and stay inside the directory? */
export function pathBelongsTo(path: string, tenantId: string): boolean {
  return path.startsWith(`${tenantId}/`) && !path.includes('..') && !path.includes('\\')
}

export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-'
}

export class LocalDocumentStorage implements DocumentStorage {
  readonly #root: string
  readonly #secret: Buffer
  readonly #publicBaseUrl: string

  constructor(opts: { root: string; secret: string; publicBaseUrl: string }) {
    this.#root = opts.root
    this.#secret = Buffer.from(opts.secret)
    this.#publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '')
  }

  #file(path: string): string {
    const full = normalize(join(this.#root, path))
    if (!full.startsWith(normalize(this.#root) + sep)) throw new Error('ruta fuera del almacenamiento')
    return full
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#secret).update(payload).digest('base64url')
  }

  createSignedUpload(tenantId: string, ttlSeconds = UPLOAD_TTL_SECONDS, extension = '.pdf'): SignedUpload {
    const path = `${tenantId}/${randomUUID()}${extension}`
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const payload = Buffer.from(JSON.stringify({ path, exp })).toString('base64url')
    return { url: `${this.#publicBaseUrl}/storage/upload/${payload}.${this.#sign(payload)}`, path, expires_at: new Date(exp * 1000).toISOString() }
  }

  /** The path a valid upload token authorizes, or null. */
  verifyUploadToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
    const [payload, sig] = token.split('.')
    if (!payload || !sig) return null
    const expected = Buffer.from(this.#sign(payload))
    const got = Buffer.from(sig)
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { path?: unknown; exp?: unknown }
    if (typeof parsed.path !== 'string' || typeof parsed.exp !== 'number' || parsed.exp < nowSeconds) return null
    return parsed.path
  }

  async put(path: string, bytes: Buffer): Promise<void> {
    const file = this.#file(path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }

  async read(path: string): Promise<Buffer> {
    return readFile(this.#file(path))
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.#file(path))
      return true
    } catch {
      return false
    }
  }
  async remove(path: string): Promise<void> {
    await rm(this.#file(path), { force: true })
  }
}
