/**
 * Los validadores de formato viven en `@gow/contracts` (los usa también el perfil de
 * `packages/decision`); se reexportan aquí para no cambiar los imports de la extracción.
 */
export { checkClabe, checkRfc, findCounterpartyRfc, rfcRoot, type FormatCheck, type RfcCheck } from '@gow/contracts'
