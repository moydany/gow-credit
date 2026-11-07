import { describeFailure, DISCARD_REASON_LABELS, DISCARDED_PREFIX, DiscardReason, DOCUMENT_AGE_WARNING, FEATURE_CATALOG, type ApplicationDetail, type Decision, type FeatureName } from '@gow/contracts'
import clsx from 'clsx'
import { useState } from 'react'
import { BigMoney } from '../../ui/primitives'
import { describeTarget, DECISION_LABEL, featureLabel, featureValue, jsonValue, money, number, OP_LABEL, OUTCOME_LABEL, PROVENANCE_LABEL, VERIFICATION_LABEL, date } from '../../lib/format'
import { Icon } from '../../ui/icons'
import { Button, Chip, Meter, StatusChip } from '../../ui/primitives'

const EXCLUDED: Record<string, string> = { unknown: 'sin dato', low_confidence: 'confianza baja', unverified: 'sin verificar', conflict: 'en conflicto' }

/** Estado de cuenta más viejo que el ajuste del tenant (ADR 0049): se analizó igual, pero se avisa. */
function AgeWarning({ d }: { d: Decision }) {
  const warning = d.reasons.find((r) => r.code === DOCUMENT_AGE_WARNING)
  if (!warning) return null
  return (
    <div role="note" className="mt-4 rounded-[24px] bg-amber-soft p-5">
      <p className="flex items-center gap-2 text-[14px] font-medium text-amber-ink">
        <Icon name="alert" size={16} /> Estado de cuenta antiguo
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-amber-ink/85">{warning.message.replace(/^Advertencia: /, '')}</p>
    </div>
  )
}

export function DecisionPanel({ detail, onAnswer, tray }: { detail: ApplicationDetail; onAnswer: () => void; tray?: React.ReactNode }) {
  const d = detail.decision?.payload
  const open = detail.clarifications.filter((c) => c.status === 'open')
  const discardedReason = detail.failure_reason?.startsWith(DISCARDED_PREFIX) ? DiscardReason.safeParse(detail.failure_reason.slice(DISCARDED_PREFIX.length)) : null
  const discarded = discardedReason?.success ? DISCARD_REASON_LABELS[discardedReason.data] : null
  if (!d) {
    return (
      <div className="px-6 pb-6 pt-5">
        <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
        <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">
          {detail.status === 'failed' ? <p>La solicitud no se pudo analizar. {describeFailure(detail.failure_reason).label}</p> : <p>Todavía no hay decisión. La solicitud está {detail.status === 'extracting' ? 'extrayendo el documento' : 'en proceso'}.</p>}
        </div>
      </div>
    )
  }
  return (
    <div className="scroll-thin h-full overflow-y-auto px-6 pb-6 pt-5">
      <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
      {discarded ? (
        <div className="mt-4 rounded-[24px] bg-coral-soft p-5">
          <p className="flex items-center gap-2 text-[14px] font-medium"><Icon name="x" size={16} /> Documento descartado por el analista</p>
          <p className="mt-1 text-[13px] text-ink-2">{discarded}. La solicitud cerró en no califica sin reevaluar; el veredicto de abajo es el que llevó a revisión humana.</p>
        </div>
      ) : null}
      <Verdict detail={detail} d={d} />
      <AgeWarning d={d} />
      {tray}

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

      {d.explanation || d.reasons.length > 0 ? (
        <Section title="Por qué">
          {/* La explicación en prosa (ADR 0045) y, debajo, los motivos del motor para auditar. */}
          {d.explanation ? <p className="text-[14px] leading-relaxed text-ink">{d.explanation.text}</p> : null}
          {d.reasons.length > 0 ? (
            <details className={d.explanation ? 'mt-3' : undefined} open={!d.explanation}>
              <summary className="cursor-pointer text-[12.5px] font-medium text-muted">Detalle del motor</summary>
              <ul className="mt-2 space-y-2">
                {d.reasons.map((r) => (
                  <li key={r.code} className="flex gap-2.5 text-[13px] leading-snug text-ink-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                    {r.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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

      {detail.corrections.length > 0 ? (
        <Section title="Correcciones del analista" hint={String(detail.corrections.length)}>
          <ul className="space-y-2">
            {detail.corrections.map((c) => (
              <li key={c.id} className="inner p-3.5 text-[13px] leading-snug">
                <p className="font-medium">{describeTarget(c.target)}</p>
                <p className="tnum mt-1 flex flex-wrap items-center gap-x-2 text-muted">
                  <span className="line-through decoration-coral/60">{c.read_value === null ? 'sin dato' : String(c.read_value)}</span>
                  <Icon name="right" size={12} />
                  <span className="font-medium text-ink">{String(c.value)}</span>
                </p>
                <p className="mt-1 text-[11.5px] text-muted">
                  {c.created_by ?? 'Analista'} · {date(c.created_at)}
                  {c.page ? ` · p. ${String(c.page)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

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
        Motor {d.engine_version} · política v{detail.decision?.policy_version ?? d.policy.version} · decidida {date(d.decided_at)}
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

/**
 * Lo que se aprueba contra lo que se pidió (ADR 0053): si el monto solicitado cabe en la línea se
 * aprueba el monto y la línea es lo disponible; si no cabe se aprueba la línea; sin monto es la línea
 * máxima. Una decisión evaluada con la línea máxima se tomó sin el monto (por ejemplo, mientras llega
 * la reevaluación con el monto que acaba de dar el proveedor), así que cuenta como sin monto. La
 * tolerancia de centavos es la del aviso por WhatsApp.
 */
function approvalOf(d: Decision, requested: number | null | undefined): { label: string; value: number; note: string | null } | null {
  if (d.limit === null) return null
  const amount = d.reasons.some((r) => r.code === 'evaluated_at_max_line') ? null : (requested ?? null)
  if (amount === null) return { label: 'Línea máxima', value: d.limit, note: null }
  if (amount <= d.limit + 0.005) return { label: 'Monto aprobado', value: amount, note: `Línea disponible hasta ${money(d.limit)}` }
  return { label: 'Línea aprobada', value: d.limit, note: `de ${money(amount)} solicitados; el resto no cabe` }
}

function Verdict({ detail, d }: { detail: ApplicationDetail; d: Decision }) {
  const final = d.status === 'qualified' || d.status === 'qualified_with_limit' || d.status === 'not_qualified'
  const shadow = detail.shadow
  const approval = approvalOf(d, detail.request?.amount)
  return (
    <div className={clsx('mt-4 rounded-[26px] p-5', d.status === 'qualified' || d.status === 'qualified_with_limit' ? 'bg-lime-soft' : d.status === 'not_qualified' ? 'bg-coral-soft' : d.status === 'human_review' ? 'bg-amber-soft' : 'bg-indigo-soft')}>
      <div className="flex items-center justify-between gap-3">
        <StatusChip status={d.status} decision />
        <span className="text-[12px] text-ink-2/80">Política v{detail.decision?.policy_version ?? d.policy.version}</span>
      </div>
      {approval ? (
        <>
          <p className="mt-5 text-[12.5px] text-ink-2/80">{approval.label}</p>
          <BigMoney value={approval.value} className="mt-1 text-[46px]" />
          {approval.note ? <p className="mt-2 text-[13px] text-ink-2">{approval.note}</p> : null}
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
