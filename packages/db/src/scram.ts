import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/**
 * SCRAM-SHA-256 verifier in the format Postgres stores in pg_authid (RFC 5802/7677). Sending it in
 * `ALTER ROLE ... PASSWORD '<verifier>'` sets the password without the plain text ever reaching the
 * server, so it can't end up in a statement log.
 */
export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  const salt = opts.salt ?? randomBytes(16)
  const iterations = opts.iterations ?? 4096
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}
