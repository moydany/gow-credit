/* eslint-disable no-console -- script de comparación: la salida en consola es el resultado */
// Compara dos extracciones del mismo documento campo por campo, tomando la primera como
// referencia. Imprime solo conteos, coincidencias y cifras agregadas: nunca nombres, RFC ni
// descripciones. Uso: node scripts/compare-extractions.mjs <referencia.json> <candidata.json>
import { readFileSync } from 'node:fs'

const [refPath, candPath] = process.argv.slice(2)
if (!refPath || !candPath) {
  console.error('uso: node scripts/compare-extractions.mjs <referencia.json> <candidata.json>')
  process.exit(64)
}
const ref = JSON.parse(readFileSync(refPath, 'utf8'))
const cand = JSON.parse(readFileSync(candPath, 'utf8'))

const txs = (d) => d.accounts.flatMap((a) => a.periods.flatMap((p) => p.transactions))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const pct = (n, d) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)} %`)

// --- movimientos: emparejamiento por (fecha, monto, sentido) como multiconjunto
function matchRows(a, b) {
  const pool = new Map()
  for (const t of b) {
    const k = `${t.date}|${t.amount}|${t.type}`
    pool.set(k, [...(pool.get(k) ?? []), t])
  }
  let matched = 0
  let balanceAgree = 0
  let balanceComparable = 0
  let descAgree = 0
  let pageAgree = 0
  const missing = []
  for (const t of a) {
    const k = `${t.date}|${t.amount}|${t.type}`
    const list = pool.get(k)
    if (!list || list.length === 0) {
      missing.push(t)
      continue
    }
    const u = list.shift()
    matched++
    if (t.balance !== null && u.balance !== null) {
      balanceComparable++
      if (t.balance === u.balance) balanceAgree++
    }
    if (t.description.replace(/\s+/g, ' ').trim().toLowerCase() === u.description.replace(/\s+/g, ' ').trim().toLowerCase()) descAgree++
    if (t.source.page === u.source.page) pageAgree++
  }
  const extra = [...pool.values()].flat()
  return { matched, missing, extra, balanceAgree, balanceComparable, descAgree, pageAgree }
}

const rt = txs(ref)
const ct = txs(cand)
const m = matchRows(rt, ct)

console.log(`documento: ${ref.document.file_name}`)
console.log(`modelos: referencia ${ref.extraction.extraction_model} · candidata ${cand.extraction.extraction_model}\n`)

const row = (label, a, b) => console.log(`${label.padEnd(34)} ${String(a).padEnd(22)} ${String(b)}`)
row('', 'referencia', 'candidata')
row('estado', ref.extraction.status, cand.extraction.status)
row('cuentas / periodos', `${ref.accounts.length} / ${ref.accounts.flatMap((a) => a.periods).length}`, `${cand.accounts.length} / ${cand.accounts.flatMap((a) => a.periods).length}`)
row('movimientos', rt.length, ct.length)
const recon = (d) => d.accounts.flatMap((a) => a.periods).map((p) => `${p.reconciliation?.status ?? '-'} (dif ${p.reconciliation?.global?.difference ?? '-'}, rupturas ${p.reconciliation?.running_balance?.breaks.length ?? '-'})`).join('; ')
row('cuadre', recon(ref), recon(cand))
const ver = (d) => { const v = {}; for (const t of txs(d)) v[t.verification] = (v[t.verification] ?? 0) + 1; return JSON.stringify(v) }
row('verificación de movimientos', ver(ref), ver(cand))
const sev = (d) => { const v = {}; for (const i of d.issues) v[i.severity] = (v[i.severity] ?? 0) + 1; return JSON.stringify(v) }
row('issues por severidad', sev(ref), sev(cand))
row('llamadas', ref.extraction.calls.length, cand.extraction.calls.length)
row('tokens de salida', ref.extraction.usage.output_tokens, cand.extraction.usage.output_tokens)
row('costo USD', ref.extraction.cost_usd, cand.extraction.cost_usd)
row('duración s', Math.round(ref.extraction.duration_ms / 1000), Math.round(cand.extraction.duration_ms / 1000))
const calls = (d) => d.extraction.calls.map((c) => c.purpose === 'transactions' ? `tx[${c.pages.join(',')}]` : c.purpose).join(' ')
row('llamadas por propósito', calls(ref).slice(0, 60), calls(cand).slice(0, 120))

console.log('\nmovimientos de la candidata contra la referencia (fecha, monto, sentido):')
console.log(`  coinciden ${m.matched}/${rt.length} (recall ${pct(m.matched, rt.length)}), sobran ${m.extra.length} (precisión ${pct(m.matched, ct.length)})`)
console.log(`  saldo igual ${m.balanceAgree}/${m.balanceComparable} · descripción idéntica ${m.descAgree}/${m.matched} · misma página ${m.pageAgree}/${m.matched}`)
if (m.missing.length) console.log(`  faltan en la candidata: ${m.missing.slice(0, 8).map((t) => `${t.date} ${t.type} ${t.amount} p${t.source.page}`).join(' · ')}`)
if (m.extra.length) console.log(`  sobran en la candidata: ${m.extra.slice(0, 8).map((t) => `${t.date} ${t.type} ${t.amount} p${t.source.page}`).join(' · ')}`)

console.log('\nencabezado y resumen (igual / distinto, sin mostrar valores personales):')
const fields = (d) => {
  const a = d.accounts[0]
  const p = a?.periods[0]
  return {
    bank_name: d.bank_name.value, holder_name: d.holder.name.value, holder_rfc: d.holder.rfc.value, holder_type: d.holder.holder_type.value,
    product: a?.product_name.value, account_type: a?.account_type.value, account_number: a?.account_number.value, clabe: a?.clabe.value, currency: a?.currency.value,
    period_start: p?.period_start.value, period_end: p?.period_end.value, statement_date: p?.statement_date.value,
    ...Object.fromEntries(Object.entries(p?.summary ?? {}).map(([k, v]) => [k, v.value])),
  }
}
const fr = fields(ref)
const fc = fields(cand)
const numeric = new Set(['opening_balance', 'closing_balance', 'total_credits', 'total_debits', 'credits_count', 'debits_count', 'average_balance', 'fees_charged', 'interest_earned', 'tax_withheld', 'period_start', 'period_end', 'statement_date', 'currency', 'account_type', 'holder_type'])
const diffs = []
for (const k of Object.keys(fr)) {
  const ok = same(fr[k], fc[k])
  if (!ok) diffs.push(numeric.has(k) ? `${k}: ${fr[k]} → ${fc[k]}` : `${k}: ${fr[k] === null ? 'vacío' : 'valor'} → ${fc[k] === null ? 'vacío' : 'otro valor'}`)
}
console.log(`  ${Object.keys(fr).length - diffs.length}/${Object.keys(fr).length} iguales${diffs.length ? `; distintos: ${diffs.join(' · ')}` : ''}`)

console.log('\nbloque fiscal:')
const fis = (d) => d.fiscal_documents ?? []
console.log(`  comprobantes: ${fis(ref).length} → ${fis(cand).length}`)
fis(ref).forEach((f, i) => {
  const g = fis(cand)[i]
  if (!g) return console.log(`  ${f.id}: falta en la candidata`)
  const keys = ['kind', 'version', 'uuid', 'issued_at', 'certified_at', 'issuer_certificate', 'sat_certificate', 'pac_rfc', 'payment_form', 'payment_method', 'currency', 'subtotal', 'tax', 'total']
  const nested = { issuer_rfc: [f.issuer.rfc.value, g.issuer.rfc.value], receiver_rfc: [f.receiver.rfc.value, g.receiver.rfc.value], receiver_regime: [f.receiver.tax_regime.value, g.receiver.tax_regime.value], chain_uuid: [f.original_chain.uuid.value, g.original_chain.uuid.value], seals: [f.seals, g.seals] }
  const bad = keys.filter((k) => !same(k === 'kind' ? f.kind : f[k].value, k === 'kind' ? g.kind : g[k].value))
  const badNested = Object.entries(nested).filter(([, [x, y]]) => !same(x, y)).map(([k]) => k)
  const total = keys.length + Object.keys(nested).length
  const wrong = [...bad, ...badNested]
  console.log(`  ${f.id}: ${total - wrong.length}/${total} iguales${wrong.length ? `; distintos: ${wrong.join(', ')}` : ''}`)
})
