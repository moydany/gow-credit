/**
 * Dobles simulados de las fuentes externas (docs/06 §2): responden con los datos del bloque
 * `external` de un escenario. Nada del cálculo sabe que está en simulación; solo el snapshot
 * marca `simulated: true`.
 */
import type { ScenarioExternal } from '@gow/contracts'
import { addDays } from '../util/dates.ts'
import { normalizeText } from '../util/text.ts'
import type { ApplicationHistoryPort, CreditBureauPort, ExistingCreditsPort, ExternalPorts, ProgramPort, TaxAuthorityPort } from './ports.ts'

export interface SimulatedOptions {
  /** Fecha del reloj del escenario: `seen_elsewhere.days_ago` se convierte en fecha con ella. */
  asOf: string
}

export function simulatedPorts(external: ScenarioExternal, opts: SimulatedOptions): Required<ExternalPorts> {
  const existingCredits: ExistingCreditsPort = {
    simulated: true,
    creditsOf: (id) => Promise.resolve(external.existing_credits[id] ?? []),
  }
  const creditBureau: CreditBureauPort = {
    simulated: true,
    reportOf: (id) => Promise.resolve(external.bureau[id] ?? null),
  }
  const taxAuthority: TaxAuthorityPort = {
    simulated: true,
    taxpayer: (id) => {
      const s = external.sat[id]
      return Promise.resolve(s ? { rfc_valid: s.rfc_valid, compliance_opinion: s.compliance_opinion, list_status: s.list_status } : null)
    },
    cfdiStatus: (q) => {
      const entry = Object.entries(external.cfdi).find(([uuid]) => uuid.toUpperCase() === q.uuid.toUpperCase())
      // Un UUID que el doble no conoce: el SAT respondería "No encontrado".
      return Promise.resolve(entry ? entry[1] : 'not_found')
    },
    listedAmong: (rfcs) =>
      Promise.resolve(
        rfcs
          .map((rfc) => ({ rfc: rfc.toUpperCase(), list_status: external.sat_lists[rfc.toUpperCase()] }))
          .filter((x): x is { rfc: string; list_status: NonNullable<typeof x.list_status> } => x.list_status !== undefined && x.list_status !== 'clear'),
      ),
  }
  const program: ProgramPort = {
    simulated: true,
    availableLimit: (buyer) => {
      const key = normalizeText(buyer.name)
      const hit = Object.entries(external.program).find(([name]) => normalizeText(name) === key)
      return Promise.resolve(hit ? hit[1] : null)
    },
  }
  const history: ApplicationHistoryPort = {
    simulated: true,
    priorApplications: (id) => Promise.resolve(external.history[id]?.prior_applications ?? []),
    statementReuse: (uuids) => {
      const set = new Set(uuids.map((u) => u.toUpperCase()))
      return Promise.resolve(Object.values(external.history).flatMap((h) => h.statement_reuse.filter((r) => set.has(r.uuid.toUpperCase()))))
    },
    seenElsewhere: (uuids) => {
      const set = new Set(uuids.map((u) => u.toUpperCase()))
      return Promise.resolve(
        Object.values(external.history).flatMap((h) => h.seen_elsewhere.filter((s) => set.has(s.uuid.toUpperCase())).map((s) => ({ uuid: s.uuid, seen_on: addDays(opts.asOf, -s.days_ago) }))),
      )
    },
  }
  return { existingCredits, creditBureau, taxAuthority, program, history }
}
