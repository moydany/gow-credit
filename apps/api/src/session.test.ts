import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { clearedCookies, issueToken, openRefresh, readCookie, refreshCookie, refreshRemaining, sealRefresh, verifyToken, type RefreshPayload } from './session.ts'

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

describe('Cookie de refresh cifrada (ADR 0036)', () => {
  const NOW = 1_800_000_000
  const limits = { maxSeconds: 12 * 3600, idleSeconds: 8 * 3600 }
  const payload: RefreshPayload = { v: 1, rt: 'refresh-token-de-gotrue', sub: claims.sub, iat: NOW - 3600, rat: NOW - 600 }

  it('ida y vuelta: lo que se sella se abre igual, y el refresh token no viaja en claro', () => {
    const sealed = sealRefresh(SECRET, payload)
    expect(openRefresh(SECRET, sealed, limits, NOW)).toEqual(payload)
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain(payload.rt)
    // IV aleatorio: dos sellos del mismo contenido no se parecen.
    expect(sealRefresh(SECRET, payload)).not.toBe(sealed)
  })

  it('alterada en cualquier byte, truncada o basura: se rechaza', () => {
    const raw = Buffer.from(sealRefresh(SECRET, payload), 'base64url')
    for (const i of [0, 12, Math.floor(raw.length / 2), raw.length - 1]) {
      const t = Buffer.from(raw)
      t[i] = (t[i] ?? 0) ^ 0x01
      expect(openRefresh(SECRET, t.toString('base64url'), limits, NOW)).toBeNull()
    }
    expect(openRefresh(SECRET, raw.subarray(0, raw.length - 1).toString('base64url'), limits, NOW)).toBeNull()
    expect(openRefresh(SECRET, 'basura', limits, NOW)).toBeNull()
    expect(openRefresh(SECRET, '', limits, NOW)).toBeNull()
  })

  it('sellada con otra llave: se rechaza', () => {
    expect(openRefresh(SECRET, sealRefresh('otro-secreto-del-backoffice', payload), limits, NOW)).toBeNull()
  })

  it('pasado el límite absoluto o el de inactividad: se rechaza', () => {
    const old = sealRefresh(SECRET, { ...payload, iat: NOW - 12 * 3600, rat: NOW - 60 })
    expect(openRefresh(SECRET, old, limits, NOW)).toBeNull()
    expect(openRefresh(SECRET, old, limits, NOW - 61)).not.toBeNull()
    const idle = sealRefresh(SECRET, { ...payload, iat: NOW - 9 * 3600, rat: NOW - 8 * 3600 })
    expect(openRefresh(SECRET, idle, limits, NOW)).toBeNull()
    // Un inicio en el futuro o una renovación anterior al inicio no son de esta API.
    expect(openRefresh(SECRET, sealRefresh(SECRET, { ...payload, iat: NOW + 3600, rat: NOW + 3600 }), limits, NOW)).toBeNull()
    expect(openRefresh(SECRET, sealRefresh(SECRET, { ...payload, rat: payload.iat - 1 }), limits, NOW)).toBeNull()
  })

  it('lo que le queda a la sesión es el primero de los dos límites', () => {
    expect(refreshRemaining(payload, limits, NOW)).toBe(8 * 3600 - 600)
    expect(refreshRemaining({ ...payload, iat: NOW - 11 * 3600 }, limits, NOW)).toBe(3600)
  })

  it('las dos cookies: HttpOnly, SameSite=Strict, Path=/bo; borrarlas pone Max-Age=0', () => {
    const c = refreshCookie('x', { maxAgeSeconds: 100, secure: true })
    expect(c).toBe('gow_refresh=x; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=100; Secure')
    expect(clearedCookies(false)).toEqual(['gow_session=; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=0', 'gow_refresh=; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=0'])
  })
})
