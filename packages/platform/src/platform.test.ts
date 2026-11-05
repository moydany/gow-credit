import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@gow/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enqueueProcess, enqueueResume, QUEUES, startQueue, type PgBoss } from './queue.ts'
import { isPdf, LocalDocumentStorage, pathBelongsTo } from './storage.ts'

const available = await postgresAvailable()

describe('almacenamiento con URL firmada', () => {
  const storage = new LocalDocumentStorage({ root: mkdtempSync(join(tmpdir(), 'gow-st-')), secret: 'secreto-de-prueba', publicBaseUrl: 'http://127.0.0.1:3000/' })
  const tenant = randomUUID()

  it('la URL firmada autoriza solo su ruta, bajo el tenant, y vence', () => {
    const up = storage.createSignedUpload(tenant, 60)
    expect(pathBelongsTo(up.path, tenant)).toBe(true)
    const token = up.url.split('/storage/upload/')[1] ?? ''
    expect(storage.verifyUploadToken(token)).toBe(up.path)
    expect(storage.verifyUploadToken(`${token}x`)).toBeNull()
    expect(storage.verifyUploadToken(token, Math.floor(Date.now() / 1000) + 61)).toBeNull()
  })

  it('no deja salir del directorio ni usar rutas de otro tenant', async () => {
    expect(pathBelongsTo(`${tenant}/../otro/x.pdf`, tenant)).toBe(false)
    expect(pathBelongsTo(`${randomUUID()}/x.pdf`, tenant)).toBe(false)
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/fuera del almacenamiento/)
  })

  it('valida el tipo por los bytes, no por la extensión', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n...'))).toBe(true)
    expect(isPdf(Buffer.from('<html>'))).toBe(false)
  })
})

describe.skipIf(!available)('cola pg-boss (necesita el Postgres de docker compose)', () => {
  let tdb: TestDatabase
  let boss: PgBoss

  beforeAll(async () => {
    tdb = await createTestDatabase()
    boss = await startQueue(tdb.url('queue'), { error: () => undefined }, { supervise: false })
  }, 60_000)

  afterAll(async () => {
    await boss.stop({ graceful: false })
    await tdb.drop()
  })

  it('el mismo documento del mismo tenant no se encola dos veces', async () => {
    const job = { tenant_id: randomUUID(), application_id: randomUUID() }
    const first = await enqueueProcess(boss, job, 'a'.repeat(64))
    const again = await enqueueProcess(boss, { ...job, application_id: randomUUID() }, 'a'.repeat(64))
    const otherTenant = await enqueueProcess(boss, { ...job, tenant_id: randomUUID() }, 'a'.repeat(64))
    expect(first).not.toBeNull()
    expect(again).toBeNull()
    expect(otherTenant).not.toBeNull()
  })

  it('las reanudaciones van con prioridad alta y las colas tienen dead letter', async () => {
    const id = await enqueueResume(boss, { tenant_id: randomUUID(), application_id: randomUUID(), clarification_id: randomUUID() })
    const [job] = await boss.findJobs<object>(QUEUES.resume, { id: id ?? '' })
    expect(job?.priority).toBe(10)
    expect((await boss.getQueue(QUEUES.process))?.deadLetter).toBe(QUEUES.dead)
  })

  it('un payload que no cumple el esquema no entra a la cola', async () => {
    await expect(enqueueProcess(boss, { tenant_id: 'x', application_id: randomUUID() }, 'b'.repeat(64))).rejects.toThrow()
  })
})
