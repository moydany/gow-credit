import type { ApplicationRow } from '@gow/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { date, money, OUTCOME_LABEL } from '../../lib/format'
import { useApplications } from '../../lib/queries'
import { Button, Card, CardHeader, Chip, EmptyState, ErrorState, SegmentBar, Skeleton } from '../../ui/primitives'
import { useToast } from '../../ui/toast'
import { PageTitle } from '../applications/ApplicationsPage'

type Outcome = keyof typeof OUTCOME_LABEL

/** Lo que pasó después de financiar (docs/03 §8): es el dato que cierra el loop y alimenta la simulación de políticas. */
export function OutcomesPage() {
  const { data, isPending, isError, error, refetch } = useApplications()
  const funded = (data ?? []).filter((a) => a.status === 'qualified' || a.status === 'qualified_with_limit')
  const count = (o: Outcome) => funded.filter((a) => a.outcome === o).length
  const recorded = funded.filter((a) => a.outcome).length
  const bad = count('late') + count('default') + count('fraud')
  return (
    <div>
      <PageTitle title="Outcomes" muted={recorded ? `${String(Math.round((bad / recorded) * 100))} % con problema` : undefined} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card rise={0} className="pb-3">
          <CardHeader title="Solicitudes calificadas" subtitle="Registra cómo terminó cada una una vez financiada" />
          {isError ? (
            <ErrorState message={error.message} onRetry={() => void refetch()} />
          ) : isPending ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 rounded-3xl" />
              ))}
            </div>
          ) : funded.length === 0 ? (
            <EmptyState icon="check" title="Aún no hay solicitudes calificadas">Cuando una solicitud califique y se financie, registra aquí si pagó, se atrasó o cayó en mora.</EmptyState>
          ) : (
            <ul className="mt-3 px-3">
              {funded.map((a) => (
                <li key={a.id} className="border-t border-line/70 first:border-0">
                  <OutcomeRow a={a} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card rise={1} className="self-start p-6">
          <h2 className="text-[17px] font-medium tracking-tight">Lo observado</h2>
          <p className="display tnum mt-6 text-[52px]">{recorded}</p>
          <p className="mt-2 text-[13px] text-muted">de {funded.length} con outcome registrado</p>
          <SegmentBar
            className="mt-5"
            segments={[
              { value: count('paid'), className: 'bg-lime', label: OUTCOME_LABEL.paid },
              { value: count('late'), className: 'bg-amber', label: OUTCOME_LABEL.late },
              { value: count('default'), className: 'bg-coral', label: OUTCOME_LABEL.default },
              { value: count('fraud'), className: 'bg-ink', label: OUTCOME_LABEL.fraud },
              { value: funded.length - recorded, className: 'hatch', label: 'Sin registrar' },
            ]}
          />
          <p className="mt-4 text-[12.5px] leading-relaxed text-muted">Con estos datos, <strong className="font-medium text-ink-2">Simular</strong> en Políticas mide la mora que habría tenido cada versión.</p>
        </Card>
      </div>
    </div>
  )
}

function OutcomeRow({ a }: { a: ApplicationRow }) {
  const [outcome, setOutcome] = useState<Outcome>('paid')
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10))
  const toast = useToast()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.recordOutcome({ application_id: a.id, outcome, observed_at: `${day}T12:00:00.000Z` }),
    onSuccess: () => {
      toast.ok('Outcome registrado')
      void qc.invalidateQueries()
    },
    onError: (e: unknown) => { toast.error(e instanceof ApiError ? e.message : 'No se pudo registrar') },
  })
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-3 py-4">
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-[15px] font-medium">{a.supplier.legal_name}</p>
        <p className="tnum mt-0.5 text-[13px] text-muted">Línea {money(a.decision?.limit)} · calificada {date(a.updated_at)}</p>
      </div>
      {a.outcome ? (
        <Chip tone={a.outcome === 'paid' ? 'lime' : a.outcome === 'late' ? 'amber' : 'coral'} dot>
          {OUTCOME_LABEL[a.outcome]}
        </Chip>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <label>
            <span className="sr-only">Qué pasó</span>
            <select value={outcome} onChange={(e) => { setOutcome(e.target.value as Outcome) }} className="input h-10 w-auto pr-8">
              {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABEL[o]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Fecha observada</span>
            <input type="date" value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDay(e.target.value) }} className="input h-10 w-auto" />
          </label>
          <Button size="sm" variant="lime" type="submit" disabled={save.isPending || !day}>
            Registrar
          </Button>
        </form>
      )}
    </div>
  )
}
