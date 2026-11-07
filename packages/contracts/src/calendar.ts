/**
 * "Hoy" del negocio (ADR 0046). La fecha de cálculo de una solicitud (antigüedad del documento,
 * vencimientos) es un día del calendario de México, no de UTC: a las 22:00 en la Ciudad de México en
 * UTC ya es mañana. Los instantes se siguen guardando en UTC; esto solo decide qué día es hoy.
 */
export const BUSINESS_TIME_ZONE = 'America/Mexico_City'

/** AAAA-MM-DD en la zona dada (por defecto, la del negocio). */
export function calendarToday(timeZone: string = BUSINESS_TIME_ZONE, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
