import { emptyExternalSnapshot, type ApplicationRequest, type ExternalSnapshot, type SupplierIdentity } from '@gow/contracts'
import { basePolicyTemplate, decide } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { ZERO_USAGE, type StructuredLlm, type StructuredRequest, type StructuredResult } from '@gow/llm'
import { describe, expect, it } from 'vitest'
import { explanationDraft } from './explanation.ts'
import { checkFigures } from './figures.ts'
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
