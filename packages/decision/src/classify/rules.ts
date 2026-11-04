/**
 * Clasificación de movimientos por reglas (ADR 0013). Es el respaldo determinístico y gratis
 * del paso `classifyTransactions` de docs/02 4c (Jev, con Haiku de respaldo), que corre en el
 * workflow de la fase 5: aquí solo se clasifica lo que llegue sin clasificar.
 *
 * Las reglas leen la descripción como la imprime el banco. La confianza no es una
 * probabilidad calibrada: es el grado de certeza de la regla, fijado a mano:
 *
 * - 0.95: palabra técnica inequívoca (COMISION, IVA de comisión, ISR retenido, intereses).
 * - 0.85 a 0.9: concepto típico (ABONO VENTAS, PAGO DE NOMINA, PAGO DE TARJETA, SAT).
 * - 0.75: transferencia recibida de un tercero: se presume pago de cliente.
 * - 0.6: efectivo y cargos genéricos: bajo el umbral de 0.7, así que un abono así no cuenta
 *   como ingreso y, si es grande, se pregunta al dueño (docs/03 §7).
 * - 0.5: nada reconocible.
 *
 * Toda regla nueva o cambiada sube `RULES_VERSION` y va con su caso en `rules.test.ts`.
 */
import { findCounterpartyRfc, type TransactionCategory, type TransactionClassification } from '@gow/contracts'
import { mentionsName, nameTokens, normalizeText } from '../util/text.ts'

export const RULES_VERSION = 'rules-v1'

export interface RuleContext {
  /** Nombre del titular (encabezado); null si viene redactado. */
  holderName: string | null
  holderRfc: string | null
  /** Palabras del nombre del banco, para reconocer su propia mensualidad ("MENSUALIDAD DE FONDEADORA"). */
  bankTokens: readonly string[]
  buyer: { name: string; rfc: string | null; aliases: readonly string[] } | null
}

export interface RuleInput {
  description: string
  reference: string | null
  type: 'credit' | 'debit'
  internal_transfer: boolean
}

export interface RuleMatch {
  rule: string
  classification: TransactionClassification
  /** Cómo se reconoció al comprador de la solicitud, si es un pago suyo. */
  buyerMatch: 'rfc' | 'name' | null
}

type Side = 'credit' | 'debit' | 'both'

interface Rule {
  id: string
  side: Side
  test: RegExp
  category: TransactionCategory
  confidence: number
}

/**
 * Orden = prioridad: gana la primera que aplica. Las descripciones llegan normalizadas
 * (mayúsculas, sin acentos, sin puntuación), así que "Comisión" es COMISION e "I.V.A." es I V A.
 */
const RULES: readonly Rule[] = [
  // CFE se llama "Comisión Federal de Electricidad" (a veces cortado: "COMISION FEDERA"): no es comisión bancaria.
  { id: 'utility_cfe', side: 'debit', test: /\bCOMISION FEDERA|\bCFE\b/, category: 'supplier_payment', confidence: 0.85 },
  { id: 'fee_vat', side: 'debit', test: /^(I V A|IVA)( \d+)*$|\bIVA\b.*\bCOM|\bI V A\b.*\bCOMISION|\bCOBRO IVA\b/, category: 'fee', confidence: 0.95 },
  { id: 'fee_commission', side: 'debit', test: /\bCOMISION(ES)?\b|\bCOM (OPER|MEMBRES|MANEJO|ADMIN|ANUAL|SERV|TRANSF|SPEI|DISP|RETIRO|CHEQ|SALDO|POR)\w*/, category: 'fee', confidence: 0.95 },
  {
    id: 'fee_bank_service',
    side: 'debit',
    test: /\bMEMBRESIA\b|\bANUALIDAD\b|\bSERV(ICIO)? BANCA\b|\bCOBRO POR TASA DE DESCUENTO\b|^C ADMINISTRACION\b|\bMANEJO DE CUENTA\b|\bCUOTA (MENSUAL|ANUAL|DE MANEJO)\b/,
    category: 'fee',
    confidence: 0.9,
  },
  { id: 'interest_earned', side: 'credit', test: /\bINTERES(ES)?\b|\bRENDIMIENTOS?\b/, category: 'interest', confidence: 0.95 },
  { id: 'interest_charged', side: 'debit', test: /\bINTERES(ES)?\b/, category: 'interest', confidence: 0.85 },
  {
    id: 'tax',
    side: 'debit',
    test: /\bISR\b|\bRETENCION\b|\bIMPUESTOS?\b|\bSAT\b|\bSIPARE\b|\bIMSS\b|\bINFONAVIT\b|\bLINEA DE CAPTURA\b|\bPAGO REFERENCIADO\b|\bTESORERIA\b|\bPREDIAL\b|\bTENENCIA\b/,
    category: 'tax',
    confidence: 0.9,
  },
  // Sin \b al final: algunos bancos pegan la palabra siguiente ("SPEI DEVUELTOBANCO...").
  { id: 'reversal', side: 'credit', test: /\bDEVUELT[OA]|\bDEVOLUCION|\bREEMBOLSO|\bREVERSO|\bCANCELACION|\bBONIFICACION|\bCONTRACARGO/, category: 'other', confidence: 0.9 },
  { id: 'own_account', side: 'both', test: /\bCUENTAS? PROPIAS?\b|\bENTRE CUENTAS\b|\bMIS CUENTAS\b|\bCAJITA\b|\bAPARTADO\b|\bDINERO RESERVADO\b/, category: 'own_transfer', confidence: 0.9 },
  { id: 'own_investment', side: 'both', test: /\bINVERSION(ES)?\b/, category: 'own_transfer', confidence: 0.85 },
  {
    id: 'loan_received',
    side: 'credit',
    test: /\bPRESTAMO\b|\bFINANCIAMIENTO\b|\bDISPOSICION DE (LINEA|CREDITO)\b|\bCREDITOS?\b.*\b(ACREDITACION|DISPOSICION|MONTO SOLICITADO)\b|\b(ACREDITACION|DISPOSICION|MONTO SOLICITADO)\b.*\bCREDITOS?\b/,
    category: 'loan_disbursement',
    confidence: 0.85,
  },
  {
    id: 'loan_payment',
    side: 'debit',
    test: /\bPAGO (DE |A )?(TARJETA|TDC|CREDITO|PRESTAMO)\b|\bAMORTIZACION\b|\bPAGO DE MENSUALIDAD\b|\bMENSUALIDAD\b.*\bCREDITOS?\b|\bCREDITOS?\b.*\bMENSUALIDAD\b/,
    category: 'loan_payment',
    confidence: 0.85,
  },
  { id: 'payroll', side: 'debit', test: /\bNOMINA\b|\bDISPERSION\b|\bSUELDOS?\b|\bSALARIOS?\b/, category: 'payroll', confidence: 0.9 },
  // Nómina recibida: ingreso de una persona, no pago de un cliente del negocio.
  { id: 'salary_received', side: 'credit', test: /\bNOMINA\b|\bSUELDOS?\b/, category: 'other', confidence: 0.8 },
  { id: 'sales_settlement', side: 'credit', test: /\bVENTAS?\b|\bLIBERACION DE DINERO\b|\bTPV\b|\bAFILIACION\b|\bFACT(URAS?)?\b|\bF\d{3,}\b|\bANTICIPO\b/, category: 'customer_payment', confidence: 0.85 },
  { id: 'check_deposit', side: 'credit', test: /\bSALVO BUEN COBRO\b|\bCHEQUE\b/, category: 'customer_payment', confidence: 0.75 },
  { id: 'cash_deposit', side: 'credit', test: /\bEFECTIVO\b|\bEFE\b|\bDEPOSITO EN (SUCURSAL|VENTANILLA|PUNTO|TIENDA|OXXO)\b/, category: 'customer_payment', confidence: 0.6 },
  {
    id: 'transfer_received',
    side: 'credit',
    test: /\bSPEI\b|\bTRANSFERENCIA\b|\bTRANSF\b|\bABONO\b|\bDEPOSITO\b|\bPAGO RECIBIDO\b|\bRECIBID[OA]\b|\bTEF\b|\bINTERBANCARI[OA]\b|\bTRASPASO\b/,
    category: 'customer_payment',
    confidence: 0.75,
  },
  { id: 'cash_withdrawal', side: 'debit', test: /\bRETIRO\b|\bCAJERO\b|\bATM\b|\bDISP(OSICION)? (ATM|EFE|EFECTIVO)\b|\bDIS EFE\b/, category: 'other', confidence: 0.85 },
  { id: 'card_purchase', side: 'debit', test: /\bCOMPRA\b|\bCONSUMO\b|\bPOS\b/, category: 'other', confidence: 0.7 },
  { id: 'supplier_named', side: 'debit', test: /\bPROVEEDOR(ES)?\b|\bACREEDOR(ES)?\b/, category: 'supplier_payment', confidence: 0.75 },
  {
    id: 'transfer_sent',
    side: 'debit',
    test: /\bSPEI\b|\bTRANSFERENCIA\b|\bTRANSF\b|\bTRASPASO\b|\bTERCEROS?\b|\bINTERBANCARIO\b|\bENVIAD[OA]\b|\bDOMICILIACION\b|\bPAGO DE SERVICIO\b|\bRECIBO\b|\bCGO\b|\bCARGO\b/,
    category: 'supplier_payment',
    confidence: 0.6,
  },
]

function sideMatches(side: Side, type: RuleInput['type']): boolean {
  return side === 'both' || side === type
}

function classification(category: TransactionCategory, confidence: number, counterparty: string | null, counterpartyRfc: string | null): TransactionClassification {
  return { category, confidence, counterparty, counterparty_rfc: counterpartyRfc, classifier: RULES_VERSION }
}

function normalizeRfc(rfc: string | null): string | null {
  return rfc === null ? null : rfc.replace(/[\s-]/g, '').toUpperCase()
}

/** ¿Este abono es del comprador de la solicitud? Primero por RFC impreso, luego por nombre o alias. */
export function buyerMatch(text: string, counterpartyRfc: string | null, buyer: RuleContext['buyer']): 'rfc' | 'name' | null {
  if (buyer === null) return null
  const buyerRfc = normalizeRfc(buyer.rfc)
  if (buyerRfc !== null && counterpartyRfc !== null && buyerRfc === counterpartyRfc) return 'rfc'
  if ([buyer.name, ...buyer.aliases].some((n) => mentionsName(text, n))) return 'name'
  return null
}

/** Clasifica un movimiento con las reglas. Nunca falla: lo irreconocible queda con confianza 0.5. */
export function classifyByRules(t: RuleInput, ctx: RuleContext): RuleMatch {
  const raw = [t.description, t.reference ?? ''].join(' ')
  const text = normalizeText(raw)
  const counterpartyRfc = findCounterpartyRfc(raw, ctx.holderRfc)

  if (t.internal_transfer) return { rule: 'internal_transfer', classification: classification('own_transfer', 0.95, null, null), buyerMatch: null }

  // Rendimientos e intereses de abono no los paga un comprador; todo lo demás puede ser suyo.
  const buyer = t.type === 'credit' ? buyerMatch(text, counterpartyRfc, ctx.buyer) : null
  if (buyer !== null && ctx.buyer !== null) {
    return { rule: `buyer_${buyer}`, classification: classification('customer_payment', buyer === 'rfc' ? 0.98 : 0.95, ctx.buyer.name, counterpartyRfc), buyerMatch: buyer }
  }

  const holderRfc = normalizeRfc(ctx.holderRfc)
  if (holderRfc !== null && raw.toUpperCase().replace(/\s/g, '').includes(holderRfc)) {
    return { rule: 'own_rfc', classification: classification('own_transfer', 0.9, null, null), buyerMatch: null }
  }
  if (ctx.holderName !== null && nameTokens(ctx.holderName).length >= 2 && mentionsName(text, ctx.holderName)) {
    return { rule: 'own_name', classification: classification('own_transfer', 0.8, null, null), buyerMatch: null }
  }

  // La mensualidad del propio banco es comisión; la de un crédito es pago de deuda.
  if (t.type === 'debit' && /\bMENSUALIDAD\b/.test(text) && !/\bCREDITOS?\b/.test(text) && ctx.bankTokens.some((b) => new RegExp(`\\b${b}\\b`).test(text))) {
    return { rule: 'fee_bank_plan', classification: classification('fee', 0.85, null, counterpartyRfc), buyerMatch: null }
  }

  for (const r of RULES) {
    if (sideMatches(r.side, t.type) && r.test.test(text)) {
      return { rule: r.id, classification: classification(r.category, r.confidence, null, counterpartyRfc), buyerMatch: null }
    }
  }
  return {
    rule: 'unrecognized',
    classification: classification(t.type === 'credit' ? 'customer_payment' : 'other', 0.5, null, counterpartyRfc),
    buyerMatch: null,
  }
}

/** Palabras distintivas del nombre del banco ("Fondeadora" → FONDEADORA; "BANCO" o "PAGO" no distinguen). */
export function bankTokens(...names: (string | null | undefined)[]): string[] {
  const generic = new Set(['BANCO', 'BANK', 'GRUPO', 'FINANCIERO', 'INSTITUCION', 'BANCA', 'MULTIPLE', 'MEXICO', 'NEGOCIOS', 'SOCIEDAD', 'ANONIMA', 'PAGO', 'PAGOS', 'CUENTA'])
  const out = new Set<string>()
  for (const n of names) {
    if (!n) continue
    for (const t of normalizeText(n.replace(/_/g, ' ')).split(' ')) if (t.length >= 4 && !generic.has(t)) out.add(t)
  }
  return [...out]
}
