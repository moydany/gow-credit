import { describeFailure, DISCARD_REASON_LABELS, DISCARDED_PREFIX, DiscardReason, DOCUMENT_AGE_WARNING, FEATURE_CATALOG, type ApplicationDetail, type Decision, type FeatureName, type NextStep } from '@gow/contracts'
import clsx from 'clsx'
import { useState } from 'react'
import { BigMoney } from '../../ui/primitives'
import { describeTarget, DECISION_LABEL, featureLabel, featureValue, jsonValue, money, number, OP_LABEL, OUTCOME_LABEL, PROVENANCE_LABEL, VERIFICATION_LABEL, date } from '../../lib/format'
import { approvalOf } from '../../lib/approval'
import { Icon } from '../../ui/icons'
import { Button, Chip, Meter, StatusChip } from '../../ui/primitives'

const EXCLUDED: Record<string, string> = { unknown: 'sin dato', low_confidence: 'confianza baja', unverified: 'sin verificar', conflict: 'en conflicto' }

/** Statement older than the tenant's age limit: analyzed anyway, but flagged. */
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

/**
 * The line before and after a counterfactual. `limit` is added to `NextStep.from`/`to` in the
 * engine contract; read it without assuming it exists, and show it only if both are numbers and
 * differ ("no line" on either side is already covered by the status chips).
 */
function lineChange(step: NextStep): { from: number; to: number } | null {
  const from = (step.from as { limit?: number | null }).limit ?? null
  const to = (step.to as { limit?: number | null }).limit ?? null
  return from !== null && to !== null && from !== to ? { from, to } : null
}

function gateValue(g: Decision['evaluation']['gates'][0]): string {
  if (FEATURE_CATALOG[g.feature].unit === 'MXN' && typeof g.value === 'number') {
    return money(g.value)
  }
  return featureValue(g.feature, g.value)
}

function gateIcon(outcome: string): 'check' | 'x' | 'help' {
  if (outcome === 'pass') return 'check'
  if (outcome === 'fail') return 'x'
  return 'help'
}

function gateTone(outcome: string): string {
  if (outcome === 'pass') return 'bg-accent text-white'
  if (outcome === 'fail') return 'bg-coral-soft text-coral-ink'
  return 'hatch text-ink-2'
}

function gateLabel(outcome: string): string {
  if (outcome === 'pass') return 'Pasa'
  if (outcome === 'fail') return 'No pasa'
  return 'Desconocido'
}

function gateEffectLabel(effect: string): string {
  if (effect === 'needs_clarification') return 'pide aclaración'
  if (effect === 'human_review') return 'pasa a revisión humana'
  return 'no califica'
}

function GateItem({ gate: g }: { gate: Decision['evaluation']['gates'][0] }) {
  const isPass = g.outcome === 'pass'
  const val = gateValue(g)
  return (
    <li className="flex items-start gap-3 rounded-2xl px-1 py-1.5">
      <span className={clsx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full', gateTone(g.outcome))}>
        <Icon name={gateIcon(g.outcome)} size={13} />
        <span className="sr-only">{gateLabel(g.outcome)}</span>
      </span>
      <div className="min-w-0 text-[13px] leading-snug">
        <p className="font-medium">{featureLabel(g.feature)}</p>
        <p className="mt-0.5 text-muted">
          Valor <span className="tnum font-medium text-ink-2">{val}</span> · regla {OP_LABEL[g.op] ?? g.op} {jsonValue(g.threshold)}
        </p>
        {!isPass && g.effect !== 'none' ? (
          <p className="mt-0.5 text-[12px] text-muted">
            Si falla: {gateEffectLabel(g.effect)}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function GatesSection({ gates }: { gates: Decision['evaluation']['gates'] }) {
  const passed = gates.filter((g) => g.outcome === 'pass').length
  return (
    <Section title="Compuertas" hint={`${String(passed)} de ${String(gates.length)} pasan`}>
      <ul className="space-y-1.5">
        {gates.map((g) => (
          <GateItem key={g.id} gate={g} />
        ))}
      </ul>
    </Section>
  )
}

function NextStepsSection({ steps }: { steps: Decision['next_steps'] }) {
  return (
    <Section title="Qué cambiaría el resultado" hint="Calculado con la misma política">
      <ul className="space-y-2">
        {steps.map((s) => {
          const line = lineChange(s)
          return (
            <li key={s.code} className="inner p-3.5 text-[13px] leading-snug">
              <p className="font-medium">{s.message ?? `${featureLabel(s.feature)}: de ${featureValue(s.feature, s.current_value)} a ${featureValue(s.feature, s.target_value)}`}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                <Chip tone="plain">{DECISION_LABEL[s.from.status]}</Chip>
                <Icon name="right" size={12} />
                <Chip tone={s.to.status === 'not_qualified' ? 'coral' : 'accent'}>{DECISION_LABEL[s.to.status]}</Chip>
              </p>
              {line ? (
                <p className="tnum mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                  <span>Línea</span>
                  <span className="text-ink-2">{money(line.from)}</span>
                  <Icon name="right" size={12} />
                  <span className="font-medium text-ink">{money(line.to)}</span>
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function ReasonsSection({ d, discarded }: { d: Decision; discarded: string | null }) {
  if (!d.explanation && d.reasons.length === 0) return null
  return (
    <Section title={discarded ? 'Por qué fue a revisión' : 'Por qué'}>
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
  )
}

function ClarificationAlert({ count, onAnswer }: { count: number; onAnswer: () => void }) {
  return (
    <div className="mt-4 rounded-[24px] bg-indigo-soft p-5">
      <p className="flex items-center gap-2 text-[14px] font-medium text-indigo-ink">
        <Icon name="chat" size={16} /> {count === 1 ? 'Hay una pregunta abierta' : `Hay ${String(count)} preguntas abiertas`}
      </p>
      <p className="mt-1 text-[13px] text-indigo-ink/80">La evaluación está en pausa hasta que se conteste.</p>
      <Button className="mt-3" variant="primary" size="sm" onClick={onAnswer}>
        Responder aclaración
      </Button>
    </div>
  )
}

function resolveDiscarded(failureReason?: string | null): string | null {
  if (!failureReason?.startsWith(DISCARDED_PREFIX)) return null
  const parsed = DiscardReason.safeParse(failureReason.slice(DISCARDED_PREFIX.length))
  return parsed.success ? DISCARD_REASON_LABELS[parsed.data] : null
}

function EmptyDecisionView({ detail }: { detail: ApplicationDetail }) {
  return (
    <div className="px-6 pb-6 pt-5">
      <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
      <div className="hatch mt-4 rounded-3xl p-6 text-[14px] text-ink-2">
        {detail.status === 'failed' ? (
          <p>La solicitud no se pudo analizar. {describeFailure(detail.failure_reason).label}</p>
        ) : (
          <p>Todavía no hay decisión. La solicitud está {detail.status === 'extracting' ? 'extrayendo el documento' : 'en proceso'}.</p>
        )}
      </div>
    </div>
  )
}

function DimensionsSection({ d }: { d: Decision }) {
  return (
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
  )
}

function CorrectionsSection({ corrections }: { corrections: ApplicationDetail['corrections'] }) {
  if (corrections.length === 0) return null
  return (
    <Section title="Correcciones del analista" hint={String(corrections.length)}>
      <ul className="space-y-2">
        {corrections.map((c) => (
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
  )
}

function OutcomesSection({ outcomes }: { outcomes: ApplicationDetail['outcomes'] }) {
  if (outcomes.length === 0) return null
  return (
    <Section title="Resultado después de financiar">
      <ul className="space-y-1.5 text-[13.5px]">
        {outcomes.map((o) => (
          <li key={o.observed_at} className="flex items-center justify-between">
            <Chip tone={o.outcome === 'paid' ? 'accent' : 'coral'}>{OUTCOME_LABEL[o.outcome]}</Chip>
            <span className="text-muted">{date(o.observed_at)}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function DecisionPanel({ detail, onAnswer, tray }: { detail: ApplicationDetail; onAnswer: () => void; tray?: React.ReactNode }) {
  const d = detail.decision?.payload
  const open = detail.clarifications.filter((c) => c.status === 'open')
  const discarded = resolveDiscarded(detail.failure_reason)
  if (!d) {
    return <EmptyDecisionView detail={detail} />
  }
  return (
    <div className="scroll-thin h-full overflow-y-auto px-6 pb-6 pt-5">
      <h2 className="text-[17px] font-medium tracking-tight">Decisión</h2>
      {discarded ? <Discarded detail={detail} d={d} reason={discarded} /> : <Verdict detail={detail} d={d} />}
      <AgeWarning d={d} />
      {tray}

      {open.length > 0 && open[0] ? <ClarificationAlert count={open[0].questions.length} onAnswer={onAnswer} /> : null}

      <ReasonsSection d={d} discarded={discarded} />

      {d.next_steps.length > 0 && !discarded ? <NextStepsSection steps={d.next_steps} /> : null}

      <GatesSection gates={d.evaluation.gates} />

      <DimensionsSection d={d} />

      <Profile d={d} />

      <CorrectionsSection corrections={detail.corrections} />

      <OutcomesSection outcomes={detail.outcomes} />
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

/** The analyst discarded the document in human review: closed as not qualified, no re-evaluation. */
function Discarded({ detail, d, reason }: { detail: ApplicationDetail; d: Decision; reason: string }) {
  return (
    <div className="mt-4 rounded-[26px] bg-coral-soft p-5">
      <div className="flex items-center justify-between gap-3">
        <StatusChip status="not_qualified" decision />
        <span className="text-[12px] text-ink-2/80">Política v{detail.decision?.policy_version ?? d.policy.version}</span>
      </div>
      <p className="display mt-5 text-[26px] leading-tight">Documento descartado por el analista</p>
      <p className="mt-2 text-[13px] text-ink-2">{reason}. La solicitud cerró en no califica sin reevaluar.</p>
    </div>
  )
}

function verdictTone(status: Decision['status']): string {
  if (status === 'qualified' || status === 'qualified_with_limit') return 'bg-accent-soft'
  if (status === 'not_qualified') return 'bg-coral-soft'
  if (status === 'human_review') return 'bg-amber-soft'
  return 'bg-indigo-soft'
}

function verdictMessage(final: boolean, status: Decision['status']): string {
  if (final) return 'No hay línea para esta solicitud'
  if (status === 'human_review') return 'Un analista tiene que revisar'
  return 'Falta información del proveedor'
}

function Verdict({ detail, d }: { detail: ApplicationDetail; d: Decision }) {
  const final = d.status === 'qualified' || d.status === 'qualified_with_limit' || d.status === 'not_qualified'
  const shadow = detail.shadow
  const approval = approvalOf(d, detail.request?.amount)
  return (
    <div className={clsx('mt-4 rounded-[26px] p-5', verdictTone(d.status))}>
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
        <p className="display mt-5 text-[26px] leading-tight">{verdictMessage(final, d.status)}</p>
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
