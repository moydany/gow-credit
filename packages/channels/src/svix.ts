/**
 * Firma de webhooks de Resend (Svix; docs/05 §5): HMAC-SHA256 de `id.timestamp.cuerpo` con el
 * secreto `whsec_...` en base64, ventana de tiempo contra replay y comparación en tiempo constante.
 * Sin dependencia: es una función de 20 líneas y así no entra otro paquete a la cadena de suministro.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SvixHeaders {
  id: string | undefined
  timestamp: string | undefined
  signature: string | undefined
}

export const SVIX_TOLERANCE_SECONDS = 300

export function signSvix(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return createHmac('sha256', key).update(`${id}.${String(timestamp)}.${body}`).digest('base64')
}

export function verifySvix(secret: string, headers: SvixHeaders, body: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > SVIX_TOLERANCE_SECONDS) return false
  const expected = Buffer.from(signSvix(secret, id, ts, body))
  // El encabezado trae una o varias firmas "v1,<base64>" separadas por espacio (rotación de secretos).
  return signature.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) return false
    const got = Buffer.from(sig)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}
