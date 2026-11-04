/**
 * Tipos base de todos los contratos: montos, fechas, proporciones, referencias al
 * documento y el envoltorio `Field` que lleva origen y verificación de cada valor.
 */
import { z } from 'zod'
import { Provenance, Verification } from './enums.ts'

const TWO_DECIMALS_EPSILON = 1e-6

function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < TWO_DECIMALS_EPSILON
}

/** Monto con signo (saldos pueden ser negativos por sobregiro), a lo más dos decimales. */
export const SignedMoney = z
  .number()
  .refine(Number.isFinite, { error: 'el monto debe ser un número finito' })
  .refine(hasAtMostTwoDecimals, { error: 'el monto debe tener a lo más dos decimales' })
  .describe('Monto en la moneda de la cuenta, a lo más dos decimales')

/** Monto no negativo. Los movimientos usan este tipo y llevan el sentido en `type`. */
export const Money = SignedMoney.refine((n) => n >= 0, { error: 'el monto no puede ser negativo; el sentido va en `type`' }).describe(
  'Monto no negativo, a lo más dos decimales',
)

/** Conteo entero no negativo. */
export const Count = z.int().nonnegative()

/** Proporción como fracción (0.25 = 25 %). Puede ser negativa o mayor a 1 donde tenga sentido. */
export const Ratio = z.number().refine(Number.isFinite, { error: 'la proporción debe ser un número finito' }).describe('Fracción: 0.25 = 25 %')

/** Confianza de 0 a 1. Derivada de chequeos, no autoreportada por el modelo (docs/04 §3). */
export const Confidence = z.number().min(0).max(1)

/** Fecha ISO 8601 (YYYY-MM-DD). */
export const IsoDate = z.iso.date()

/** Fecha y hora ISO 8601 con zona. */
export const IsoDateTime = z.iso.datetime({ offset: true })

/** Fecha y hora local sin zona (YYYY-MM-DDTHH:mm:ss): así imprimen los CFDI (hora de México). */
export const IsoLocalDateTime = z.iso.datetime({ local: true, offset: true })

/** Moneda ISO 4217. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, { error: 'la moneda debe ser un código ISO 4217 de tres letras (MXN, USD)' })

/** SHA-256 en hexadecimal. */
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, { error: 'sha256 debe ser hexadecimal de 64 caracteres en minúsculas' })

/** Identificador corto estable dentro de un documento o una política (snake o kebab, con puntos). */
export const LocalId = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, { error: 'id inválido: usa minúsculas, dígitos, `_`, `-` o `.`' })

/** Dónde se leyó un valor: página (desde 1) y texto literal del documento. */
export const SourceRef = z
  .strictObject({
    page: z.int().min(1),
    snippet: z.string().min(1).max(600).describe('Texto literal del documento donde se leyó el valor'),
  })
  .meta({ id: 'SourceRef', description: 'Página y texto literal de donde sale un valor' })
export type SourceRef = z.infer<typeof SourceRef>

/**
 * Un valor extraído con su origen y su verificación. `value: null` significa que el dato
 * no está en el documento (nunca se inventa). Un valor extraído y `verified` debe citar su
 * fuente; si el modelo no dio la cita y no se pudo ubicar en la página, el valor se conserva
 * como `unverified` y no decide nada (docs/04 §5). Un valor aportado por el proveedor o un
 * analista puede no tener fuente en el documento.
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
      // Con T genérico, TypeScript no puede resolver `value` en el tipo inferido.
      const f = parsed as unknown as { value: unknown; source: SourceRef | null; provenance: Provenance; verification: Verification }
      if (f.value !== null && f.provenance === 'extracted' && f.verification === 'verified' && f.source === null) {
        ctx.addIssue({ code: 'custom', path: ['source'], message: 'un valor extraído verificado debe citar su fuente (página y texto)' })
      }
    })
}

/** Uso de tokens de una o varias llamadas a Anthropic. */
export const TokenUsage = z
  .strictObject({
    input_tokens: Count,
    output_tokens: Count,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  })
  .meta({ id: 'TokenUsage' })
export type TokenUsage = z.infer<typeof TokenUsage>
