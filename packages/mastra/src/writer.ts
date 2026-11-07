/**
 * Redacción para el proveedor (docs/04 §4, docs/03 §6): Haiku pone en palabras las preguntas y los
 * `next_steps` a partir de hechos estructurados, y el filtro de cifras decide si el texto se usa.
 * Un texto que cite una cifra fuera de sus hechos se regenera una vez; si vuelve a fallar, o si
 * el modelo no está disponible, queda la plantilla del código, que siempre pasa el filtro.
 */
import { FEATURE_CATALOG, type DecisionStatus, type FeatureName, type NextStep, type Question, type QuestionFact } from '@gow/contracts'
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

/** Valor de una feature como lo lee el proveedor, según su unidad. */
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

/** Nombre de la feature para el proveedor: la descripción del catálogo sin aclaraciones con cifras. */
export function featureLabel(feature: FeatureName): string {
  return FEATURE_CATALOG[feature].description.replace(/;.*$/, '').replace(/\s*\([^)]*\d[^)]*\)/g, '').trim()
}

function factValue(v: unknown): QuestionFact['value'] {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  return JSON.stringify(v)
}

/** Un valor y, si la feature es una proporción, también como porcentaje (así se escribe en el texto). */
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
    // El nombre de la feature es texto fijo del catálogo ("listas 69-B"): sus cifras se pueden citar.
    { name: 'que_cambia', value: [step.feature, ...step.related.map((r) => r.feature)].map(featureLabel).join('; ') },
    { name: 'puntaje_actual', value: step.from.score },
    { name: 'puntaje_nuevo', value: step.to.score },
    // La línea de antes y de después (ADR 0056): las cifras de "la línea pasaría de $A a $B" salen de aquí.
    { name: 'linea_actual', value: step.from.limit },
    { name: 'linea_nueva', value: step.to.limit },
  ]
}

/**
 * Qué cambia en el resultado, en palabras (ADR 0056). Si cambia el estado: "el resultado pasaría de X a
 * Y". Si el estado es el mismo y solo sube la línea: "la línea pasaría de $A a $B". El motor no propone
 * un paso que deje las dos cosas iguales; los `next_steps` de aclaración de `decide` (cambios de banda
 * por una respuesta del dueño) sí pueden, y entonces se dice el puntaje, que es lo que cambia.
 */
function outcomeChange(step: NextStep): string {
  const { from, to } = step
  if (from.status !== to.status) return `el resultado pasaría de "${SUPPLIER_STATUS_TEXT[from.status]}" a "${SUPPLIER_STATUS_TEXT[to.status]}"`
  // Un estado que califica siempre trae línea; sin las dos cifras en los hechos no se escribe ninguna.
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
  /** Lo que el modelo ve de la pieza, además de hechos y borrador. */
  context: Record<string, unknown>
}

export class Writer {
  readonly #llm: StructuredLlm | null
  readonly #limit: <T>(task: () => Promise<T>) => Promise<T>

  constructor(llm: StructuredLlm | null, limit: <T>(task: () => Promise<T>) => Promise<T> = (t) => t()) {
    this.#llm = llm
    this.#limit = limit
  }

  /** Redacta un lote; devuelve por id el texto aceptado (o null → plantilla) y las llamadas hechas. */
  async #draft(purpose: string, promptName: string, varName: string, drafts: readonly Draft[], promptVersion = 1): Promise<{ texts: Map<string, string>; calls: CallRecord[]; errors: string[] }> {
    const texts = new Map<string, string>()
    const calls: CallRecord[] = []
    const errors: string[] = []
    if (this.#llm === null || drafts.length === 0) return { texts, calls, errors }
    let pending = [...drafts]
    let rejected = new Map<string, string[]>()
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const payload = pending.map((d) => ({ id: d.id, ...d.context, hechos: d.facts, borrador: d.template, ...(rejected.has(d.id) ? { cifras_rechazadas: rejected.get(d.id) } : {}) }))
      const prompt = loadPrompt(promptName, promptVersion, { [varName]: JSON.stringify(payload, null, 1) })
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
      rejected = new Map()
      const still: Draft[] = []
      for (const d of pending) {
        const text = byId.get(d.id)
        if (text === undefined) {
          still.push(d)
          continue
        }
        const check = checkFigures(text, d.facts)
        if (check.ok) texts.set(d.id, text)
        else {
          rejected.set(d.id, check.unsupported)
          still.push(d)
        }
      }
      pending = still
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
   * La explicación del resultado en prosa (ADR 0045), sobre los hechos de `explanationDraft`. Si el
   * texto no pasa el filtro de cifras dos veces, o no hay modelo, queda la plantilla.
   */
  async explanation(draft: { facts: QuestionFact[]; template: string; context: Record<string, unknown> }): Promise<{ text: string; source: 'template' | 'writer'; calls: CallRecord[]; errors: string[] }> {
    // v2: un nombre por dimensión, lo no evaluado por diseño aparte, tipo de titular (ADR 0045).
    const { texts, calls, errors } = await this.#draft('explanation', 'explain_decision', 'decision', [{ id: 'e1', ...draft }], 2)
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
