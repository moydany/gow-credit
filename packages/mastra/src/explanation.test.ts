import { Decision, emptyExternalSnapshot, type ApplicationRequest, type ExternalSnapshot, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate, decide } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { ZERO_USAGE, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { explanationDraft } from './explanation.ts'
import { checkFigures, pesos } from './figures.ts'
import { Writer } from './writer.ts'

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const supplier: SupplierIdentity = { legal_name: holder.name, rfc: holder.rfc, clabes: [] }
const noCredits: ExternalSnapshot = { ...emptyExternalSnapshot(), existing_credits: { available: true, simulated: true, credits: [] } }
const request: ApplicationRequest = { amount: 100000, maturity: null, buyer: { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] } }

// Como la prueba real (ADR 0045): los pagos a créditos se comen casi todo el ingreso.
const indebted = syntheticStatement(
  { start: '2026-09-01', opening_balance: 20000, monthly: [{ kind: 'customer_payment', amount: 52000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'loan_payment', amount: 48000 }, { kind: 'supplier_payment', amount: 14000 }] },
  holder,
  'x1',
)
const healthy = syntheticStatement(
  { start: '2026-07-01', opening_balance: 20000, months: 3, monthly: [{ kind: 'customer_payment', amount: 180000, counterparty: 'Cadena Norte SA de CV' }, { kind: 'supplier_payment', amount: 60000 }] },
  holder,
  'x2',
)
const decideFor = (statement: typeof indebted, req: ApplicationRequest | null = request) =>
  decide({ policy: basePolicyTemplate(), statements: [statement], request: req, supplier, external: noCredits, computedAt: '2026-10-05T12:00:00.000Z' }).decision

class OneShot implements StructuredLlm {
  calls = 0
  constructor(readonly texts: string[]) {}
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const text = this.texts[this.calls] ?? this.texts.at(-1) ?? ''
    this.calls++
    return Promise.resolve({ object: req.schema.parse({ texts: [{ id: 'e1', text }] }), usage: ZERO_USAGE, costUsd: 0.0001, latencyMs: 1, model: req.model, finishReason: 'stop', responseCacheHit: false })
  }
}

describe('explicación del resultado (ADR 0045)', () => {
  it('nombra la causa real con sus cifras, sin jerga, y la plantilla pasa su propio filtro', () => {
    const d = decideFor(indebted)
    const draft = explanationDraft(d)
    expect(draft.template).toMatch(/^Resultado: /)
    expect(draft.template).toMatch(/pagos a créditos de \$[\d,.]+ \([\d.]+% del ingreso\)/)
    expect(draft.template).toMatch(/flujo libre negativo de \$[\d,.]+ al mes/)
    expect(draft.template).not.toMatch(/[a-z]+_[a-z_]+/)
    expect(checkFigures(draft.template, draft.facts)).toEqual({ ok: true, unsupported: [] })
  })

  it('en perfiles distintos la plantilla siempre pasa el filtro de cifras', () => {
    for (const d of [decideFor(healthy), decideFor(healthy, null), decideFor(indebted, null), decideFor(indebted, { ...request, amount: 5_000_000 })]) {
      const draft = explanationDraft(d)
      expect(checkFigures(draft.template, draft.facts).unsupported, draft.template).toEqual([])
    }
  })

  it('cada dimensión con un solo nombre; lo no evaluado por diseño, aparte y fuera de los motivos', () => {
    // Sin monto ni comprador, como por WhatsApp.
    const d = decideFor(indebted, null)
    const draft = explanationDraft(d, null, { holderType: 'individual' })
    const fact = (name: string) => String(draft.facts.find((f) => f.name === name)?.value ?? '')
    const dims = fact('dimensiones').split('; ')
    expect(new Set(dims.map((x) => x.split(':')[0])).size).toBe(dims.length)
    expect(fact('dimensiones')).toMatch(/la estabilidad \(flujo libre sobre ingresos\): /)
    expect(fact('dimensiones')).not.toMatch(/capacidad de pago/)
    expect(fact('dimensiones')).toMatch(/los pagos del comprador: no se evaluó/)
    // Los motivos que ve Haiku usan los mismos nombres y no traen lo no evaluado por diseño.
    expect(fact('motivos_del_motor')).not.toMatch(/"stability"|"buyer"|buyer_payments_count/)
    expect(draft.template).not.toMatch(/falta de datos: [^.]*(comprador|capacidad)/)
    expect(draft.template).not.toMatch(/limita el resultado/)
    expect(draft.context.no_evaluado_por_diseno).toEqual(expect.arrayContaining(['los pagos del comprador']))
    // Persona física: se dice al principio, con lo que implica.
    expect(draft.template).toMatch(/El titular es persona física\./)
    expect(draft.template).toMatch(/gastos y créditos personales/)
    expect(checkFigures(draft.template, draft.facts).unsupported).toEqual([])
  })

  it('con monto que cabe en la línea se aprueba el monto; el monto es un hecho y el filtro lo permite (ADR 0053)', () => {
    const fits = decideFor(healthy, { ...request, amount: 50000 })
    expect(fits.limit).not.toBeNull()
    const limit = fits.limit ?? 0
    expect(limit).toBeGreaterThan(50000)
    const draft = explanationDraft(fits)
    expect(draft.template).toContain(`Se aprueba el monto solicitado de ${pesos(50000)}; la línea disponible llega a ${pesos(limit)}.`)
    expect(draft.template).not.toMatch(/La línea aprobada es de/)
    expect(draft.facts).toContainEqual({ name: 'monto_solicitado', value: 50000 })
    expect(checkFigures(draft.template, draft.facts)).toEqual({ ok: true, unsupported: [] })
    // Sin el hecho, el filtro rechazaría el monto: por eso se registra.
    const withoutFact = checkFigures(draft.template, draft.facts.filter((f) => f.name !== 'monto_solicitado'))
    expect(withoutFact.unsupported).toContain('50,000.00')
    // Pedir justo la línea también cabe.
    expect(explanationDraft(decideFor(healthy, { ...request, amount: limit })).template).toContain('Se aprueba el monto solicitado de')
  })

  it('con monto mayor a la línea se aprueba la línea, menor al monto solicitado', () => {
    const over = decideFor(healthy, { ...request, amount: 300000 })
    expect(over.limit).not.toBeNull()
    const limit = over.limit ?? 0
    expect(limit).toBeLessThan(300000)
    const draft = explanationDraft(over)
    expect(draft.template).toContain(`Se aprueba una línea de ${pesos(limit)}, menor al monto solicitado de ${pesos(300000)}.`)
    expect(draft.template).not.toMatch(/Se aprueba el monto solicitado/)
    expect(draft.facts).toContainEqual({ name: 'monto_solicitado', value: 300000 })
    expect(checkFigures(draft.template, draft.facts)).toEqual({ ok: true, unsupported: [] })
  })

  it('sin monto pedido (evaluado con la línea máxima) la frase sigue siendo "La línea aprobada"', () => {
    // Como el workflow (ADR 0045): el monto del perfil es la línea máxima, no una petición.
    const atLine = decideFor(healthy, { ...request, amount: decideFor(healthy, { ...request, amount: 50000 }).limit ?? 0 })
    const noAmount = Decision.parse({ ...atLine, reasons: [{ code: 'evaluated_at_max_line', message: 'Sin monto solicitado: se evaluó con la línea máxima.', features: ['requested_amount'] }, ...atLine.reasons] })
    const draft = explanationDraft(noAmount)
    expect(draft.template).toContain(`La línea aprobada es de ${pesos(noAmount.limit ?? 0)}.`)
    expect(draft.template).not.toMatch(/monto solicitado/)
    expect(draft.facts.some((f) => f.name === 'monto_solicitado')).toBe(false)
    expect(checkFigures(draft.template, draft.facts).unsupported).toEqual([])
  })

  it('Haiku redacta; si cita una cifra que no está en los hechos, se intenta otra vez y luego queda la plantilla', async () => {
    const draft = explanationDraft(decideFor(indebted))
    const ok = await new Writer(new OneShot(['El proveedor no califica: casi todo su ingreso se va en pagos a créditos y le queda un flujo libre negativo.'])).explanation(draft)
    expect(ok).toMatchObject({ source: 'writer', errors: [] })
    const bad = new OneShot(['No califica; podría calificar con $999,999.00.'])
    const fallback = await new Writer(bad).explanation(draft)
    expect(fallback).toMatchObject({ source: 'template', text: draft.template })
    expect(bad.calls).toBe(2)
    expect(await new Writer(null).explanation(draft)).toMatchObject({ source: 'template', text: draft.template })
  })
})
