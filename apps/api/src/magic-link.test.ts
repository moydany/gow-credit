/**
 * Email login with a simulated GoTrue and no database: these routes do not touch Postgres
 * (except config, which asks whether first-run setup is pending and gets a fake database here).
 * Always 202 with the same body whether or not the account exists; anti-CSRF; rate limit per IP
 * (429) and per email (silent); without Supabase Auth the route does not exist and config says so.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Db } from '@gow/db'
import type { DocumentStorage, PgBoss } from '@gow/platform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { AuthDirectory } from './supabase-auth.ts'

const SECRET = 'secreto-de-pruebas-del-backoffice'
const MEMBERS = new Set(['a@prestamista.test', 'b@prestamista.test'])

function fakeAuth() {
  const links: { email: string; redirectTo: string }[] = []
  const auth: AuthDirectory = {
    ensureUser: () => Promise.reject(new Error('no se usa aquí')),
    sendMagicLink: (email, redirectTo) => {
      links.push({ email, redirectTo })
      return Promise.resolve(MEMBERS.has(email))
    },
    refreshSession: () => Promise.resolve(null),
    revokeSession: () => Promise.resolve(),
  }
  return { auth, links }
}

async function serve(auth: AuthDirectory | null): Promise<{ server: Server; base: string }> {
  const server = createServer(createApp({ db: { execute: () => Promise.resolve({ rows: [{ pending: false }] }) } as unknown as Db, boss: {} as PgBoss, storage: {} as DocumentStorage, backofficeJwtSecret: SECRET, backofficeUrl: 'https://bo.prestamista.test/', auth }))
  server.listen(0)
  await new Promise((r) => server.once('listening', r))
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/bo/v1` }
}

async function post(base: string, body: unknown, csrf = true) {
  const res = await fetch(`${base}/session/magic-link`, { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-gow-backoffice': '1' } : {}) }, body: JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('Backoffice: enlace de acceso por correo', () => {
  const fake = fakeAuth()
  let on: { server: Server; base: string }
  let off: { server: Server; base: string }

  beforeAll(async () => {
    on = await serve(fake.auth)
    off = await serve(null)
  })
  afterAll(async () => {
    await new Promise((r) => on.server.close(r))
    await new Promise((r) => off.server.close(r))
  })

  it('la configuración dice si hay login por correo', async () => {
    expect(await (await fetch(`${on.base}/session/config`)).json()).toEqual({ magic_link: true, setup_required: false, setup_password: false })
    expect(await (await fetch(`${off.base}/session/config`)).json()).toEqual({ magic_link: false, setup_required: false, setup_password: false })
  })

  it('misma respuesta 202 exista o no la cuenta; el enlace apunta a /entrar del backoffice', async () => {
    const member = await post(on.base, { email: ' A@Prestamista.test ' })
    const nobody = await post(on.base, { email: 'nadie@prestamista.test' })
    expect(member).toEqual({ status: 202, text: '{"accepted":true}' })
    expect(nobody).toEqual(member)
    await tick()
    expect(fake.links).toEqual([
      { email: 'a@prestamista.test', redirectTo: 'https://bo.prestamista.test/entrar' },
      { email: 'nadie@prestamista.test', redirectTo: 'https://bo.prestamista.test/entrar' },
    ])
  })

  it('sin el encabezado anti-CSRF o con un correo inválido no se pide nada', async () => {
    const before = fake.links.length
    expect((await post(on.base, { email: 'b@prestamista.test' }, false)).status).toBe(403)
    expect((await post(on.base, { email: 'no-es-correo' })).status).toBe(400)
    expect((await post(on.base, { email: 'b@prestamista.test', extra: 1 })).status).toBe(400)
    await tick()
    expect(fake.links.length).toBe(before)
  })

  it('por IP: al sexto intento en el minuto responde 429', async () => {
    // New server: the IP limit is per process and earlier cases already spent attempts.
    const own = fakeAuth()
    const s = await serve(own.auth)
    try {
      const codes: number[] = []
      for (let i = 0; i < 6; i++) codes.push((await post(s.base, { email: `u${String(i)}@prestamista.test` })).status)
      expect(codes).toEqual([202, 202, 202, 202, 202, 429])
    } finally {
      await new Promise((r) => s.server.close(r))
    }
  })

  it('por correo: después de tres en la ventana sigue respondiendo 202, pero ya no pide enlaces', async () => {
    const own = fakeAuth()
    const s = await serve(own.auth)
    try {
      const codes: number[] = []
      for (let i = 0; i < 4; i++) codes.push((await post(s.base, { email: 'a@prestamista.test' })).status)
      expect(codes).toEqual([202, 202, 202, 202])
      await tick()
      expect(own.links.length).toBe(3)
    } finally {
      await new Promise((r) => s.server.close(r))
    }
  })

  it('un GoTrue caído no cambia la respuesta', async () => {
    const down: AuthDirectory = { ensureUser: () => Promise.reject(new Error('x')), sendMagicLink: () => Promise.reject(new Error('Supabase Auth respondió 503')), refreshSession: () => Promise.resolve(null), revokeSession: () => Promise.resolve() }
    const s = await serve(down)
    try {
      expect(await post(s.base, { email: 'a@prestamista.test' })).toEqual({ status: 202, text: '{"accepted":true}' })
    } finally {
      await new Promise((r) => s.server.close(r))
    }
  })

  it('sin Supabase Auth la ruta no existe', async () => {
    expect((await post(off.base, { email: 'a@prestamista.test' })).status).toBe(404)
  })
})
