/**
 * Simulation of a policy over a set of profiles: before activating a version, past requests are
 * re-evaluated (each decision stores its full profile) and compared with the current version:
 * how many change status, in which direction, and what delinquency was observed in those with
 * an outcome. It is the offline replay.
 */
import { z } from 'zod'
import { DecisionStatus } from './enums.ts'
import { Profile } from './profile.ts'
import { Count, LocalId, Money, Ratio } from './primitives.ts'

/** What happened after funding (paid, delay, default, fraud). */
export const LoanOutcome = z.enum(['paid', 'late', 'default', 'fraud'])
export type LoanOutcome = z.infer<typeof LoanOutcome>

export const SimulationCase = z
  .strictObject({
    id: LocalId,
    profile: Profile,
    outcome: LoanOutcome.nullable(),
  })
  .meta({ id: 'SimulationCase' })
export type SimulationCase = z.infer<typeof SimulationCase>

const Result = z.strictObject({ status: DecisionStatus, score: z.number().nullable(), limit: Money.nullable() })

export const SimulationReport = z
  .strictObject({
    policy: z.strictObject({ id: z.string().nullable(), version: z.int().min(1) }),
    baseline: z.strictObject({ id: z.string().nullable(), version: z.int().min(1) }).nullable(),
    total: Count,
    by_status: z.record(DecisionStatus, Count),
    cases: z.array(z.strictObject({ id: LocalId, outcome: LoanOutcome.nullable(), draft: Result, baseline: Result.nullable() })),
    transitions: z
      .strictObject({
        upgraded: Count.describe('Casos con un estado mejor que con la política vigente'),
        downgraded: Count,
        unchanged: Count,
        limit_increased: Count,
        limit_decreased: Count,
      })
      .nullable()
      .describe('null si no hay política vigente contra la cual comparar'),
    outcomes: z
      .array(
        z.strictObject({
          status: DecisionStatus,
          with_outcome: Count,
          bad: Count.describe('late, default o fraud'),
          bad_rate: Ratio.nullable(),
        }),
      )
      .describe('Mora observada por estado con la política simulada'),
  })
  .meta({ id: 'SimulationReport', title: 'Simulación de política' })
export type SimulationReport = z.infer<typeof SimulationReport>
