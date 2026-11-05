import { FEATURE_CATALOG, type ApplicationDetail, type Decision, type FeatureName } from '@gow/contracts'
import clsx from 'clsx'
import { useState } from 'react'
import { DECISION_LABEL, featureLabel, featureValue, jsonValue, money, number, OP_LABEL, OUTCOME_LABEL, PROVENANCE_LABEL, VERIFICATION_LABEL, date } from '../../lib/format'
import { Icon } from '../../ui/icons'
import { Button, Chip, Meter, StatusChip } from '../../ui/primitives'

const EXCLUDED: Record<string, string> = { unknown: 'sin dato', low_confidence: 'confianza baja', unverified: 'sin verificar', conflict: 'en conflicto' }

export function DecisionPanel({ detail, onAnswer }: { detail: ApplicationDetail; onAnswer: () => void }) {
  const d = detail.decision?.payload
  const open = detail.clarifications.filter((c) => c.status === 'open')
  if (!d) {
    return (
      <div className="px-6 pb-6 pt-5">
        <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
        <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">
          {detail.status === 'failed' ? <p>La solicitud falló: {detail.failure_reason ?? 'sin detalle'}.</p> : <p>Todavía no hay decisión. La solicitud está {detail.status === 'extracting' ? 'extrayendo el documento' : 'en proceso'}.</p>}
        </div>
      </div>
    )
  }
  return (
    <div className="scroll-thin h-full overflow-y-auto px-6 pb-6 pt-5">
      <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
      <Verdict detail={detail} d={d} />

      {open.length > 0 ? (
        <div className="mt-4 rounded-[24px] bg-indigo-soft p-5">
          <p className="flex items-center gap-2 text-[14px] font-medium text-indigo-ink">
            <Icon name="chat" size={16} /> {open[0]?.questions.length === 1 ? 'Hay una pregunta abierta' : `Hay ${String(open[0]?.questions.length ?? 0)} preguntas abiertas`}
          </p>
          <p className="mt-1 text-[13px] text-indigo-ink/80">La evaluación está en pausa hasta que se conteste.</p>
          <Button className="mt-3" variant="primary" size="sm" onClick={onAnswer}>
            Responder aclaración
          </Button>
        </div>
      ) : null}

      {d.reasons.length > 0 ? (
        <Section title="Por qué">
          <ul className="space-y-2">
            {d.reasons.map((r) => (
              <li key={r.code} className="flex gap-2.5 text-[13.5px] leading-snug">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                {r.message}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {d.next_steps.length > 0 ? (
        <Section title="Qué cambiaría el resultado" hint="Calculado con la misma política">
          <ul className="space-y-2">
            {d.next_steps.map((s) => (
              <li key={s.code} className="inner p-3.5 text-[13px] leading-snug">
                <p className="font-medium">{s.message ?? `${featureLabel(s.feature)}: de ${featureValue(s.feature, s.current_value)} a ${featureValue(s.feature, s.target_value)}`}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <Chip tone="plain">{DECISION_LABEL[s.from.status]}</Chip>
                  <Icon name="right" size={12} />
                  <Chip tone={s.to.status === 'not_qualified' ? 'coral' : 'lime'}>{DECISION_LABEL[s.to.status]}</Chip>
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Compuertas" hint={`${String(d.evaluation.gates.filter((g) => g.outcome === 'pass').length)} de ${String(d.evaluation.gates.length)} pasan`}>
        <ul className="space-y-1.5">
          {d.evaluation.gates.map((g) => (
            <li key={g.id} className="flex items-start gap-3 rounded-2xl px-1 py-1.5">
              <span className={clsx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', g.outcome === 'pass' ? 'bg-lime text-ink' : g.outcome === 'fail' ? 'bg-coral-soft text-coral-ink' : 'hatch text-ink-2')}>
                <Icon name={g.outcome === 'pass' ? 'check' : g.outcome === 'fail' ? 'x' : 'help'} size={13} />
                <span className="sr-only">{g.outcome === 'pass' ? 'Pasa' : g.outcome === 'fail' ? 'No pasa' : 'Desconocido'}</span>
              </span>
              <div className="min-w-0 text-[13px] leading-snug">
                <p className="font-medium">{featureLabel(g.feature)}</p>
                <p className="mt-0.5 text-muted">
                  Valor <span className="tnum font-medium text-ink-2">{FEATURE_CATALOG[g.feature].unit === 'MXN' && typeof g.value === 'number' ? money(g.value) : featureValue(g.feature, g.value)}</span> · regla {OP_LABEL[g.op] ?? g.op} {jsonValue(g.threshold)}
                </p>
                {g.outcome !== 'pass' && g.effect !== 'none' ? <p className="mt-0.5 text-[12px] text-muted">Si falla: {g.effect === 'needs_clarification' ? 'pide aclaración' : g.effect === 'human_review' ? 'pasa a revisión humana' : 'no califica'}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Dimensiones" hint={d.score === null ? 'Sin score' : `Score ${number(d.score)} de 100`}>
        <ul className="space-y-3">
          {d.evaluation.dimensions.map((x) => (
            <li key={x.id}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate font-medium" title={featureLabel(x.feature)}>
                  {featureLabel(x.feature)}
                </span>
                <span className="tnum shrink-0 text-muted">{x.used ? `${number(x.points)} / ${number(x.weight)}` : EXCLUDED[x.excluded_reason ?? 'unknown']}</span>
              </div>
              <div className="mt-1.5">
                <Meter value={x.used ? x.points : 0} max={x.weight} hatch={!x.used} tone="indigo" />
              </div>
            </li>
          ))}
        </ul>
        {d.evaluation.limit ? (
          <p className="inner mt-4 p-3.5 text-[12.5px] leading-relaxed text-ink-2">
            <span className="font-medium">Línea = </span>
            {d.evaluation.limit.terms.map((t) => `${t.term} ${money(t.value)}`).join(' · ')} → <strong className="tnum">{money(d.evaluation.limit.value)}</strong>
          </p>
        ) : null}
      </Section>

      <Profile d={d} />

      {detail.outcomes.length > 0 ? (
        <Section title="Resultado después de financiar">
          <ul className="space-y-1.5 text-[13.5px]">
            {detail.outcomes.map((o) => (
              <li key={o.observed_at} className="flex items-center justify-between">
                <Chip tone={o.outcome === 'paid' ? 'lime' : 'coral'}>{OUTCOME_LABEL[o.outcome]}</Chip>
                <span className="text-muted">{date(o.observed_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <p className="mt-6 text-[11.5px] text-muted">
        Motor {d.engine_version} · política v{d.policy.version} · decidida {date(d.decided_at)}
      </p>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{title}</h3>
        {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Verdict({ detail, d }: { detail: ApplicationDetail; d: Decision }) {
  const final = d.status === 'qualified' || d.status === 'qualified_with_limit' || d.status === 'not_qualified'
  const shadow = detail.shadow
  return (
    <div className={clsx('mt-4 rounded-[26px] p-5', d.status === 'qualified' || d.status === 'qualified_with_limit' ? 'bg-lime-soft' : d.status === 'not_qualified' ? 'bg-coral-soft' : d.status === 'human_review' ? 'bg-amber-soft' : 'bg-indigo-soft')}>
      <div className="flex items-center justify-between gap-3">
        <StatusChip status={d.status} decision />
        <span className="text-[12px] text-ink-2/80">Política v{d.policy.version}</span>
      </div>
      {d.limit !== null ? (
        <>
          <p className="mt-5 text-[12.5px] text-ink-2/80">Línea aprobada</p>
          <p className="display tnum mt-1 text-[46px]">{money(d.limit)}</p>
          {detail.request?.amount ? <p className="mt-2 text-[13px] text-ink-2">de {money(detail.request.amount)} solicitados</p> : null}
        </>
      ) : (
        <p className="display mt-5 text-[26px] leading-tight">{final ? 'No hay línea para esta solicitud' : d.status === 'human_review' ? 'Un analista tiene que revisar' : 'Falta información del proveedor'}</p>
      )}
      {d.score !== null && final ? (
        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1">
            <Meter value={d.score} />
          </div>
          <span className="tnum text-[13px] font-medium">{number(d.score)}/100</span>
        </div>
      ) : null}
      {shadow && shadow.status !== d.status ? (
        <p className="mt-4 rounded-2xl bg-white/60 px-3.5 py-2.5 text-[12.5px]">
          <Icon name="flask" size={13} className="mr-1.5 inline" />
          En sombra (v{shadow.policy_version ?? '?'}) sería <strong>{DECISION_LABEL[shadow.status]}</strong>
        </p>
      ) : null}
    </div>
  )
}

function Profile({ d }: { d: Decision }) {
  const [all, setAll] = useState(false)
  const entries = (Object.entries(d.profile.features) as [FeatureName, Decision['profile']['features'][FeatureName]][]).filter(([, f]) => all || f.value !== null)
  const unknown = Object.values(d.profile.features).filter((f) => f.value === null).length
  return (
    <Section title="Perfil" hint={`${String(Object.keys(d.profile.features).length - unknown)} features con dato`}>
      <ul className="divide-y divide-line/70">
        {entries.map(([name, f]) => (
          <li key={name} className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-[12.5px] leading-snug text-muted">{featureLabel(name)}</p>
              <p className={clsx('tnum shrink-0 text-[13.5px] font-medium', f.value === null && 'text-muted')}>{featureValue(name, f.value)}</p>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted">
              <span className={clsx(f.verification !== 'verified' && 'rounded-md px-1', f.verification === 'unverified' && 'hatch-amber text-amber-ink', f.verification === 'conflict' && 'hatch-coral text-coral-ink')}>{VERIFICATION_LABEL[f.verification]}</span>
              <span>confianza {Math.round(f.confidence * 100)} %</span>
              <span>{PROVENANCE_LABEL[f.provenance]}</span>
            </p>
            {f.note && f.value === null ? <p className="mt-0.5 text-[11.5px] text-muted">{f.note}</p> : null}
          </li>
        ))}
      </ul>
      <button type="button" className="mt-3 inline-flex h-8 items-center rounded-full bg-sunken px-3.5 text-[12.5px] font-medium hover:bg-line" onClick={() => { setAll((v) => !v) }}>
        {all ? 'Ocultar las que no tienen dato' : `Mostrar ${String(unknown)} sin dato`}
      </button>
    </Section>
  )
}
