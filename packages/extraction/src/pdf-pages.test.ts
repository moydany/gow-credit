/**
 * Páginas (ADR 0057): paginación impresa, varios estados en un PDF, páginas que faltan, repetidas y
 * giradas, en `loadPdf` y en las funciones puras. Todo con PDFs sintéticos de varias páginas.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { degrees, PDFDocument, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { IssueSink } from './issues.ts'
import {
  findDuplicatePages,
  fiscalStatementCount,
  loadPdf,
  missingPrintedPages,
  multipleStatements,
  pageFingerprints,
  pageRotation,
  paginationReliable,
  printedPagination,
  reportPageChecks,
  type PageNumbering,
} from './pdf.ts'
import { SYNTHETIC_STATEMENT_LINES, syntheticStatementPages, syntheticStatementPdf } from './testing-synthetic-pdf.ts'

const dir = mkdtempSync(join(tmpdir(), 'gow-pdf-pages-'))
let counter = 0
const write = (bytes: Uint8Array): string => {
  counter += 1
  const path = join(dir, `doc-${String(counter)}.pdf`)
  writeFileSync(path, bytes)
  return path
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const numbering = (printed: (number | null)[], total: number | null = null): PageNumbering[] => printed.map((p, i) => ({ page: i + 1, printed: p, total: p === null ? null : total }))

describe('printedPagination (formatos de los bancos mexicanos)', () => {
  it.each([
    ['Pág. 3 de 17', 3, 17],
    ['Página 3/17', 3, 17],
    ['Pag 3/3', 3, 3],
    ['PAGINA 3 DE 17', 3, 17],
    ['Hoja 3 de 17', 3, 17],
    ['BANCO FICTICIO SA   Hoja 3 de 17', 3, 17],
    ['Page 3 of 17', 3, 17],
    ['Pag. No. 3 de 17', 3, 17],
    ['Página 3', 3, null],
  ])('"%s" → pág. %i de %s', (footer, printed, total) => {
    const [p] = printedPagination([`BANCO FICTICIO\nSaldo inicial 10,000.00\n05/03 SPEI RECIBIDO 5,000.00 15,000.00\n${footer}`])
    expect(p).toEqual({ page: 1, printed, total })
  })

  it('reconoce la numeración al encabezado y en medio del cuerpo si trae palabra clave y total', () => {
    expect(printedPagination(['Página 2 de 5\nSaldo inicial 10,000.00'])[0]).toMatchObject({ printed: 2, total: 5 })
    const body = ['BANCO', 'a', 'b', 'c', 'd', 'Pág. 4 de 9', 'e', 'f', 'g', 'h'].join('\n')
    expect(printedPagination([body])[0]).toMatchObject({ printed: 4, total: 9 })
  })

  it('"3 de 17" y "3/17" solos al pie valen cuando todo el documento los trae iguales y avanzan', () => {
    const pages = ['uno\n1 de 3', 'dos\n2 de 3', 'tres\n3/3'].map((t) => `BANCO FICTICIO ${t}`)
    expect(printedPagination(pages).map((p) => [p.printed, p.total])).toEqual([[1, 3], [2, 3], [3, 3]])
    const slashes = ['uno\n1/3', 'dos\n2/3', 'tres\n3/3']
    expect(printedPagination(slashes).map((p) => p.printed)).toEqual([1, 2, 3])
  })

  it('un "03/05" suelto es una fecha, no una página', () => {
    expect(printedPagination(['Saldo inicial 10,000.00\n03/05'])[0]).toEqual({ page: 1, printed: null, total: null })
    // La misma fecha como pie de todas las páginas: no avanza, no es numeración.
    expect(printedPagination(['uno\n03/05', 'dos\n03/05', 'tres\n03/05']).map((p) => p.printed)).toEqual([null, null, null])
    // Fechas distintas con meses distintos: tampoco comparten el total.
    expect(printedPagination(['uno\n03/05', 'dos\n04/06']).map((p) => p.printed)).toEqual([null, null])
  })

  it('no confunde fechas, periodos ni referencias con la numeración', () => {
    const text = ['Periodo del 01/03/2026 al 31/03/2026', '05/03 SPEI RECIBIDO 5,000.00 15,000.00', 'PAGO 1/12 MSI', 'Ver Página 3 de este contrato en el sitio', 'Pagado 2 de 5'].join('\n')
    expect(printedPagination([text])[0]).toEqual({ page: 1, printed: null, total: null })
  })

  it('una página no puede ser mayor que el total', () => {
    expect(printedPagination(['Pág. 9 de 3'])[0]).toEqual({ page: 1, printed: null, total: null })
  })

  it('en visión sola (capa corrupta o ausente) devuelve todo null', () => {
    expect(printedPagination(['Pág. 1 de 2', 'Pág. 2 de 2'], 'absent').map((p) => p.printed)).toEqual([null, null])
    expect(printedPagination(['Pág. 1 de 2'], 'corrupt')[0]).toEqual({ page: 1, printed: null, total: null })
    expect(printedPagination(['Pág. 1 de 2'], 'partial')[0]).toMatchObject({ printed: 1 })
  })
})

describe('multipleStatements: reinicio de la numeración', () => {
  it('un 1 después de una página mayor que 1 es otro documento', () => {
    expect(multipleStatements(numbering([1, 2, 3, 1, 2]))).toEqual({ documents: 2, restartsAt: [4] })
    expect(multipleStatements(numbering([1, 2, 1, 2, 1]))).toEqual({ documents: 3, restartsAt: [3, 5] })
  })

  it('una numeración continua, o un 1 repetido sin página mayor antes, es un solo documento', () => {
    expect(multipleStatements(numbering([1, 2, 3]))).toEqual({ documents: 1, restartsAt: [] })
    expect(multipleStatements(numbering([1, 1, 2]))).toEqual({ documents: 1, restartsAt: [] })
    expect(multipleStatements(numbering([2, 3, 4]))).toEqual({ documents: 1, restartsAt: [] })
  })

  it('una página sin número no impide ver el reinicio', () => {
    expect(multipleStatements(numbering([1, null, 3, 1, 2]))).toEqual({ documents: 2, restartsAt: [4] })
  })

  it('sin numeración confiable no dice nada', () => {
    expect(paginationReliable(numbering([null, null, null]))).toBe(false)
    expect(paginationReliable(numbering([1, null, null, null, null]))).toBe(false)
    expect(multipleStatements(numbering([1, null, null, 1, null, null, null, null]))).toEqual({ documents: 1, restartsAt: [] })
  })

  it('una página repetida no cuenta: ni una primera página repetida es otro documento', () => {
    // [1, 2, 3, 1'] con la cuarta repetida de la primera
    expect(multipleStatements(numbering([1, 2, 3, 1]), { exclude: new Set([4]) })).toEqual({ documents: 1, restartsAt: [] })
  })

  it('un comprobante fiscal con numeración propia no es otro estado de cuenta', () => {
    const texts = ['uno', 'dos', 'tres', 'Folio fiscal A1B2 Sello digital del SAT Cadena original del complemento\nPágina 1 de 1']
    expect(multipleStatements(numbering([1, 2, 3, 1]), { pageTexts: texts })).toEqual({ documents: 1, restartsAt: [] })
    // Con el mismo reinicio pero sin marcas fiscales, sí.
    expect(multipleStatements(numbering([1, 2, 3, 1]), { pageTexts: ['a', 'b', 'c', 'Saldo inicial'] }).documents).toBe(2)
  })
})

describe('missingPrintedPages', () => {
  it('1/3 y 3/3: falta la 2', () => {
    expect(missingPrintedPages(numbering([1, 3], 3))).toEqual({ missing: [2], total: 3 })
  })

  it('huecos entre consecutivas y varias páginas', () => {
    expect(missingPrintedPages(numbering([1, 2, 5, 6], 6))).toEqual({ missing: [3, 4], total: 6 })
  })

  it('menos páginas que el total sin hueco interno: faltan las últimas', () => {
    expect(missingPrintedPages(numbering([1, 2], 4))).toEqual({ missing: [3, 4], total: 4 })
  })

  it('el PDF empieza después de la primera: faltan las primeras', () => {
    expect(missingPrintedPages(numbering([3, 4], 4))).toEqual({ missing: [1, 2], total: 4 })
  })

  it('un documento completo no tiene faltantes', () => {
    expect(missingPrintedPages(numbering([1, 2, 3], 3)).missing).toEqual([])
  })

  it('una página sin número impreso ocupa su lugar: no se reporta como faltante', () => {
    expect(missingPrintedPages(numbering([1, null, 3], 3)).missing).toEqual([])
    // Pero si además falta una, se nota.
    expect(missingPrintedPages(numbering([1, null, 4], 4)).missing).toEqual([3])
  })

  it('"Hoja n de m" que se repite en el frente y el reverso no es un hueco', () => {
    expect(missingPrintedPages(numbering([1, 1, 2, 2], 2)).missing).toEqual([])
  })

  it('las páginas repetidas no cuentan como páginas del documento', () => {
    expect(missingPrintedPages(numbering([1, 2, 2, 3], 3), { exclude: new Set([3]) }).missing).toEqual([])
    // Con la tercera repetida y sin la última, se nota que falta la 3.
    expect(missingPrintedPages(numbering([1, 2, 2], 3), { exclude: new Set([3]) }).missing).toEqual([3])
  })

  it('sin numeración confiable no dice nada', () => {
    expect(missingPrintedPages(numbering([null, null, 5, null, null], 5))).toEqual({ missing: [], total: null })
  })
})

describe('fiscalStatementCount (los CFDI de ingreso como segunda regla)', () => {
  const cfdi = (uuid: string | null, certifiedAt: string | null, kind: 'income' | 'withholding' = 'income') =>
    ({ kind, uuid: { value: uuid }, certified_at: { value: certifiedAt } }) as unknown as Parameters<typeof fiscalStatementCount>[0][number]
  const A = 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B'
  const B = 'B1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B'

  it('dos CFDI de ingreso con UUID distinto y timbrados en días distintos son dos estados de cuenta', () => {
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi(B, '2026-04-30T09:00:00')])).toBe(2)
  })

  it('el mismo día, el mismo UUID, un solo CFDI, o de retenciones: uno', () => {
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi(B, '2026-03-31T18:00:00')])).toBe(1)
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi(A, '2026-04-30T10:00:00')])).toBe(1)
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00')])).toBe(1)
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi(B, '2026-04-30T09:00:00', 'withholding')])).toBe(1)
    expect(fiscalStatementCount([])).toBe(1)
  })

  it('un UUID mal formado o sin fecha de timbrado no prueba nada', () => {
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi('no-es-uuid', '2026-04-30T09:00:00')])).toBe(1)
    expect(fiscalStatementCount([cfdi(A, '2026-03-31T10:00:00'), cfdi(B, null)])).toBe(1)
  })
})

describe('findDuplicatePages', () => {
  const body = 'BANCO FICTICIO 05/03 SPEI RECIBIDO CLIENTE UNO 5,000.00 15,000.00'

  it('la misma huella de operadores es una página repetida; la original es la primera', () => {
    expect(findDuplicatePages(['aa', 'bb', 'aa', 'aa'], [], numbering([null, null, null, null]))).toEqual([
      { page: 3, sameAs: 1 },
      { page: 4, sameAs: 1 },
    ])
  })

  it('el mismo texto normalizado con el mismo número impreso, también, aunque la huella no coincida', () => {
    const texts = [body, `${body} extra`, body]
    expect(findDuplicatePages(['x', 'y', 'z'], texts, numbering([2, 3, 2]))).toEqual([{ page: 3, sameAs: 1 }])
    // El mismo texto con otro número de página no es la misma página.
    expect(findDuplicatePages(['x', 'y', 'z'], texts, numbering([2, 3, 4]))).toEqual([])
  })

  it('páginas casi vacías o sin huella no se comparan', () => {
    expect(findDuplicatePages([null, null], ['Hoja 1', 'Hoja 1'], numbering([null, null]))).toEqual([])
    expect(findDuplicatePages([null, null, null], [body, body, ''], numbering([1, 1, null])).map((d) => d.page)).toEqual([2])
  })
})

describe('pageRotation', () => {
  it('el texto derecho en una página con /Rotate 90 se ve girado 90°', () => {
    expect(pageRotation(1, 90, 0)).toEqual({ page: 1, degrees: 90, target: 0 })
    expect(pageRotation(1, 270, 0)).toEqual({ page: 1, degrees: 270, target: 0 })
    expect(pageRotation(2, 180, 0)).toEqual({ page: 2, degrees: 180, target: 0 })
  })

  it('el texto que corre hacia arriba en una página sin /Rotate se ve girado 270°; con /Rotate 90 se ve derecho', () => {
    expect(pageRotation(1, 0, 90)).toEqual({ page: 1, degrees: 270, target: 90 })
    expect(pageRotation(1, 90, 90)).toBeNull()
    expect(pageRotation(1, 0, 0)).toBeNull()
    expect(pageRotation(1, -90, 270)).toBeNull()
  })

  it('sin texto suficiente no dice nada', () => {
    expect(pageRotation(1, 90, null)).toBeNull()
  })
})

// ---------------------------------------------------------------- PDFs sintéticos de varias páginas

const MOVEMENTS = [
  ['05/03   SPEI RECIBIDO CLIENTE UNO                         5,000.00   15,000.00', '12/03   PAGO PROVEEDOR PAPELERIA             1,000.00                14,000.00'],
  ['31/03   COMISION MANEJO DE CUENTA              250.50                13,749.50'],
] as const
const HEADER = ['BANCO FICTICIO S.A. - ESTADO DE CUENTA', 'Titular: COMERCIALIZADORA DE PRUEBA SA DE CV   RFC: XAXX010101000', 'Periodo: del 01/03/2026 al 31/03/2026', 'Saldo inicial: 10,000.00   Depositos: 5,000.00   Retiros: 1,250.50   Saldo final: 13,749.50']
/** Un estado de cuenta de tres páginas: encabezado, dos movimientos, un movimiento. Cada página imprime "Pág n de total". */
const statementPages = (total = 3): string[][] => [
  [...HEADER, `Pág ${String(1)} de ${String(total)}`],
  ['FECHA   DESCRIPCION                          CARGO       ABONO      SALDO', ...MOVEMENTS[0], `Pág ${String(2)} de ${String(total)}`],
  ['FECHA   DESCRIPCION                          CARGO       ABONO      SALDO', ...MOVEMENTS[1], `Pág ${String(3)} de ${String(total)}`],
]

const pdfjsPage = async (bytes: Uint8Array, page = 1) => {
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
  const p = await doc.getPage(page)
  const text = (await p.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ')
  return { rotate: p.rotate, text, pages: doc.numPages }
}

describe('loadPdf sobre PDFs de varias páginas', () => {
  it('lee la numeración impresa y no ve nada raro en un documento completo', async () => {
    const pdf = await loadPdf(write(syntheticStatementPages(statementPages())))
    expect(pdf.pageCount).toBe(3)
    expect(pdf.pagination).toEqual([
      { page: 1, printed: 1, total: 3 },
      { page: 2, printed: 2, total: 3 },
      { page: 3, printed: 3, total: 3 },
    ])
    expect(pdf.duplicatePages).toEqual([])
    expect(pdf.rotatedPages).toEqual([])
    expect(pdf.straightened).toBe(false)
    const issues = new IssueSink()
    const flags = new Set<never>()
    const checks = reportPageChecks(pdf, issues, flags)
    expect(issues.issues).toEqual([])
    expect(flags.size).toBe(0)
    expect(checks).toEqual({ statements: { documents: 1, restartsAt: [] }, paginated: true })
  })

  it('una página que se repite se reconoce por su huella y por su texto', async () => {
    const [p1, p2, p3] = statementPages()
    const bytes = syntheticStatementPages([p1 ?? [], p2 ?? [], p2 ?? [], p3 ?? []])
    const pdf = await loadPdf(write(bytes))
    expect(pdf.pageCount).toBe(4)
    expect(pdf.duplicates).toEqual([{ page: 3, sameAs: 2 }])
    expect(pdf.duplicatePages).toEqual([3])
    const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
    const prints = await pageFingerprints(doc)
    expect(prints[1]).not.toBeNull()
    expect(prints[1]).toBe(prints[2])
    expect(prints[0]).not.toBe(prints[1])
    expect(new Set(prints).size).toBe(3)
    // La huella sola alcanza: con el mismo contenido y sin texto utilizable que ayude.
    expect(findDuplicatePages(prints, [], numbering([null, null, null, null])).map((d) => d.page)).toEqual([3])
    const issues = new IssueSink()
    const flags = new Set<string>()
    reportPageChecks(pdf, issues, flags as never)
    expect([...flags]).toEqual(['pages_duplicated'])
    expect(issues.issues).toHaveLength(1)
    expect(issues.issues[0]).toMatchObject({ code: 'duplicate_page_removed', severity: 'warning', page: 3, details: { same_as: 2 } })
  })

  it('1/3 y 3/3: falta la página 2', async () => {
    const [p1, , p3] = statementPages()
    const pdf = await loadPdf(write(syntheticStatementPages([p1 ?? [], p3 ?? []])))
    const issues = new IssueSink()
    const flags = new Set<string>()
    reportPageChecks(pdf, issues, flags as never)
    expect([...flags]).toEqual(['pages_missing'])
    expect(issues.issues).toHaveLength(1)
    expect(issues.issues[0]).toMatchObject({ code: 'page_missing', severity: 'warning', details: { missing: [2], total: 3 } })
  })

  it('la numeración que reinicia es un segundo estado de cuenta', async () => {
    const pages = [...statementPages(3), ...statementPages(3)]
    const pdf = await loadPdf(write(syntheticStatementPages(pages)))
    // Las páginas del segundo son idénticas a las del primero: se leen como repetidas (ADR 0057), así que
    // el segundo estado es distinto en el encabezado para esta prueba.
    expect(pdf.duplicatePages).toEqual([4, 5, 6])
    const other = statementPages(3).map((lines, i) => (i === 0 ? lines.map((l) => l.replace('01/03/2026', '01/04/2026').replace('31/03/2026', '30/04/2026')) : lines.map((l) => l.replace('05/03', '05/04').replace('12/03', '12/04').replace('31/03', '30/04'))))
    const two = await loadPdf(write(syntheticStatementPages([...statementPages(3), ...other])))
    expect(two.duplicatePages).toEqual([])
    const issues = new IssueSink()
    const flags = new Set<string>()
    const checks = reportPageChecks(two, issues, flags as never)
    expect(checks.statements).toEqual({ documents: 2, restartsAt: [4] })
    expect([...flags]).toEqual(['multiple_statements'])
    expect(issues.issues[0]).toMatchObject({ code: 'multiple_statements', severity: 'error', details: { documents: 2, restarts_at: [4] } })
  })

  it('/Rotate 90: se detecta la rotación y al modelo va una copia enderezada con el mismo texto', async () => {
    const original = syntheticStatementPages(statementPages(), { rotate: 90 })
    const pdf = await loadPdf(write(original))
    expect(pdf.rotatedPages).toEqual([1, 2, 3].map((page) => ({ page, degrees: 90, target: 0 })))
    expect(pdf.straightened).toBe(true)
    // El hash y el tamaño son los del original; el original no se toca.
    expect(pdf.sha256).toBe(sha(original))
    expect(pdf.sizeBytes).toBe(original.byteLength)
    expect(Buffer.from(pdf.bytes).equals(original)).toBe(true)
    expect(pdf.base64).not.toBe(original.toString('base64'))
    const copy = Buffer.from(pdf.base64, 'base64')
    const before = await pdfjsPage(original, 2)
    const after = await pdfjsPage(copy, 2)
    expect(before.rotate).toBe(90)
    expect(after.rotate).toBe(0)
    expect(after.pages).toBe(3)
    expect(after.text).toBe(before.text)
    // El texto local ya se lee bien.
    expect(pdf.pageTexts[1]).toContain('SPEI RECIBIDO CLIENTE UNO')
    const issues = new IssueSink()
    const flags = new Set<string>()
    reportPageChecks(pdf, issues, flags as never)
    expect([...flags]).toEqual(['rotated_pages'])
    expect(issues.issues.map((i) => [i.code, i.severity, i.page, i.details])).toEqual([1, 2, 3].map((page) => ['page_rotated', 'info', page, { degrees: 90 }]))
  })

  it('solo se endereza la página girada', async () => {
    const pdf = await loadPdf(write(syntheticStatementPages(statementPages())))
    expect(pdf.rotatedPages).toEqual([])
    // Una copia con una sola página girada (se cambia el /Rotate de la segunda con pdf-lib).
    const doc = await PDFDocument.load(syntheticStatementPages(statementPages()))
    doc.getPages()[1]?.setRotation(degrees(270))
    const mixed = await doc.save()
    const loaded = await loadPdf(write(mixed))
    expect(loaded.rotatedPages).toEqual([{ page: 2, degrees: 270, target: 0 }])
    const copy = Buffer.from(loaded.base64, 'base64')
    expect([(await pdfjsPage(copy, 1)).rotate, (await pdfjsPage(copy, 2)).rotate, (await pdfjsPage(copy, 3)).rotate]).toEqual([0, 0, 0])
  })

  it.each([90, 180, 270] as const)('el texto que corre a %i° en el espacio del PDF se lee en orden y la copia queda derecha', async (angle) => {
    const lines = [...SYNTHETIC_STATEMENT_LINES]
    const original = syntheticStatementPages([lines], { textAngle: angle })
    const pdf = await loadPdf(write(original))
    expect(pdf.pageTexts[0]).toBe(lines.map((l) => l.replace(/\s+/g, ' ')).join('\n'))
    expect(pdf.textLayer).toBe('ok')
    // Con /Rotate 0 y el texto girado, la página se ve girada; el /Rotate que la endereza es el ángulo del texto.
    expect(pdf.rotatedPages).toEqual([{ page: 1, degrees: ((360 - angle) % 360) as 90 | 180 | 270, target: angle }])
    const copy = Buffer.from(pdf.base64, 'base64')
    expect((await pdfjsPage(copy)).rotate).toBe(angle)
    // Y con el /Rotate que ya la deja derecha no hay nada que corregir.
    const upright = await loadPdf(write(syntheticStatementPages([lines], { textAngle: angle, rotate: angle })))
    expect(upright.rotatedPages).toEqual([])
    expect(upright.straightened).toBe(false)
    expect(upright.pageTexts[0]).toBe(pdf.pageTexts[0])
  })

  it('un PDF de una página sin numeración no dispara nada', async () => {
    const pdf = await loadPdf(write(syntheticStatementPdf(SYNTHETIC_STATEMENT_LINES)))
    expect(pdf.pagination).toEqual([{ page: 1, printed: null, total: null }])
    const issues = new IssueSink()
    const checks = reportPageChecks(pdf, issues, new Set())
    expect(issues.issues).toEqual([])
    expect(checks).toEqual({ statements: { documents: 1, restartsAt: [] }, paginated: false })
  })
})

describe('PDF escaneado (solo imágenes)', () => {
  /** Un PDF de páginas con una imagen de grises cada una. `images[i]` es la semilla de los píxeles; la misma semilla comparte el objeto de imagen. */
  async function scanned(images: readonly number[], opts: { rotate?: number; copyImageObject?: boolean } = {}): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const refs = new Map<number, ReturnType<typeof doc.context.register>>()
    const size = 64
    for (const seed of images) {
      const makeImage = () => {
        const raw = Buffer.alloc(size * size)
        for (let i = 0; i < raw.length; i++) raw[i] = (seed * 37 + i * (seed + 2)) & 0xff
        return doc.context.register(doc.context.stream(deflateSync(raw), { Type: 'XObject', Subtype: 'Image', Width: size, Height: size, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' }))
      }
      const ref = opts.copyImageObject === true ? makeImage() : (refs.get(seed) ?? makeImage())
      refs.set(seed, ref)
      const page = doc.addPage([612, 792])
      page.node.setXObject(PDFName.of('Im0'), ref)
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 600 0 0 780 6 6 cm /Im0 Do Q')))
      if (opts.rotate !== undefined) page.setRotation(degrees(opts.rotate))
    }
    return doc.save()
  }

  it('la página repetida se reconoce por el contenido de su imagen, comparta o no el objeto', async () => {
    for (const copyImageObject of [false, true]) {
      const pdf = await loadPdf(write(await scanned([1, 2, 1, 3], { copyImageObject })))
      expect(pdf.textLayer).toBe('absent')
      expect(pdf.pagination.every((p) => p.printed === null)).toBe(true)
      expect(pdf.duplicates).toEqual([{ page: 3, sameAs: 1 }])
    }
  })

  it('dos escaneos distintos no son repetidos aunque midan lo mismo', async () => {
    const pdf = await loadPdf(write(await scanned([1, 2, 3, 4])))
    expect(pdf.duplicates).toEqual([])
  })

  it('sin texto no se detecta la rotación ni se genera copia', async () => {
    const original = await scanned([1, 2], { rotate: 90 })
    const pdf = await loadPdf(write(original))
    expect(pdf.rotatedPages).toEqual([])
    expect(pdf.straightened).toBe(false)
    expect(pdf.base64).toBe(Buffer.from(original).toString('base64'))
  })
})
