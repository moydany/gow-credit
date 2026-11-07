/** Configuración del backoffice: usuarios y llaves de API. */
import { randomUUID } from 'node:crypto'
import { apiKeys, tenantUsers, withTenant, type Tx } from '@gow/db'
import { ApiKeyCreateBody, TenantUserCreateBody, type ApiKeyCreated, type ApiKeyItem, type TenantUserCreated, type TenantUserItem } from '@gow/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import express from 'express'
import { z } from 'zod'
import { hashSecret, newApiKey } from '../admin.ts'
import { issueToken } from '../session.ts'
import { audit, HttpError, parse } from '../ops.ts'
import { actorOf, backofficeBase, ENTER_PATH, iso, SESSION_SECONDS, uniqueViolation, who, type BackofficeDeps } from './shared.ts'

/** Columnas visibles de una llave de API: el hash nunca sale de la base (ni siquiera hay privilegio para leerlo). */
const apiKeyColumns = { id: apiKeys.id, prefix: apiKeys.prefix, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt }
const apiKeyItem = (k: { id: string; prefix: string; scopes: string[]; createdAt: Date; revokedAt: Date | null }): ApiKeyItem => ({ id: k.id, prefix: k.prefix, scopes: k.scopes as ApiKeyItem['scopes'], created_at: k.createdAt.toISOString(), revoked_at: iso(k.revokedAt) })

export function teamRouter(deps: BackofficeDeps): express.Router {
  const r = express.Router()
  const backofficeOrigin = backofficeBase(deps)
  // ---------- Configuración: usuarios del backoffice
  r.get('/users', async (_req, res) => {
    const w = who(res)
    const rows = await withTenant(deps.db, w.tenantId, (tx) =>
      tx.execute<{ user_id: string; email: string; created_at: Date; invited_by: string | null }>(sql`
        select u.user_id, u.email, u.created_at, i.email as invited_by
          from app.tenant_users u left join app.tenant_users i on i.user_id = u.invited_by
         order by u.created_at`),
    )
    const list: TenantUserItem[] = rows.rows.map((u) => ({ id: u.user_id, email: u.email, created_at: new Date(u.created_at).toISOString(), invited_by: u.invited_by, is_me: u.user_id === w.userId }))
    res.json(list)
  })

  /**
   * Invitar: da de alta la pertenencia. Sin Supabase Auth devuelve, una sola vez, el enlace de acceso
   * con el mismo JWT que emite `pnpm tenant user add`. Con Supabase Auth (ADR 0035) crea o encuentra
   * la cuenta de Auth, guarda su id como `user_id` y le manda el enlace por correo; no hay enlace que
   * compartir. Un usuario que ya existe no recibe enlace nuevo por aquí: sería entrar a nombre de otro.
   */
  r.post('/users', async (req, res) => {
    const w = who(res)
    const body = parse(TenantUserCreateBody, req.body)
    const conflict = new HttpError(409, 'ese correo ya tiene acceso al backoffice', [{ path: 'email', message: 'correo ya registrado' }])
    const memberOfThisTenant = async (tx: Tx) => (await tx.select({ id: tenantUsers.userId }).from(tenantUsers).where(eq(tenantUsers.email, body.email))).length > 0
    let userId: string = randomUUID()
    if (deps.auth) {
      // Antes de tocar Auth, para no crear cuentas por un conflicto que ya se ve aquí.
      if (await withTenant(deps.db, w.tenantId, memberOfThisTenant)) throw conflict
      try {
        userId = await deps.auth.ensureUser(body.email)
      } catch (e) {
        deps.logger?.error(`backoffice: no se creó la cuenta de Auth (${e instanceof Error ? e.message : 'error'})`)
        throw new HttpError(502, 'no se pudo crear la cuenta de acceso; intenta de nuevo')
      }
    }
    let row: { userId: string; email: string; createdAt: Date }
    try {
      row = await withTenant(deps.db, w.tenantId, async (tx) => {
        if (await memberOfThisTenant(tx)) throw conflict
        const [u] = await tx.insert(tenantUsers).values({ tenantId: w.tenantId, userId, email: body.email, invitedBy: w.userId }).returning()
        if (!u) throw new HttpError(500, 'no se agregó el usuario')
        await audit(tx, w.tenantId, actorOf(w), 'user.added', u.userId)
        return u
      })
    } catch (e) {
      // El correo es único entre tenants: si es de otro, RLS no deja verlo y la unicidad lo detiene.
      // Con Supabase la cuenta de Auth ya existe y se queda sin pertenencia: sin tenant_id no entra.
      if (uniqueViolation(e)) throw conflict
      throw e
    }
    const user = { id: row.userId, email: row.email, created_at: row.createdAt.toISOString(), invited_by: w.email, is_me: false }
    if (deps.auth) {
      const sent = await deps.auth.sendMagicLink(row.email, `${backofficeOrigin}${ENTER_PATH}`).catch((e: unknown) => {
        deps.logger?.error(`backoffice: no se mandó el enlace al invitado (${e instanceof Error ? e.message : 'error'})`)
        return false
      })
      const out: TenantUserCreated = { user, access_link: null, expires_at: null, email_sent: sent }
      return void res.status(201).json(out)
    }
    const token = issueToken(deps.backofficeJwtSecret, { sub: row.userId, email: row.email, tenant_id: w.tenantId }, SESSION_SECONDS)
    const out: TenantUserCreated = {
      user,
      access_link: `${backofficeOrigin}${ENTER_PATH}#token=${token}`,
      expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
      email_sent: false,
    }
    res.status(201).json(out)
  })

  /**
   * Quitar a un usuario corta su sesión en la siguiente petición (la pertenencia se lee siempre). Con
   * Supabase Auth solo se quita la pertenencia: la cuenta de Auth se queda (sin tenant_id no entra) y
   * su id sigue explicando la bitácora.
   */
  r.delete('/users/:id', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    if (id === w.userId) throw new HttpError(409, 'no puedes quitarte a ti mismo')
    await withTenant(deps.db, w.tenantId, async (tx) => {
      const [u] = await tx.delete(tenantUsers).where(eq(tenantUsers.userId, id)).returning({ id: tenantUsers.userId })
      if (!u) throw new HttpError(404, 'usuario no encontrado')
      await audit(tx, w.tenantId, actorOf(w), 'user.removed', id)
    })
    res.status(204).end()
  })

  // ---------- Configuración: llaves de API (la completa se muestra una vez; se guarda el hash)
  r.get('/api-keys', async (_req, res) => {
    const rows = await withTenant(deps.db, who(res).tenantId, (tx) => tx.select(apiKeyColumns).from(apiKeys).orderBy(desc(apiKeys.createdAt)))
    res.json(rows.map(apiKeyItem))
  })

  r.post('/api-keys', async (req, res) => {
    const w = who(res)
    const body = parse(ApiKeyCreateBody, req.body)
    const key = newApiKey()
    const row = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [k] = await tx.insert(apiKeys).values({ tenantId: w.tenantId, prefix: key.prefix, keyHash: hashSecret(key.secret), scopes: body.scopes }).returning(apiKeyColumns)
      if (!k) throw new HttpError(500, 'no se creó la llave')
      await audit(tx, w.tenantId, actorOf(w), 'api_key.created', k.id, { prefix: k.prefix, scopes: k.scopes })
      return k
    })
    const out: ApiKeyCreated = { key: apiKeyItem(row), secret_key: key.key }
    res.status(201).json(out)
  })

  /** Revocar es inmediato: `resolve_api_key` ignora las revocadas. La fila se conserva para la bitácora. */
  r.post('/api-keys/:id/revoke', async (req, res) => {
    const id = parse(z.uuid(), req.params.id)
    const w = who(res)
    const row = await withTenant(deps.db, w.tenantId, async (tx) => {
      const [k] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning(apiKeyColumns)
      if (!k) {
        const [exists] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id))
        throw exists ? new HttpError(409, 'la llave ya está revocada') : new HttpError(404, 'llave no encontrada')
      }
      await audit(tx, w.tenantId, actorOf(w), 'api_key.revoked', k.id, { prefix: k.prefix })
      return k
    })
    res.json(apiKeyItem(row))
  })

  return r
}
