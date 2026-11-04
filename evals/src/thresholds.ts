/**
 * Umbrales de la eval de extracción (docs/04 §6, ADR 0012). Por documento: un banco que cae
 * bajo cualquiera de ellos con el modelo por defecto falla `pnpm eval`. Invención y omisión
 * van por separado porque se corrigen con medidas distintas.
 */
export const THRESHOLDS = {
  /** Precisión de movimientos: a lo más 0.5 % de filas inventadas. */
  precision: 0.995,
  /** Recall de movimientos: a lo más 1 % de filas omitidas. */
  recall: 0.99,
  /** Exactitud por fila emparejada. */
  amount: 0.995,
  date: 0.99,
  type: 0.995,
  balance: 0.99,
  /** Descripción difusa (description + reference contra la fila del banco). */
  description: 0.9,
  /** Encabezado y resumen por campo (incluye no inventar lo redactado). */
  header: 0.9,
  /** CFDI por campo. */
  fiscal: 0.85,
  /** El documento debe terminar cuadrado (a la primera o tras la relectura). */
  reconciled_final: true,
} as const

export type ThresholdKey = Exclude<keyof typeof THRESHOLDS, 'reconciled_final'>
