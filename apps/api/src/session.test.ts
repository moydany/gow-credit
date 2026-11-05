import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { issueToken, readCookie, verifyToken } from './session.ts'

const claims = { sub: randomUUID(), email: 'analista@prestamista.test', tenant_id: randomUUID() }
const SECRET = 'secreto-de-pruebas-del-backoffice'

describe('JWT del backoffice', () => {
  it('un token vigente y bien firmado entrega sus claims', () => {
    expect(verifyToken(SECRET, issueToken(SECRET, claims, 60))).toMatchObject(claims)
  })

  it('rechaza una firma ajena, un token vencido y un cuerpo alterado', () => {
    expect(verifyToken(SECRET, issueToken('otro-secreto', claims, 60))).toBeNull()
    expect(verifyToken(SECRET, issueToken(SECRET, claims, 60, 1_000))).toBeNull()
    const [h, , s] = issueToken(SECRET, claims, 60).split('.') as [string, string, string]
    const forged = Buffer.from(JSON.stringify({ ...claims, tenant_id: randomUUID(), exp: 9_999_999_999 })).toString('base64url')
    expect(verifyToken(SECRET, `${h}.${forged}.${s}`)).toBeNull()
  })

  it('no acepta alg none ni otro algoritmo', () => {
    const body = Buffer.from(JSON.stringify({ ...claims, exp: 9_999_999_999 })).toString('base64url')
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    expect(verifyToken(SECRET, `${none}.${body}.`)).toBeNull()
    expect(verifyToken(SECRET, 'basura')).toBeNull()
  })

  it('lee una cookie entre varias', () => {
    expect(readCookie('a=1; gow_session=xyz; b=2', 'gow_session')).toBe('xyz')
    expect(readCookie(undefined, 'gow_session')).toBeNull()
  })
})
