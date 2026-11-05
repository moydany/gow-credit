/* eslint-disable no-console -- CLI: una línea por documento */
/**
 * pnpm demo:load --key gowk_... [--dir data/dev] [--api http://127.0.0.1:3000]
 *
 * Carga los PDFs de una carpeta como solicitudes por la API real (URL firmada, proveedor,
 * solicitud): el worker los procesa igual que en producción. Con `LLM_CACHE_MODE=read` el worker
 * extrae desde la caché de respuestas (costo cero, sin llaves de modelos) y, como los proveedores
 * se crean sin contacto verificado, las aclaraciones quedan en la bandeja para responderlas a
 * mano: el backoffice funciona sin WhatsApp ni correo. Los proveedores son inventados; los
 * documentos son los reales del dataset, que no se versiona.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { key: { type: 'string' }, dir: { type: 'string' }, api: { type: 'string' }, 'as-of': { type: 'string' }, amount: { type: 'string' } } })
const key = values.key ?? process.env.DEMO_API_KEY
if (!key) {
  console.error('uso: pnpm demo:load --key gowk_... [--dir data/dev] [--api http://127.0.0.1:3000] [--as-of AAAA-MM-DD]')
  process.exit(64)
}
const api = values.api ?? 'http://127.0.0.1:3000'
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), values.dir ?? 'data/dev')
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${api}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
const AMOUNTS = [180_000, 320_000, 95_000, 640_000, 250_000, 120_000, 480_000, 210_000, 750_000]
for (const [i, file] of files.entries()) {
  const bank = /^EDC_\d+_([A-Za-z]+)/.exec(file)?.[1] ?? 'Banco'
  const supplier = await call<{ id: string }>('POST', '/v1/suppliers', { external_ref: `demo-${String(i + 1).padStart(2, '0')}`, legal_name: `Proveedor Demo ${String(i + 1).padStart(2, '0')} (${bank})` })
  const up = await call<{ url: string; path: string }>('POST', '/v1/uploads', {})
  const put = await fetch(up.url, { method: 'PUT', body: new Uint8Array(readFileSync(join(dir, file))) })
  if (!put.ok) throw new Error(`subida de ${file}: ${String(put.status)}`)
  const amount = values.amount ? Number(values.amount) : (AMOUNTS[i % AMOUNTS.length] ?? 200_000)
  const created = await call<{ id: string; duplicate: boolean }>('POST', '/v1/applications', {
    supplier_id: supplier.id,
    document_path: up.path,
    request: { amount, maturity: '2026-12-20', buyer: { name: 'Cadena Comercial Demo', rfc: null, aliases: [] } },
    as_of: values['as-of'] ?? null,
  })
  console.log(`${file} → solicitud ${created.id}${created.duplicate ? ' (ya existía)' : ''}`)
}
