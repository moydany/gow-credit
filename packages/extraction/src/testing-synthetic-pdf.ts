/**
 * Genera un PDF de una página con texto plano (Helvetica), sin dependencias. Sirve para
 * probar el cable sin tocar los PDFs reales de data/, que tienen datos personales.
 */
import { createHash } from 'node:crypto'

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function syntheticStatementPdf(lines: readonly string[]): Buffer {
  return buildPdf(lines, null)
}

/**
 * El mismo PDF cifrado con el manejador estándar (RC4 de 40 bits, R2). Con `userPassword` vacío solo
 * restringe permisos y se abre sin contraseña; con una, pide contraseña para abrirse (ADR 0049).
 */
export function encryptedStatementPdf(lines: readonly string[], opts: { userPassword: string; ownerPassword?: string }): Buffer {
  return buildPdf(lines, { user: opts.userPassword, owner: opts.ownerPassword ?? 'propietario' })
}

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const PERMISSIONS = -44 // sin modificar ni copiar

function padded(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32)
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const st = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + (st[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff
    ;[st[i], st[j]] = [st[j] ?? 0, st[i] ?? 0]
  }
  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + (st[i] ?? 0)) & 0xff
    ;[st[i], st[j]] = [st[j] ?? 0, st[i] ?? 0]
    out[n] = (data[n] ?? 0) ^ (st[((st[i] ?? 0) + (st[j] ?? 0)) & 0xff] ?? 0)
  }
  return out
}

const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest()

function buildPdf(lines: readonly string[], encryption: { user: string; owner: string } | null): Buffer {
  const textOps = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n')
  const plain = Buffer.from(`BT\n/F1 9 Tf\n11 TL\n40 760 Td\n${textOps}\nET`, 'latin1')
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  let stream: Buffer = plain
  let encryptObject: string | null = null
  if (encryption) {
    const o = rc4(md5(padded(encryption.owner)).subarray(0, 5), padded(encryption.user))
    const p = Buffer.alloc(4)
    p.writeInt32LE(PERMISSIONS)
    const key = md5(padded(encryption.user), o, p, id).subarray(0, 5)
    const u = rc4(key, PAD)
    // El contenido es el objeto 4, generación 0.
    stream = rc4(md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10), plain)
    encryptObject = `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${String(PERMISSIONS)} >>`
  }

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...(encryptObject ? [encryptObject] : []),
  ]

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${String(i + 1)} 0 obj\n${obj}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  const encrypt = encryptObject ? ` /Encrypt ${String(objects.length)} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]` : ''
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R${encrypt} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Un estado de cuenta ficticio que cuadra: 10,000 + 5,000 − 1,250.50 = 13,749.50 */
export const SYNTHETIC_STATEMENT_LINES = [
  'BANCO FICTICIO S.A. - ESTADO DE CUENTA',
  'Titular: COMERCIALIZADORA DE PRUEBA SA DE CV   RFC: XAXX010101000',
  'Cuenta: 0123456789   CLABE: 002010077777777771',
  'Periodo: del 01/03/2026 al 31/03/2026',
  'Saldo inicial: 10,000.00   Depositos: 5,000.00   Retiros: 1,250.50   Saldo final: 13,749.50',
  'FECHA   DESCRIPCION                          CARGO       ABONO      SALDO',
  '05/03   SPEI RECIBIDO CLIENTE UNO                         5,000.00   15,000.00',
  '12/03   PAGO PROVEEDOR PAPELERIA             1,000.00                14,000.00',
  '31/03   COMISION MANEJO DE CUENTA              250.50                13,749.50',
] as const
