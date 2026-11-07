/**
 * Base types of all contracts: amounts, dates, ratios, document references and the `Field`
 * wrapper that carries the origin and verification of each value.
 */
import { z } from 'zod'
import { Provenance, Verification } from './enums.ts'

const TWO_DECIMALS_EPSILON = 1e-6

function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < TWO_DECIMALS_EPSILON
}

/** Signed amount (balances can be negative from overdraft), at most two decimals. */
export const SignedMoney = z
  .number()
  .refine(Number.isFinite, { error: 'el monto debe ser un número finito' })
  .refine(hasAtMostTwoDecimals, { error: 'el monto debe tener a lo más dos decimales' })
  .describe('Monto en la moneda de la cuenta, a lo más dos decimales')

/** Non-negative amount. Transactions use this type and carry direction in `type`. */
export const Money = SignedMoney.refine((n) => n >= 0, { error: 'el monto no puede ser negativo; el sentido va en `type`' }).describe(
  'Monto no negativo, a lo más dos decimales',
)

/** Non-negative integer count. */
export const Count = z.int().nonnegative()

/** Proportion as a fraction (0.25 = 25 %). May be negative or above 1 where it makes sense. */
export const Ratio = z.number().refine(Number.isFinite, { error: 'la proporción debe ser un número finito' }).describe('Fracción: 0.25 = 25 %')

/** Confidence from 0 to 1. Derived from checks, not self-reported by the model. */
export const Confidence = z.number().min(0).max(1)

/** ISO 8601 date (YYYY-MM-DD). */
export const IsoDate = z.iso.date()

/** ISO 8601 date and time with zone. */
export const IsoDateTime = z.iso.datetime({ offset: true })

/** Local date and time without zone (YYYY-MM-DDTHH:mm:ss): how CFDI print it (Mexico time). */
export const IsoLocalDateTime = z.iso.datetime({ local: true, offset: true })

/** ISO 4217 currency. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, { error: 'la moneda debe ser un código ISO 4217 de tres letras (MXN, USD)' })

/** Hex SHA-256. */
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, { error: 'sha256 debe ser hexadecimal de 64 caracteres en minúsculas' })

/** Short id stable within a document or policy (snake or kebab case, dots allowed). */
export const LocalId = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, { error: 'id inválido: usa minúsculas, dígitos, `_`, `-` o `.`' })

/** Where a value was read: page (from 1) and the literal document text. */
export const SourceRef = z
  .strictObject({
    page: z.int().min(1),
    snippet: z.string().min(1).max(600).describe('Texto literal del documento donde se leyó el valor'),
  })
  .meta({ id: 'SourceRef', description: 'Página y texto literal de donde sale un valor' })
export type SourceRef = z.infer<typeof SourceRef>

/**
 * An extracted value with its origin and verification. `value: null` means the datum is not in
 * the document (never invented). An extracted `verified` value must cite its source; if the model
 * gave no quote and it could not be located on the page, the value is kept as `unverified` and
 * decides nothing. A value supplied by the supplier or an analyst may have no document source.
 */
export function field<T extends z.ZodType>(value: T) {
  return z
    .strictObject({
      value: value.nullable(),
      source: SourceRef.nullable(),
      verification: Verification,
      confidence: Confidence,
      provenance: Provenance,
    })
    .superRefine((parsed, ctx) => {
      // With a generic T, TypeScript cannot resolve `value` in the inferred type.
      const f = parsed as unknown as { value: unknown; source: SourceRef | null; provenance: Provenance; verification: Verification }
      if (f.value !== null && f.provenance === 'extracted' && f.verification === 'verified' && f.source === null) {
        ctx.addIssue({ code: 'custom', path: ['source'], message: 'un valor extraído verificado debe citar su fuente (página y texto)' })
      }
    })
}

/** Token usage of one or more Anthropic calls. */
export const TokenUsage = z
  .strictObject({
    input_tokens: Count,
    output_tokens: Count,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  })
  .meta({ id: 'TokenUsage' })
export type TokenUsage = z.infer<typeof TokenUsage>
