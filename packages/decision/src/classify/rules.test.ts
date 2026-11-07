import { describe, expect, it } from 'vitest'
import { bankTokens, classifyByRules, type RuleContext } from './rules.ts'

const ctx: RuleContext = { holderName: null, holderRfc: null, bankTokens: ['FONDEADORA'], buyer: null }

function rule(description: string, type: 'credit' | 'debit', c: Partial<RuleContext> = {}) {
  const m = classifyByRules({ description, reference: null, type, internal_transfer: false }, { ...ctx, ...c })
  return [m.rule, m.classification.category, m.classification.confidence] as const
}

describe('clasificación por reglas (rules-v1)', () => {
  // Generic phrases shaped like the dataset banks print them; no real data.
  it.each([
    ['COMISION MANEJO DE CUENTA', 'debit', 'fee_commission', 'fee'],
    ['IVA COMISION MANEJO DE CUENTA TASA IVA 16', 'debit', 'fee_vat', 'fee'],
    ['I.V.A.', 'debit', 'fee_vat', 'fee'],
    ['I V A POR COMISION MEMBRESIA', 'debit', 'fee_vat', 'fee'],
    ['COBRO IVA AFIL.-1234', 'debit', 'fee_vat', 'fee'],
    ['COM MEMBRESIA CUENTA E PYME', 'debit', 'fee_commission', 'fee'],
    ['C ADMINISTRACION RENTA', 'debit', 'fee_bank_service', 'fee'],
    ['SERV BANCA INTERNET REF. OPS', 'debit', 'fee_bank_service', 'fee'],
    ['MENSUALIDAD DE FONDEADORA NEGOCIOS', 'debit', 'fee_bank_plan', 'fee'],
    ['PAGO SERVICIO COMISION FEDERA', 'debit', 'utility_cfe', 'supplier_payment'],
    ['COM MEX SUPER COMPRA', 'debit', 'card_purchase', 'other'],
    ['INTERESES GANADOS', 'credit', 'interest_earned', 'interest'],
    ['RETENCIÓN POR ISR', 'debit', 'tax', 'tax'],
    ['PAGO REFERENCIADO SAT', 'debit', 'tax', 'tax'],
    ['SIPARE 123 C1', 'debit', 'tax', 'tax'],
    ['SPEI DEVUELTOBANCO', 'credit', 'reversal', 'other'],
    ['ABONO POR DEVOLUCIONES', 'credit', 'reversal', 'other'],
    ['TRASPASO DE INVERSION', 'credit', 'own_investment', 'own_transfer'],
    ['TRASPASO ENTRE CUENTAS PROPIAS', 'debit', 'own_account', 'own_transfer'],
    ['ACREDITACIÓN DE MONTO SOLICITADO CRÉDITOS', 'credit', 'loan_received', 'loan_disbursement'],
    ['DISPOSICION DE CREDITO FINANCIERA', 'credit', 'loan_received', 'loan_disbursement'],
    ['PAGO DE MENSUALIDAD CRÉDITOS DE LA PLATAFORMA', 'debit', 'loan_payment', 'loan_payment'],
    ['PAGO DE TARJETA: 1234 EN BPI', 'debit', 'loan_payment', 'loan_payment'],
    ['NETNM CARGO POR PAGO DE NOMINA', 'debit', 'payroll', 'payroll'],
    ['NOMINA EMPRESA', 'credit', 'salary_received', 'other'],
    ['TRA 123-ABONO VENTAS TDC', 'credit', 'sales_settlement', 'customer_payment'],
    ['LIBERACIÓN DE DINERO', 'credit', 'sales_settlement', 'customer_payment'],
    ['PAGO FACTURA B101', 'credit', 'sales_settlement', 'customer_payment'],
    ['DEPOSITO SALVO BUEN COBRO', 'credit', 'check_deposit', 'customer_payment'],
    ['EFE -DEPOSITO EN SUCURSAL', 'credit', 'cash_deposit', 'customer_payment'],
    ['T20 SPEI RECIBIDOBANCO', 'credit', 'transfer_received', 'customer_payment'],
    ['TRANSFERENCIA RECIBIDA', 'credit', 'transfer_received', 'customer_payment'],
    ['DIS.EFE.BANCO SUCURSAL', 'debit', 'cash_withdrawal', 'other'],
    ['RETIRO CAJERO AUTOMATICO', 'debit', 'cash_withdrawal', 'other'],
    ['CONSUMO LOCAL AJENO TERMINACION 1234', 'debit', 'card_purchase', 'other'],
    ['PAGO A PROVEEDOR GENERAL', 'debit', 'supplier_named', 'supplier_payment'],
    ['N06 PAGO CUENTA DE TERCERO', 'debit', 'transfer_sent', 'supplier_payment'],
    ['TRANSFERENCIA SPEI A PROVEE', 'debit', 'transfer_sent', 'supplier_payment'],
    ['B123 45', 'credit', 'unrecognized', 'customer_payment'],
    ['AEROLINEA BOLETOS', 'debit', 'unrecognized', 'other'],
  ] as const)('%s (%s) → %s', (description, type, expectedRule, category) => {
    const [r, cat] = rule(description, type)
    expect(r).toBe(expectedRule)
    expect(cat).toBe(category)
  })

  it('la mensualidad de un crédito no es comisión aunque mencione al banco', () => {
    expect(rule('PAGO DE MENSUALIDAD CREDITOS DE FONDEADORA', 'debit')[1]).toBe('loan_payment')
  })

  it('un abono sin nada reconocible queda bajo el umbral de 0.7', () => {
    expect(rule('OPERACION 99', 'credit')[2]).toBe(0.5)
    expect(rule('DEPOSITO EN EFECTIVO', 'credit')[2]).toBe(0.6)
  })

  it('reconoce al comprador por nombre o por RFC impreso', () => {
    const buyer = { name: 'Cadena Norte SA de CV', rfc: 'CNO850101AB1', aliases: ['Tiendas Norte'] }
    expect(rule('SPEI RECIBIDO CADENA NORTE SA DE CV REF 9', 'credit', { buyer })[0]).toBe('buyer_name')
    expect(rule('ABONO TRANSFERENCIA TIENDAS NORTE', 'credit', { buyer })[0]).toBe('buyer_name')
    expect(rule('ABONO TRANSFERENCIA SPEI RFC CNO850101AB1 REF 7', 'credit', { buyer })).toEqual(['buyer_rfc', 'customer_payment', 0.98])
    // A charge is never a buyer payment, even if it mentions them.
    expect(rule('PAGO A PROVEEDOR CADENA NORTE', 'debit', { buyer })[0]).toBe('supplier_named')
  })

  it('un traspaso con el nombre o el RFC del titular es propio', () => {
    expect(rule('SPEI RECIBIDO COMERCIALIZADORA DEL VALLE SA DE CV', 'credit', { holderName: 'Comercializadora del Valle SA de CV' })[1]).toBe('own_transfer')
    expect(rule('TRANSFERENCIA A CUENTA XAXA850101AB1', 'debit', { holderRfc: 'XAXA850101AB1' })[1]).toBe('own_transfer')
  })

  it('lee el RFC de la contraparte de la descripción', () => {
    const m = classifyByRules({ description: 'ABONO TRANSFERENCIA SPEI DE COMERCIAL NORTE SA RFC CNO850101AB1 REF 123', reference: null, type: 'credit', internal_transfer: false }, ctx)
    expect(m.classification.counterparty_rfc).toBe('CNO850101AB1')
  })

  it('un traspaso interno marcado en la extracción es propio', () => {
    const m = classifyByRules({ description: 'DEPÓSITO EN CAJITA', reference: null, type: 'debit', internal_transfer: true }, ctx)
    expect([m.rule, m.classification.category]).toEqual(['internal_transfer', 'own_transfer'])
  })

  it('las palabras del banco no incluyen genéricas', () => {
    expect(bankTokens('Mercado Pago', 'mercado_pago')).toEqual(['MERCADO'])
    expect(bankTokens('Banco Ficticio SA', null)).toEqual(['FICTICIO'])
  })
})
