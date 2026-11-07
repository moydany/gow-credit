/* eslint-disable no-console -- local tool for filling in CFDI facts by hand; prints document text */
// Usage: tsx src/ground-truth/fiscal-candidates.ts <pdf>
import { readLayout } from './layout.ts'

const path = process.argv[2]
if (!path) throw new Error('uso: fiscal-candidates <pdf>')
const layout = await readLayout(path)
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
layout.pages.forEach((lines, i) => {
  const text = lines.map((l) => l.segments.map((s) => s.str).join(' | ')).join('\n')
  if (!UUID.test(text) && !/CFDI|Comprobante Fiscal|RETENCIONES/i.test(text)) return
  console.log(`===== página ${String(i + 1)}`)
  for (const l of lines) {
    const t = l.segments.map((s) => s.str).join(' | ')
    if (/sello|^[A-Za-z0-9+/=]{60,}$/i.test(t) && !/\|\|/.test(t)) continue
    if (/[0-9a-f]{8}-|\d{20}|\d{4}-\d{2}-\d{2}T|RFC|R\.F\.C|r[eé]gimen|uso|subtotal|sub-total|i\.?v\.?a|total|importe|folio|serie|versi[oó]n|receptor|emisor|forma de pago|m[eé]todo|moneda|c[oó]digo postal|domicilio|tipo|\|\|/i.test(t)) console.log(`${l.y.toFixed(0).padStart(4)} ${t.slice(0, 230)}`)
  }
})
