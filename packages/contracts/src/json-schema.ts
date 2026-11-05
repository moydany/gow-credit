/**
 * JSON Schema publicado en docs/schema/. Se genera desde los esquemas Zod (nunca a mano) y
 * un test verifica que los archivos versionados estén al día.
 *
 * Las reglas que JSON Schema no puede expresar (operador compatible con el tipo de feature,
 * gramática de limitFormula, pesos que suman 100, ids únicos) solo viven en Zod; el esquema
 * publicado sirve para editores y validación de forma.
 */
import { z } from 'zod'
import { ApplicationResult } from './application.ts'
import { AnswersFile } from './clarification.ts'
import { Decision } from './decision.ts'
import { ExternalSnapshot } from './external.ts'
import { Policy } from './policy.ts'
import { Profile } from './profile.ts'
import { ApplicationRequest } from './request.ts'
import { Scenario } from './scenario.ts'
import { SimulationReport } from './simulation.ts'
import { StatementExtraction } from './statement.ts'

export const PUBLISHED_SCHEMAS = {
  'statement-extraction': StatementExtraction,
  profile: Profile,
  policy: Policy,
  decision: Decision,
  'application-request': ApplicationRequest,
  'external-snapshot': ExternalSnapshot,
  'simulation-report': SimulationReport,
  scenario: Scenario,
  'answers-file': AnswersFile,
  'application-result': ApplicationResult,
} as const

export function toPublishedJsonSchema(name: keyof typeof PUBLISHED_SCHEMAS): Record<string, unknown> {
  const schema = z.toJSONSchema(PUBLISHED_SCHEMAS[name], {
    target: 'draft-2020-12',
    // Forma de entrada: los campos con default (onUnknown, inverse, caps) son opcionales para quien escribe.
    io: 'input',
    unrepresentable: 'any',
  })
  return { $id: `https://gow-credit.local/schema/${name}.schema.json`, ...schema }
}
