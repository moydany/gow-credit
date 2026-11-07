import { describe, expect, it } from 'vitest'
import { StatementExtraction } from './statement.ts'
import { fiscalDocument, missing, sampleStatement, tx } from './testing/fixtures.ts'

function issues(input: unknown) {
  const res = StatementExtraction.safeParse(input)
  if (res.success) throw new Error('se esperaba una extracción inválida')
  return res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

describe('StatementExtraction', () => {
  it('acepta varias cuentas y varios periodos (Santander, Mercado Pago)', () => {
    const doc = StatementExtraction.parse(sampleStatement())
    expect(doc.accounts).toHaveLength(2)
    expect(doc.accounts[0]?.periods).toHaveLength(2)
  })

  it('acepta valores nulos cuando el dato no está en el documento', () => {
    const doc = sampleStatement()
    doc.holder.rfc = { value: null, source: null, verification: 'unverified', confidence: 0, provenance: 'extracted' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza montos negativos: el sentido va en type', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', -10, 'debit', null))
    expect(issues(doc)).toContainEqual({ path: 'accounts.0.periods.0.transactions.2.amount', message: 'el monto no puede ser negativo; el sentido va en `type`' })
  })

  it('rechaza montos con más de dos decimales', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 10.005, 'debit', null))
    expect(issues(doc)[0]?.message).toBe('el monto debe tener a lo más dos decimales')
  })

  it('permite saldos negativos (sobregiro)', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 20000, 'debit', -6250.5))
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza fechas que no son ISO 8601', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '20/03/2026', 10, 'debit', null))
    expect(issues(doc)[0]?.path).toBe('accounts.0.periods.0.transactions.2.date')
  })

  it('exige fuente para todo valor extraído verificado', () => {
    const doc = sampleStatement()
    doc.bank_name = { value: 'BANCO FICTICIO', source: null, verification: 'verified', confidence: 1, provenance: 'extracted' }
    expect(issues(doc)).toEqual([{ path: 'bank_name.source', message: 'un valor extraído verificado debe citar su fuente (página y texto)' }])
  })

  it('un valor extraído sin cita solo puede quedar como no verificado', () => {
    const doc = sampleStatement()
    doc.bank_name = { value: 'BANCO FICTICIO', source: null, verification: 'unverified', confidence: 0.3, provenance: 'extracted' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('no exige fuente a un valor aportado por el proveedor', () => {
    const doc = sampleStatement()
    doc.holder.rfc = { value: 'XAXX010101000', source: null, verification: 'unverified', confidence: 0.5, provenance: 'owner_answer' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('rechaza ids repetidos', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t1', '2026-03-20', 10, 'debit', null))
    expect(issues(doc)[0]?.message).toContain('id repetido "a1.p1.t1"')
  })

  it('rechaza una cita a una página que no existe', () => {
    const doc = sampleStatement()
    doc.accounts[0]?.periods[0]?.transactions.push(tx('a1.p1.t3', '2026-03-20', 10, 'debit', null, 9))
    expect(issues(doc)[0]).toEqual({ path: 'accounts.0.periods.0.transactions.2.source.page', message: 'la página 9 no existe; el documento tiene 3' })
  })

  it('acepta un CFDI con receptor vacío y sellos truncados (como Hey)', () => {
    const doc = sampleStatement()
    doc.fiscal_documents = [
      fiscalDocument('f1', 3, {
        receiver: { rfc: missing(), name: missing(), tax_regime: extracted612(), cfdi_use: missing(), postal_code: missing() },
        seals: { issuer_present: true, sat_present: true, chain_present: true, looks_truncated: true },
      }),
    ]
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })

  it('acepta dos comprobantes en un documento (como Inbursa: ingreso y retenciones)', () => {
    const doc = sampleStatement()
    doc.fiscal_documents = [fiscalDocument('f1', 2), fiscalDocument('f2', 3, { kind: 'withholding' })]
    expect(StatementExtraction.parse(doc).fiscal_documents.map((f) => f.kind)).toEqual(['income', 'withholding'])
  })

  it('el contrato no tiene dónde poner un sello ni la cadena original completa', () => {
    const doc = sampleStatement()
    doc.fiscal_documents = [{ ...fiscalDocument(), issuer_seal: 'kZx9...base64' } as never]
    expect(issues(doc)[0]?.message).toContain('issuer_seal')
  })

  it('acepta fechas fiscales en hora local sin zona', () => {
    const doc = sampleStatement()
    const f = fiscalDocument()
    doc.fiscal_documents = [{ ...f, issued_at: { ...f.issued_at, value: '2026-04-01 10:15:00' } }]
    expect(issues(doc)[0]?.path).toBe('fiscal_documents.0.issued_at.value')
  })

  it('rechaza llaves que no están en el contrato', () => {
    const doc = { ...sampleStatement(), confidence_overall: 0.9 }
    expect(issues(doc)[0]?.message).toContain('confidence_overall')
  })

  it('lee extracciones 1.1.0: 1.2.0 solo agrega loan_payment (ADR 0013)', () => {
    expect(StatementExtraction.safeParse({ ...sampleStatement(), schema_version: '1.1.0' }).success).toBe(true)
    expect(issues({ ...sampleStatement(), schema_version: '1.0.0' })[0]?.path).toBe('schema_version')
  })

  it('acepta pagos a créditos como clasificación de movimiento', () => {
    const doc = sampleStatement()
    const t = doc.accounts[0]?.periods[0]?.transactions[1]
    if (!t) throw new Error('fixture sin movimiento')
    t.classification = { category: 'loan_payment', confidence: 0.85, counterparty: null, counterparty_rfc: null, classifier: 'rules-v1' }
    expect(StatementExtraction.safeParse(doc).success).toBe(true)
  })
})

function extracted612() {
  return { value: '612', source: { page: 3, snippet: 'Régimen Fiscal: 612' }, verification: 'verified' as const, confidence: 1, provenance: 'extracted' as const }
}

describe('domicilio del titular (ADR 0066)', () => {
  it('una extracción 1.2.0 guardada sin domicilio se sigue leyendo, con el domicilio como no leído', () => {
    const s = sampleStatement()
    const { address: _address, ...holder } = s.holder
    const old = StatementExtraction.parse({ ...s, schema_version: '1.2.0', holder })
    expect(old.holder.address).toEqual({ value: null, source: null, verification: 'unverified', confidence: 0, provenance: 'extracted' })
  })

  it('una extracción actual lleva el domicilio con su fuente', () => {
    const s = StatementExtraction.parse(sampleStatement())
    expect(s.holder.address.value).toMatch(/REFORMA/)
    expect(s.holder.address.source).not.toBeNull()
  })
})
