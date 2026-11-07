/**
 * The business "today". A request calculation date (document age, due dates) is a Mexico calendar
 * day, not a UTC one: at 22:00 in Mexico City it is already tomorrow in UTC. Instants are still
 * stored in UTC; this only decides which day it is.
 */
export const BUSINESS_TIME_ZONE = 'America/Mexico_City'

/** YYYY-MM-DD in the given zone (default: the business zone). */
export function calendarToday(timeZone: string = BUSINESS_TIME_ZONE, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
