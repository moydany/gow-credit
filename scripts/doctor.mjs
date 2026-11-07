#!/usr/bin/env node
/* eslint-disable no-console -- machine diagnostic: console output is the result */
// pnpm doctor: checks this machine has what it needs to run the repo (docs/local-setup.md).
// Read-only: doesn't install, download or print .env values.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = (...p) => join(ROOT, ...p)
let failed = 0
let warned = 0
const ok = (msg) => console.log(`  ok     ${msg}`)
const warn = (msg, fix) => { warned++; console.log(`  aviso  ${msg}${fix ? `\n         → ${fix}` : ''}`) }
const fail = (msg, fix) => { failed++; console.log(`  falta  ${msg}${fix ? `\n         → ${fix}` : ''}`) }
/** Reports ok or, if not met, the failure or warning with its fix. */
const check = (cond, okMsg, report, msg, fix) => { if (cond) ok(okMsg); else report(msg, fix) }
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return null }
}
const readEnv = (path) => existsSync(path)
  ? Object.fromEntries(readFileSync(path, 'utf8').split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1').trim()] }))
  : null

console.log('Herramientas')
const [major] = process.versions.node.split('.').map(Number)
check(major >= 24, `Node ${process.versions.node}`, fail, `Node ${process.versions.node}; se necesita 24 o posterior`, 'instala Node 24 (.nvmrc)')
const wanted = JSON.parse(readFileSync(at('package.json'), 'utf8')).packageManager.split('@')[1]
const pnpm = run('pnpm', ['--version'])
check(pnpm === wanted, `pnpm ${pnpm}`, fail, `pnpm ${pnpm ?? 'no instalado'}; se necesita ${wanted}`, 'corepack enable')
check(existsSync(at('node_modules', '.pnpm')), 'dependencias instaladas', fail, 'dependencias sin instalar', 'pnpm install --frozen-lockfile')
check(run('openssl', ['version']), 'openssl', warn, 'openssl no encontrado', 'solo hace falta para pnpm data:unpack')
const docker = run('docker', ['info', '--format', '{{.ServerVersion}}'])
check(docker, `Docker ${docker} corriendo`, warn, 'Docker no está corriendo', 'solo hace falta para el modo full; abre Docker Desktop')

console.log('\nLlaves (.env)')
const env = readEnv(at('.env'))
if (!env) fail('no hay .env en la raíz', 'copia tu .env a la raíz del repositorio')
else {
  check(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY', fail, 'ANTHROPIC_API_KEY vacía', 'es obligatoria para pnpm run evaluate')
  check(env.GEMINI_API_KEY, 'GEMINI_API_KEY', warn, 'GEMINI_API_KEY vacía', 'sin ella extrae Opus, unas 5 veces más caro')
  check(env.TYPESAFE_API_KEY, 'TYPESAFE_API_KEY', warn, 'TYPESAFE_API_KEY vacía', 'sin ella clasifica Haiku')
}

console.log('\nDatos (data/, nunca en git)')
const manifest = at('data', 'dev', 'MANIFEST.sha256')
if (!existsSync(manifest)) fail('data/dev sin los PDFs de desarrollo', 'pnpm data:unpack <paquete> (docs/local-setup.md, paso 4)')
else {
  const bad = readFileSync(manifest, 'utf8').split('\n').filter(Boolean).filter((line) => {
    const [hash, name] = line.split(/\s+\*?/)
    const file = at('data', 'dev', name)
    return !existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== hash
  })
  check(bad.length === 0, 'data/dev: los 9 PDFs coinciden con el manifiesto', fail, `data/dev: ${bad.length} PDF faltan o no coinciden`, 'vuelve a desempacar el paquete')
}
const gt = existsSync(at('data', 'ground-truth')) ? readdirSync(at('data', 'ground-truth')).filter((f) => f.endsWith('.json')).length : 0
check(gt > 0, `data/ground-truth: ${gt} documentos`, fail, 'data/ground-truth vacío', 'pnpm eval lo necesita; viene en el paquete')
const cache = existsSync(at('data', 'llm-cache')) ? readdirSync(at('data', 'llm-cache')).length : 0
check(cache > 0, 'data/llm-cache: respuestas guardadas (repeticiones a costo cero)', fail, 'data/llm-cache vacío', 'sin caché, pnpm eval y los escenarios full gastan o fallan; viene en el paquete')

console.log('\nModo full con Supabase local (opcional)')
check(existsSync(at('infra', 'supabase', '.env')) && existsSync(at('infra', 'supabase', 'app.env')),
  'infra/supabase/.env y app.env', warn, 'sin secretos del Supabase local', 'pnpm supabase:env los genera en esta máquina')

console.log(`\n${failed === 0 ? 'Listo' : `Faltan ${failed} cosas`}${warned ? ` (${warned} avisos)` : ''}.`)
process.exit(failed === 0 ? 0 : 1)
