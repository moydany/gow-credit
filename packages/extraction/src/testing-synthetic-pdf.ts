/**
 * Genera un PDF de una página con texto plano (Helvetica), sin dependencias. Sirve para
 * probar el cable sin tocar los PDFs reales de data/, que tienen datos personales.
 */
function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function syntheticStatementPdf(lines: readonly string[]): Buffer {
  const textOps = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n')
  const stream = `BT\n/F1 9 Tf\n11 TL\n40 760 Td\n${textOps}\nET`

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
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
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`
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
