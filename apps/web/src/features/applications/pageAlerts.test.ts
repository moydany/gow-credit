import { sampleStatement } from '@gow/contracts/testing'
import { describe, expect, it } from 'vitest'
import { pageAlerts } from './pageAlerts'

describe('pageAlerts: lo marcado en cada página dice qué es y por qué', () => {
  it('un documento verificado no marca ninguna página', () => {
    const x = sampleStatement()
    for (const a of x.accounts) {
      a.account_type.verification = 'verified'
      a.currency.verification = 'verified'
    }
    expect([...pageAlerts(x).keys()].filter((p) => (pageAlerts(x).get(p) ?? []).some((i) => i.label.startsWith('Tipo') || i.label.startsWith('Moneda')))).toEqual([])
  })

  it('un valor sin verificar, un movimiento en conflicto y una alerta salen en su página con su motivo', () => {
    const x = sampleStatement()
    const a = x.accounts[0]
    const t = a?.periods[0]?.transactions[1]
    if (!a || !t) throw new Error('sin cuenta')
    a.account_type.verification = 'unverified'
    t.verification = 'conflict'
    x.issues.push({ id: 'i9', code: 'page_missing', severity: 'warning', message: 'Falta la página 3', page: 2, path: null, account_id: null, period_id: null, transaction_id: null, details: {} })
    const alerts = pageAlerts(x)
    const typePage = a.account_type.source?.page ?? 0
    expect(alerts.get(typePage)).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringMatching(/^Tipo de cuenta: /) as unknown, reason: 'el valor no se encontró tal cual en el texto de la página', tone: 'unverified' })]))
    expect(alerts.get(t.source.page)).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringMatching(/^Cargo del .+ por /) as unknown, reason: 'dos lecturas del documento no coinciden', tone: 'conflict', snippet: t.source.snippet })]))
    expect(alerts.get(2)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Alerta de la extracción', reason: 'Falta la página 3' })]))
  })
})
