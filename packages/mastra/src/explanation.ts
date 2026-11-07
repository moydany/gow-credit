/**
 * Explicación del resultado en lenguaje natural (ADR 0045). El motor deja motivos con códigos y
 * nombres de features, útiles para auditar pero difíciles de leer. Aquí se arman los hechos de la
 * decisión (resultado, puntaje, cifras del flujo, compuertas, dimensiones, topes) y una plantilla
 * que siempre pasa el filtro de cifras; Haiku la redacta en prosa sobre esos mismos hechos
 * (`Writer.explanation`), y si el texto cita una cifra que no está en los hechos se queda la
 * plantilla.
 */
import { DOCUMENT_AGE_WARNING, type AccountUse, type Decision, type FeatureName, type HolderType, type MaxLine, type QuestionFact } from '@gow/contracts'
import { pesos } from './figures.ts'
import { featureLabel, valueText } from './writer.ts'

/** Para quien lee el backoffice o el reporte: el resultado en tercera persona. */
const RESULT_TEXT: Record<Decision['status'], string> = {
  qualified: 'califica',
  qualified_with_limit: 'califica con límite',
  not_qualified: 'no califica',
  needs_clarification: 'necesita aclarar datos con el proveedor',
  human_review: 'pasa a revisión de un analista',
}

const ASK_LABEL: Record<string, string> = {
  recent_statement: 'un estado de cuenta más reciente',
  identity_fields: 'el titular o el RFC de la cuenta',
  deposit_classification: 'el origen de algunos abonos',
  reconciliation_gap: 'un descuadre de saldos',
  additional_months: 'más meses de estados de cuenta',
  missing_pages: 'páginas faltantes del documento',
  charge_classification: 'qué fueron algunos cargos',
  main_buyer: 'quién es su cliente principal',
  account_use: 'si la cuenta también es personal',
}

const ACCOUNT_USE_TEXT: Record<AccountUse, string> = {
  business_only: 'solo para su negocio',
  mixed: 'para su negocio y también para gastos personales',
}

const OP_TEXT: Partial<Record<string, string>> = { '<=': 'como máximo', '<': 'menos de', '>=': 'al menos', '>': 'más de', '==': 'exactamente', '!=': 'distinto de' }

export interface ExplanationDraft {
  facts: QuestionFact[]
  template: string
  context: Record<string, unknown>
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function num(decision: Decision, f: FeatureName): number | null {
  const v = decision.profile.features[f].value
  return typeof v === 'number' ? v : null
}

function listEs(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`
}

/** Un valor de dimensión: proporción como porcentaje; razón contra otra feature, en veces. */
function dimensionValue(d: Decision['evaluation']['dimensions'][number]): string {
  if (d.value === null) return 'sin dato'
  if (d.relative_to !== null) return d.value <= 1 ? `${String(Math.round(d.value * 1000) / 10)}%` : `${String(Math.round(d.value * 100) / 100)} veces`
  return valueText(d.feature, d.value)
}

/**
 * Un solo nombre por dimensión de la política base, el mismo en la plantilla, en los hechos y en los
 * motivos que ve el redactor (ADR 0045): con dos nombres para la misma, Haiku las contaba dos veces.
 */
const DIMENSION_LABEL: Partial<Record<string, string>> = {
  'operating_income_monthly/requested_amount': 'la capacidad (ingresos frente al monto pedido)',
  'buyer_payments_count/': 'los pagos del comprador',
  'payment_capacity_pct/': 'la estabilidad (flujo libre sobre ingresos)',
  'debt_service_monthly/operating_income_monthly': 'la carga de deuda (pagos a créditos sobre ingresos)',
  'recurring_income_share/': 'los ingresos recurrentes',
}

const BUYER_FEATURES: ReadonlySet<FeatureName> = new Set(['buyer_payments_count', 'buyer_payments_amount', 'program_available_limit'])

const HOLDER_TEXT: Record<HolderType, string> = {
  individual: 'persona física',
  individual_with_business_activity: 'persona física con actividad empresarial',
  legal_entity: 'persona moral',
}

/** Régimen del CFDI del estado de cuenta (docs/09 §5), si lo trae. */
const REGIME_TEXT: Partial<Record<string, string>> = {
  '601': 'general de ley de personas morales',
  '603': 'personas morales con fines no lucrativos',
  '605': 'sueldos y salarios',
  '606': 'arrendamiento',
  '612': 'actividades empresariales y profesionales',
  '621': 'incorporación fiscal',
  '625': 'plataformas tecnológicas',
  '626': 'régimen simplificado de confianza (RESICO)',
}

export interface ExplanationContext {
  /** Tipo de titular que se leyó del estado de cuenta. */
  holderType?: HolderType | null
}

function dimensionLabel(d: Decision['evaluation']['dimensions'][number]): string {
  const known = DIMENSION_LABEL[`${d.feature}/${d.relative_to ?? ''}`]
  if (known) return known
  return d.relative_to !== null ? `${lowerFirst(featureLabel(d.feature))} frente a ${lowerFirst(featureLabel(d.relative_to))}` : lowerFirst(featureLabel(d.feature))
}

export function explanationDraft(decision: Decision, maxLine: MaxLine | null = null, ctx: ExplanationContext = {}): ExplanationDraft {
  const facts: QuestionFact[] = []
  const fact = (name: string, value: QuestionFact['value']) => {
    facts.push({ name, value })
  }
  const sentences: string[] = []
  const codes = new Set(decision.reasons.map((r) => r.code))
  const request = decision.profile.inputs.request
  const noAmount = typeof decision.profile.features.requested_amount.value !== 'number'
  const noBuyer = request?.buyer == null
  // Lo que no se evalúa por diseño (no se pidió monto o comprador) no es una falta del proveedor:
  // se dice aparte y una sola vez, no como "falta de datos" ni como causa (ADR 0045).
  const notCollected = (feature: FeatureName | null) => (feature === 'requested_amount' && noAmount) || (feature !== null && BUYER_FEATURES.has(feature) && noBuyer)
  const byDesign = (d: Decision['evaluation']['dimensions'][number]) => !d.used && (notCollected(d.relative_to) || notCollected(d.feature))

  // 1. Resultado y puntaje.
  fact('resultado', RESULT_TEXT[decision.status])
  let head = `Resultado: ${RESULT_TEXT[decision.status]}`
  if (decision.score !== null) {
    fact('puntaje', decision.score)
    fact('puntaje_maximo', 100)
    head += ` (puntaje ${String(decision.score)} de 100)`
  }
  sentences.push(`${head}.`)
  const holder = ctx.holderType ? HOLDER_TEXT[ctx.holderType] : null
  const regime = decision.profile.features.fiscal_regime.value
  const regimeText = typeof regime === 'string' && regime !== 'other' ? `régimen ${regime}${REGIME_TEXT[regime] ? `, ${REGIME_TEXT[regime] ?? ''}` : ''}` : null
  if (holder) {
    fact('tipo_de_titular', holder)
    if (regimeText) fact('regimen_fiscal', regimeText)
    sentences.push(`El titular es ${holder}${regimeText ? ` (${regimeText})` : ''}.`)
  }
  // Lo que dijo el dueño al aclarar (ADR 0050): queda dicho para quien revisa.
  const declared = decision.profile.inputs.declarations
  if (declared.account_use !== null) {
    fact('uso_de_la_cuenta', ACCOUNT_USE_TEXT[declared.account_use])
    sentences.push(
      declared.account_use === 'mixed'
        ? 'El proveedor dijo que usa la cuenta también para gastos personales: las transferencias de terceros sin señal de venta no se cuentan como ingreso y los gastos personales siguen restando del flujo.'
        : 'El proveedor dijo que usa la cuenta solo para su negocio.',
    )
  }
  if (declared.buyer !== null) {
    fact('cliente_principal_declarado', declared.buyer)
    sentences.push('La solicitud no indicaba el comprador; se tomó como comprador al cliente principal que dijo el proveedor y se buscaron sus pagos en el estado de cuenta.')
  }
  if (codes.has('evaluated_at_max_line')) {
    const amount = num(decision, 'requested_amount')
    if (amount !== null) {
      fact('linea_maxima', amount)
      sentences.push(`Como no se pidió un monto, se evaluó con la línea máxima, ${pesos(amount)}, que es el mayor monto que la política aprueba.`)
    }
  } else if (codes.has('no_amount_no_line')) {
    sentences.push('No se pidió un monto, y con ningún monto la política aprueba este perfil.')
  } else if (maxLine !== null) {
    fact('linea_maxima', maxLine.amount)
    sentences.push(`La línea máxima, si se resuelve lo pendiente, sería de ${pesos(maxLine.amount)}.`)
  }
  if (decision.limit !== null && (decision.status === 'qualified' || decision.status === 'qualified_with_limit')) {
    fact('linea', decision.limit)
    // Con monto pedido se aprueba el monto si cabe en la línea; si no, la línea (ADR 0053). El monto va
    // como hecho para que el filtro de cifras lo permita. Si se evaluó con la línea máxima, el monto del
    // perfil es esa línea, no una petición del proveedor.
    const requested = codes.has('evaluated_at_max_line') ? null : (request?.amount ?? null)
    if (requested === null) sentences.push(`La línea aprobada es de ${pesos(decision.limit)}.`)
    else {
      fact('monto_solicitado', requested)
      sentences.push(
        requested <= decision.limit + 0.005
          ? `Se aprueba el monto solicitado de ${pesos(requested)}; la línea disponible llega a ${pesos(decision.limit)}.`
          : `Se aprueba una línea de ${pesos(decision.limit)}, menor al monto solicitado de ${pesos(requested)}.`,
      )
    }
  }

  // 2. El flujo del periodo, si se conoce.
  const income = num(decision, 'operating_income_monthly')
  const expenses = num(decision, 'operating_expenses_monthly')
  const debt = num(decision, 'debt_service_monthly')
  const free = num(decision, 'free_cash_flow_monthly')
  const months = num(decision, 'months_of_history')
  const flow: string[] = []
  if (income !== null) {
    fact('ingreso_operativo_mensual', income)
    flow.push(`ingresos operativos de ${pesos(income)} al mes`)
  }
  if (expenses !== null) {
    fact('gastos_operativos_mensuales', expenses)
    flow.push(`gastos operativos de ${pesos(expenses)}`)
  }
  if (debt !== null && debt > 0) {
    fact('pagos_a_creditos_mensuales', debt)
    const share = income !== null && income > 0 ? Math.round((debt / income) * 1000) / 10 : null
    if (share !== null) fact('pagos_a_creditos_sobre_ingreso_porcentaje', share)
    flow.push(`pagos a créditos de ${pesos(debt)}${share !== null ? ` (${String(share)}% del ingreso)` : ''}`)
  }
  if (flow.length > 0) {
    let s = `En el periodo tiene ${listEs(flow)}`
    if (free !== null) {
      fact('flujo_libre_mensual', free)
      s += free < 0 ? `, así que le queda un flujo libre negativo de ${pesos(Math.abs(free))} al mes` : `, y le queda un flujo libre de ${pesos(free)} al mes`
    }
    if (months !== null) {
      fact('meses_de_historial', months)
      s += ` (con ${String(months)} ${months === 1 ? 'mes' : 'meses'} de historial)`
    }
    sentences.push(`${s}.`)
    if (ctx.holderType === 'individual' || ctx.holderType === 'individual_with_business_activity') sentences.push('Como es persona física, los gastos y créditos personales de la cuenta cuentan en ese flujo.')
  }

  // 3. Compuertas que fallaron o no se pudieron evaluar.
  const failed = decision.evaluation.gates.filter((g) => g.outcome === 'fail')
  for (const g of failed) {
    fact(`compuerta_${g.id}_valor`, typeof g.value === 'number' || typeof g.value === 'string' || typeof g.value === 'boolean' ? g.value : g.value === null ? null : JSON.stringify(g.value))
    if (typeof g.threshold === 'number') fact(`compuerta_${g.id}_umbral`, g.threshold)
    sentences.push(`No cumple un requisito: ${lowerFirst(featureLabel(g.feature))} es ${valueText(g.feature, g.value)}${g.threshold !== null && typeof g.threshold !== 'object' ? ` y la política pide ${OP_TEXT[g.op] ?? g.op} ${valueText(g.feature, g.threshold)}` : ''}.`)
  }
  const unknownGates = decision.evaluation.gates.filter((g) => g.outcome === 'unknown' && g.effect !== 'none')
  if (unknownGates.length > 0) sentences.push(`No se pudo comprobar ${listEs(unknownGates.map((g) => lowerFirst(featureLabel(g.feature))))}.`)
  // La antigüedad como advertencia del tenant (ADR 0049): no cambia el resultado, pero se dice.
  if (codes.has(DOCUMENT_AGE_WARNING)) {
    const age = num(decision, 'document_age_days')
    if (age !== null) {
      fact('dias_desde_el_corte', age)
      sentences.push(`Aviso: el estado de cuenta tiene ${String(age)} días desde su corte, más de lo que pide la configuración de la institución crediticia; se analizó igual.`)
    } else sentences.push('Aviso: no se pudo calcular la antigüedad del estado de cuenta; se analizó igual.')
  }

  // 4. Dimensiones: las que suman poco y las que no tienen dato.
  const low = decision.evaluation.dimensions.filter((d) => d.used && d.normalized !== null && d.normalized < 0.5)
  for (const d of low) {
    if (d.value !== null) fact(`dimension_${d.id}`, d.value)
    fact(`dimension_${d.id}_puntos`, Math.round(d.points * 100) / 100)
    fact(`dimension_${d.id}_peso`, d.weight)
  }
  if (low.length > 0) sentences.push(`Suman pocos puntos: ${listEs(low.map((d) => `${dimensionLabel(d)} (${dimensionValue(d)}, ${String(Math.round(d.points * 100) / 100)} de ${String(d.weight)} puntos)`))}.`)
  const missing = decision.evaluation.dimensions.filter((d) => !d.used && !byDesign(d))
  if (missing.length > 0) sentences.push(`No suman puntos por falta de datos: ${listEs(missing.map((d) => dimensionLabel(d)))}.`)
  const skipped = decision.evaluation.dimensions.filter(byDesign)
  // El monto ya se explicó arriba (línea máxima o ningún monto): aquí solo lo demás, como el comprador.
  const skippedOther = skipped.filter((d) => d.relative_to !== 'requested_amount')
  if (skippedOther.length > 0) sentences.push(`No se evaluaron ${listEs(skippedOther.map((d) => dimensionLabel(d)))}, porque la solicitud no indica a quién se facturó.`)
  // Una sola lista de dimensiones, con un nombre cada una, para que el redactor no las duplique.
  fact(
    'dimensiones',
    decision.evaluation.dimensions
      .map((d) => `${dimensionLabel(d)}: ${byDesign(d) ? 'no se evaluó (no se pidió ese dato)' : d.used ? `${String(Math.round(d.points * 100) / 100)} de ${String(d.weight)} puntos` : 'sin dato'}`)
      .join('; '),
  )

  // 5. Topes que bajaron el resultado (si no califica, no cambian nada y no se mencionan).
  const caps = decision.evaluation.caps.filter((c) => c.applied)
  if (caps.length > 0 && decision.status !== 'not_qualified') {
    const why = caps.map((c) => (notCollected(c.feature) ? 'no indicar el comprador' : lowerFirst(featureLabel(c.feature))))
    sentences.push(`Además, la política limita el resultado a "${RESULT_TEXT[caps[0]?.max_status ?? 'qualified_with_limit']}" por ${listEs(why)}.`)
  }

  // 6. Lo que falta aclarar.
  if (decision.clarification !== null) sentences.push(`Falta aclarar con el proveedor ${listEs(decision.clarification.topics.map((t) => ASK_LABEL[t] ?? t))}.`)

  // Los motivos del motor van como hecho: sus cifras se pueden citar y dan contexto al redactor. Sin
  // los de lo no evaluado por diseño, y con el mismo nombre de dimensión que la lista de arriba.
  const skippedCodes = new Set(skipped.map((d) => `dimension_${d.id}_without_data`))
  const motives = decision.reasons
    .filter((r) => !skippedCodes.has(r.code) && !(r.code.startsWith('cap_') && r.features.every((f) => notCollected(f))))
    .map((r) => decision.evaluation.dimensions.reduce((m, d) => m.replaceAll(`La dimensión "${d.id}"`, `La dimensión ${dimensionLabel(d)}`), r.message))
  fact('motivos_del_motor', motives.join(' | '))
  return {
    facts,
    template: sentences.join(' '),
    context: {
      resultado: RESULT_TEXT[decision.status],
      no_evaluado_por_diseno: skipped.map((d) => dimensionLabel(d)),
      regimen_fiscal: regimeText ?? 'no se conoce: el estado de cuenta no lo imprime',
    },
  }
}
