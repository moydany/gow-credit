/**
 * Modo `unit` de un escenario (fase 4): estados de cuenta sintéticos → clasificación por reglas
 * → fuentes externas simuladas → perfil → política → veredicto, y se compara con `expect`. Sin
 * LLM, sin base, sin red. El modo `full` (fase 6) corre el workflow real sobre los PDFs.
 */
import type { Decision, Policy, Scenario, SupplierIdentity } from '@gow/contracts'
import { buildLedger, decide, gatherExternal, simulatedPorts } from '@gow/decision'
import { syntheticStatement } from '@gow/decision/testing'
import { checkDecision, type Check } from './checks.ts'


export interface UnitResult {
  scenario: Scenario
  supplierId: string
  decision: Decision
  checks: Check[]
  ok: boolean
}

export type PolicyLoader = (ref: string) => { id: string; policy: Policy }

const AS_OF_TIME = 'T12:00:00.000Z'

export async function runUnit(scenario: Scenario, loadPolicy: PolicyLoader, policyOverride?: { id: string; policy: Policy }): Promise<UnitResult> {
  const expect = scenario.expect
  const sup = scenario.suppliers.find((s) => s.id === (expect.supplier ?? scenario.suppliers[0]?.id))
  if (!sup) throw new Error(`escenario ${scenario.id} sin proveedor`)
  const identity: SupplierIdentity = { legal_name: sup.name, rfc: sup.rfc, clabes: sup.clabes }
  const statements = sup.statements.map((spec, i) => syntheticStatement(spec, { name: sup.name, rfc: sup.rfc, clabe: sup.clabes[0] ?? null }, `${scenario.id}-${sup.id}-${String(i)}`))
  const request = sup.request

  // Las reglas leen los RFC de contraparte de las descripciones; con ellos se consultan las listas del SAT.
  const ledger = buildLedger(statements, { request, minConfidence: 0.7 })
  const rfcs = [...new Set(ledger.rows.map((r) => r.classification.counterparty_rfc).filter((r): r is string => r !== null))]
  const external = await gatherExternal(simulatedPorts(scenario.external, { asOf: scenario.as_of }), { supplierId: sup.id, supplier: identity, request, statements }, rfcs)

  const { id, policy } = policyOverride ?? loadPolicy(scenario.tenant.policy)
  const { decision } = decide({ policy, policyId: id, statements, request, supplier: identity, external, computedAt: `${scenario.as_of}${AS_OF_TIME}` })

  const checks = checkDecision(decision, expect)
  return { scenario, supplierId: sup.id, decision, checks, ok: checks.every((c) => c.ok) }
}
