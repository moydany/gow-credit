/**
 * JSON Schema published in docs/schema/. Generated from the Zod schemas (never by hand); a test
 * checks the versioned files are up to date.
 *
 * Rules JSON Schema cannot express (operator compatible with the feature type, limitFormula
 * grammar, weights summing to 100, unique ids) live only in Zod; the published schema is for
 * editors and shape validation.
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
    // Input shape: fields with a default (onUnknown, inverse, caps) are optional for the writer.
    io: 'input',
    unrepresentable: 'any',
  })
  return { $id: `https://gow-credit.local/schema/${name}.schema.json`, ...schema }
}
