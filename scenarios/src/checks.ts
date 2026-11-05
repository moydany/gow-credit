/** Aserciones de `expect` sobre un veredicto: las mismas en modo unit y full. */
import type { Decision, ScenarioExpect } from '@gow/contracts'

export interface Check {
  name: string
  ok: boolean
  expected: unknown
  actual: unknown
}

export function checkDecision(decision: Decision, expect: ScenarioExpect): Check[] {
  const checks: Check[] = [{ name: 'status', ok: decision.status === expect.status, expected: expect.status, actual: decision.status }]
  if (expect.limit !== undefined) checks.push({ name: 'limit', ok: decision.limit === expect.limit, expected: expect.limit, actual: decision.limit })
  if (expect.limit_min !== undefined) checks.push({ name: 'limit_min', ok: decision.limit !== null && decision.limit >= expect.limit_min, expected: `>= ${String(expect.limit_min)}`, actual: decision.limit })
  if (expect.limit_max !== undefined) checks.push({ name: 'limit_max', ok: decision.limit !== null && decision.limit <= expect.limit_max, expected: `<= ${String(expect.limit_max)}`, actual: decision.limit })
  const codes = decision.reasons.map((r) => r.code)
  for (const code of expect.reasons_include) checks.push({ name: `reason ${code}`, ok: codes.includes(code), expected: code, actual: codes })
  const stepFeatures = decision.next_steps.flatMap((s) => [s.feature, ...s.related.map((r) => r.feature)])
  for (const f of expect.next_steps_include) checks.push({ name: `next_step ${f}`, ok: stepFeatures.includes(f), expected: f, actual: stepFeatures })
  if (expect.clarification_topics !== undefined) {
    const topics = [...(decision.clarification?.topics ?? [])].sort()
    checks.push({ name: 'clarification_topics', ok: JSON.stringify(topics) === JSON.stringify([...expect.clarification_topics].sort()), expected: expect.clarification_topics, actual: topics })
  }
  for (const [name, value] of Object.entries(expect.features)) {
    const actual = decision.profile.features[name as keyof Decision['profile']['features']].value
    checks.push({ name: `feature ${name}`, ok: JSON.stringify(actual) === JSON.stringify(value), expected: value, actual })
  }
  return checks
}
