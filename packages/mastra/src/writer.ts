/**
 * Writing for the provider: Haiku puts the questions and `next_steps` into words from structured
 * facts, and the figures filter decides whether the text is used. A text citing a figure outside
 * its facts is regenerated once; if it fails again, or the model is unavailable, the code's
 * template stays, which always passes the filter.
 */
import { FEATURE_CATALOG, type DecisionStatus, type FeatureName, type PromptName, type NextStep, type Question, type QuestionFact } from '@gow/contracts'
import { LIGHT_MODEL, loadPrompt, type StructuredLlm, type StructuredResult } from '@gow/llm'
import { z } from 'zod'
import { checkFigures, pesos } from './figures.ts'

export interface CallRecord {
  purpose: string
  model: string
  cost_usd: number
  cache_hit: boolean
}

export const SUPPLIER_STATUS_TEXT: Record<DecisionStatus, string> = {
  qualified: 'calificas',
  qualified_with_limit: 'calificas con límite',
  not_qualified: 'no calificas',
  needs_clarification: 'falta aclarar datos',
  human_review: 'pasa a revisión de un analista',
}

const Texts = z.object({ texts: z.array(z.object({ id: z.string(), text: z.string().min(1).max(1200) })) })

function round(v: number, d: number): number {
  const f = 10 ** d
  return Math.round(v * f) / f
}

/** A feature's value as the provider reads it, by unit. */
export function valueText(feature: FeatureName, v: unknown): string {
  if (v === null || v === undefined) return 'sin dato'
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (Array.isArray(v)) return v.length === 0 ? 'ninguna' : v.map(String).join(', ')
  if (typeof v !== 'number') return typeof v === 'string' ? v : JSON.stringify(v)
  switch (FEATURE_CATALOG[feature].unit) {
    case 'MXN':
      return pesos(v)
    case 'ratio':
      return `${String(round(v * 100, 1))}%`
    case 'days':
      return `${String(v)} días`
    case 'months':
      return `${String(v)} ${v === 1 ? 'mes' : 'meses'}`
    default:
      return String(v)
  }
}

/** Feature name for the provider: the catalog description minus clarifications that carry figures. */
export function featureLabel(feature: FeatureName): string {
  return FEATURE_CATALOG[feature].description.replace(/;.*$/, '').replace(/\s*\([^)]*\d[^)]*\)/g, '').trim()
}

function factValue(v: unknown): QuestionFact['value'] {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  return JSON.stringify(v)
}

/** A value and, if the feature is a ratio, also as a percentage (how it is written in the text). */
function featureFacts(feature: FeatureName, name: string, v: unknown): QuestionFact[] {
  const out: QuestionFact[] = [{ name, value: factValue(v) }]
  if (FEATURE_CATALOG[feature].unit === 'ratio' && typeof v === 'number') out.push({ name: `${name}_porcentaje`, value: round(v * 100, 1) })
  return out
}

export function nextStepFacts(step: NextStep): QuestionFact[] {
  return [
    ...featureFacts(step.feature, 'valor_actual', step.current_value),
    ...featureFacts(step.feature, 'valor_objetivo', step.target_value),
    ...step.related.flatMap((r) => [...featureFacts(r.feature, `${r.feature}_actual`, r.current_value), ...featureFacts(r.feature, `${r.feature}_objetivo`, r.target_value)]),
    // The feature name is fixed catalog text ("listas 69-B"): its figures may be cited.
    { name: 'que_cambia', value: [step.feature, ...step.related.map((r) => r.feature)].map(featureLabel).join('; ') },
    { name: 'puntaje_actual', value: step.from.score },
    { name: 'puntaje_nuevo', value: step.to.score },
    // The line before and after: the figures in "the line would go from $A to $B" come from here.
    { name: 'linea_actual', value: step.from.limit },
    { name: 'linea_nueva', value: step.to.limit },
  ]
}

/**
 * What changes in the result, in words. If the status changes: "the result would go from X to
 * Y". If the status is the same and only the line rises: "the line would go from $A to $B". The
 * engine does not propose a step that leaves both unchanged; `decide`'s clarification
 * `next_steps` (band changes from an owner answer) can, and then the score is stated, which is
 * what changes.
 */
function outcomeChange(step: NextStep): string {
  const { from, to } = step
  if (from.status !== to.status) return `el resultado pasaría de "${SUPPLIER_STATUS_TEXT[from.status]}" a "${SUPPLIER_STATUS_TEXT[to.status]}"`
  // A status that qualifies always has a line; without both figures in the facts, neither is written.
  if (from.limit !== null && to.limit !== null && to.limit > from.limit) return `la línea pasaría de ${pesos(from.limit)} a ${pesos(to.limit)}`
  if (from.score !== null && to.score !== null && to.score > from.score) return `tu puntaje pasaría de ${String(from.score)} a ${String(to.score)}, sin cambiar el resultado ("${SUPPLIER_STATUS_TEXT[to.status]}") ni la línea`
  return `el resultado seguiría en "${SUPPLIER_STATUS_TEXT[to.status]}"`
}

export function nextStepTemplate(step: NextStep): string {
  const cur = valueText(step.feature, step.current_value)
  const tgt = valueText(step.feature, step.target_value)
  const change = outcomeChange(step)
  if (step.code === 'classify_deposits') return `Si los abonos por los que te preguntamos son pagos de clientes, tus ingresos operativos mensuales pasarían de ${cur} a ${tgt} y ${change}.`
  if (step.code === 'reduce_requested_amount') return `Si pides ${tgt} en lugar de ${cur}, ${change}.`
  const related = step.related.map((r) => `${featureLabel(r.feature).toLowerCase()} en ${valueText(r.feature, r.target_value)}`)
  return `${featureLabel(step.feature)}: hoy ${cur}; con ${tgt}${related.length ? ` (y ${related.join(', ')})` : ''}, ${change}.`
}

interface Draft {
  id: string
  facts: QuestionFact[]
  template: string
  /** What the model sees of the piece, besides facts and draft. */
  context: Record<string, unknown>
}

function filterDraftResponses(
  pending: readonly Draft[],
  byId: Map<string, string>,
  texts: Map<string, string>,
): { still: Draft[]; rejected: Map<string, string[]> } {
  const still: Draft[] = []
  const rejected = new Map<string, string[]>()
  for (const d of pending) {
    const text = byId.get(d.id)
    if (text === undefined) {
      still.push(d)
      continue
    }
    const check = checkFigures(text, d.facts)
    if (check.ok) {
      texts.set(d.id, text)
    } else {
      rejected.set(d.id, check.unsupported)
      still.push(d)
    }
  }
  return { still, rejected }
}

export class Writer {
  readonly #llm: StructuredLlm | null
  readonly #limit: <T>(task: () => Promise<T>) => Promise<T>

  constructor(llm: StructuredLlm | null, limit: <T>(task: () => Promise<T>) => Promise<T> = (t) => t()) {
    this.#llm = llm
    this.#limit = limit
  }

  /** Writes a batch; returns by id the accepted text (or null → template) and the calls made. */
  async #draft(purpose: string, promptName: PromptName, varName: string, drafts: readonly Draft[]): Promise<{ texts: Map<string, string>; calls: CallRecord[]; errors: string[] }> {
    const texts = new Map<string, string>()
    const calls: CallRecord[] = []
    const errors: string[] = []
    if (this.#llm === null || drafts.length === 0) return { texts, calls, errors }
    let pending = [...drafts]
    let rejected = new Map<string, string[]>()
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const payload = pending.map((d) => ({ id: d.id, ...d.context, hechos: d.facts, borrador: d.template, ...(rejected.has(d.id) ? { cifras_rechazadas: rejected.get(d.id) } : {}) }))
      const prompt = loadPrompt(promptName, { [varName]: JSON.stringify(payload, null, 1) })
      let res: StructuredResult<z.infer<typeof Texts>>
      try {
        const llm = this.#llm
        res = await this.#limit(() =>
          llm.call({
            purpose,
            model: LIGHT_MODEL,
            system: 'Redactas mensajes cortos en español de México para dueños de PyMEs. Respondes solo con el JSON pedido.',
            document: null,
            instruction: prompt.text,
            schema: Texts,
            schemaName: 'writer_texts.v1',
            promptVersion: prompt.id,
            effort: 'low',
            maxOutputTokens: 6000,
            serverFallback: false,
          }),
        )
      } catch (err) {
        errors.push(err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err))
        break
      }
      calls.push({ purpose, model: res.model, cost_usd: res.costUsd, cache_hit: res.responseCacheHit })
      const byId = new Map(res.object.texts.map((t) => [t.id, t.text.trim()]))
      const evaluated = filterDraftResponses(pending, byId, texts)
      rejected = evaluated.rejected
      pending = evaluated.still
    }
    return { texts, calls, errors }
  }

  async questions(questions: readonly Question[]): Promise<{ questions: Question[]; calls: CallRecord[]; errors: string[] }> {
    const drafts = questions.map((q) => ({ id: q.id, facts: q.facts, template: q.text, context: { tema: q.topic, opciones: q.options.map((o) => o.label) } }))
    const { texts, calls, errors } = await this.#draft('clarification_questions', 'clarification_questions', 'questions', drafts)
    return {
      questions: questions.map((q) => {
        const text = texts.get(q.id)
        return text === undefined ? q : { ...q, text, text_source: 'writer' as const }
      }),
      calls,
      errors,
    }
  }

  /**
   * The result explanation in prose, over the `explanationDraft` facts. If the text fails the
   * figures filter twice, or there is no model, the template stays.
   */
  async explanation(draft: { facts: QuestionFact[]; template: string; context: Record<string, unknown> }): Promise<{ text: string; source: 'template' | 'writer'; calls: CallRecord[]; errors: string[] }> {
    const { texts, calls, errors } = await this.#draft('explanation', 'explain_decision', 'decision', [{ id: 'e1', ...draft }])
    const text = texts.get('e1')
    return text === undefined ? { text: draft.template, source: 'template', calls, errors } : { text, source: 'writer', calls, errors }
  }

  async nextSteps(steps: readonly NextStep[]): Promise<{ next_steps: NextStep[]; calls: CallRecord[]; errors: string[] }> {
    const drafts = steps.map((s, i) => ({
      id: `s${String(i)}`,
      facts: nextStepFacts(s),
      template: nextStepTemplate(s),
      context: { que_cambia: featureLabel(s.feature), resultado_hoy: SUPPLIER_STATUS_TEXT[s.from.status], resultado_con_el_cambio: SUPPLIER_STATUS_TEXT[s.to.status] },
    }))
    const { texts, calls, errors } = await this.#draft('next_steps', 'next_steps', 'steps', drafts)
    return { next_steps: steps.map((s, i) => ({ ...s, message: texts.get(`s${String(i)}`) ?? nextStepTemplate(s) })), calls, errors }
  }
}
