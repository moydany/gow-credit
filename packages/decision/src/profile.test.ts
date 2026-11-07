import { emptyExternalSnapshot, Profile, type ApplicationRequest, type DocumentFlag, type ExternalSnapshot, type Issue, type StatementExtraction, type SupplierIdentity, type SyntheticStatement } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { periodWindows } from './ledger.ts'
import { buildProfile, buildProfileWithLedger } from './profile.ts'
import { syntheticStatement } from './testing/synthetic.ts'

type Spec = Omit<z.input<typeof SyntheticStatement>, 'start' | 'opening_balance'> & { start?: string; opening_balance?: number }

const holder = { name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabe: null }
const AT = '2026-10-05T12:00:00.000Z'

function stmt(spec: Spec, seed = 's1'): StatementExtraction {
  return syntheticStatement({ start: '2026-09-01', opening_balance: 50000, ...spec }, holder, seed)
}

const BASIC: Spec['monthly'] = [
  { kind: 'customer_payment', amount: 120000, count: 4, counterparty: 'Cadena Norte SA de CV' },
  { kind: 'customer_payment', amount: 80000, count: 4 },
  { kind: 'supplier_payment', amount: 90000, count: 3 },
  { kind: 'payroll', amount: 40000, count: 2 },
  { kind: 'fee', amount: 580 },
  { kind: 'loan_payment', amount: 10000 },
]

interface Opts {
  request?: ApplicationRequest | null
  supplier?: SupplierIdentity | null
  external?: ExternalSnapshot
  at?: string
}

function profileOf(statements: StatementExtraction[], o: Opts = {}): Profile {
  return buildProfile({ statements, request: o.request ?? null, supplier: o.supplier ?? null, ...(o.external ? { external: o.external } : {}), computedAt: o.at ?? AT })
}

const f = (p: Profile, name: keyof Profile['features']) => p.features[name]

describe('perfil desde un estado de cuenta', () => {
  it('flujo mensual de un mes: ingresos, gastos, deuda, flujo libre y capacidad', () => {
    const p = profileOf([stmt({ monthly: BASIC })])
    expect(Profile.safeParse(p).success).toBe(true)
    expect(f(p, 'months_of_history').value).toBe(1)
    // 30 days of September = 0.9856 months: averages are per 30.44-day month.
    const months = 30 / 30.4375
    expect(f(p, 'operating_income_monthly').value).toBeCloseTo(200000 / months, 1)
    expect(f(p, 'operating_expenses_monthly').value).toBeCloseTo((90000 + 40000 + 580) / months, 1)
    expect(f(p, 'debt_service_monthly').value).toBeCloseTo(10000 / months, 1)
    expect(f(p, 'free_cash_flow_monthly').value).toBeCloseTo((200000 - 130580 - 10000) / months, 1)
    expect(f(p, 'payment_capacity_pct').value).toBeCloseTo(59420 / 200000, 3)
    expect(f(p, 'debt_capacity').value).toBeCloseTo((3 * 59420) / months, 0)
    expect(f(p, 'integrity_ok').value).toBe(true)
    expect(f(p, 'red_flags').value).toEqual([])
    expect(f(p, 'activity_count').value).toBe(15)
    expect(f(p, 'income_trend').value).toBeNull()
    expect(f(p, 'document_age_days').value).toBe(5)
  })

  it('clasificación por reglas: la confianza de los ingresos es la media de los abonos que cuentan', () => {
    const p = profileOf([stmt({ monthly: BASIC })])
    expect(f(p, 'operating_income_monthly').confidence).toBe(0.75)
    expect(f(p, 'operating_income_monthly').note).toContain('clasificados por reglas')
    expect(f(p, 'operating_expenses_monthly').confidence).toBe(1)
  })

  it('ADR 0072: con tres meses se evalúa solo el último, venga en un periodo impreso o en tres mensuales', () => {
    const spec: Spec = { months: 3, monthly: BASIC }
    const single = profileOf([stmt({ ...spec, periods: 'single' })])
    const monthly = profileOf([stmt({ ...spec, periods: 'monthly' })])
    const lastMonth = profileOf([stmt({ start: '2026-11-01', monthly: BASIC })])
    expect(f(single, 'months_of_history').value).toBe(1)
    expect(f(single, 'operating_income_monthly').value).toBeCloseTo(f(lastMonth, 'operating_income_monthly').value as number, 2)
    expect(f(single, 'activity_count').value).toBe(f(lastMonth, 'activity_count').value)
    for (const name of ['months_of_history', 'operating_income_monthly', 'operating_expenses_monthly', 'debt_service_monthly', 'free_cash_flow_monthly', 'avg_daily_balance', 'income_trend'] as const) {
      expect(f(single, name).value, name).toEqual(f(monthly, name).value)
    }
  })

  it('ADR 0072: con un solo mes evaluado no hay tendencia de ingresos, aunque lleguen tres', () => {
    const growing = profileOf([stmt({ months: 3, growth: 0.1, monthly: [{ kind: 'customer_payment', amount: 100000, count: 2 }] })], { at: '2026-12-05T12:00:00.000Z' })
    expect(f(growing, 'income_trend').value).toBeNull()
    expect(f(growing, 'months_of_history').value).toBe(1)
  })

  it('ADR 0072: periodWindows dice qué se evaluó, qué se recortó y qué quedó fuera', () => {
    const single = stmt({ months: 3, periods: 'single', monthly: BASIC }, 'pw1')
    const one = periodWindows([single], 1)
    expect(one.periods).toMatchObject([{ status: 'cut', start: '2026-11-01', end: '2026-11-30' }])
    expect([one.start, one.end]).toEqual(['2026-11-01', '2026-11-30'])
    expect(periodWindows([single], 3).periods.map((p) => p.status)).toEqual(['evaluated'])
    const monthly = periodWindows([stmt({ months: 3, monthly: BASIC }, 'pw2')], 1)
    expect(monthly.periods.map((p) => p.status)).toEqual(['outside', 'outside', 'evaluated'])
  })

  it('ADR 0072: de varios documentos entra el del mes más reciente; los anteriores quedan en la nota', () => {
    const old = stmt({ start: '2026-08-01', monthly: BASIC }, 'old')
    const recent = stmt({ start: '2026-09-01', monthly: [{ kind: 'customer_payment', amount: 50000, count: 2 }] }, 'recent')
    const { profile, ledger } = buildProfileWithLedger({ statements: [old, recent], request: null, supplier: null, computedAt: AT })
    expect(ledger.documents.map((d) => d.sha256)).toEqual([recent.document.sha256])
    expect(ledger.submitted).toHaveLength(2)
    expect(ledger.skipped.some((s) => s.includes('fuera del mes evaluado'))).toBe(true)
    expect(f(profile, 'activity_count').value).toBe(2)
  })

  it('los traspasos internos no son ingreso ni gasto', () => {
    const base = stmt({ monthly: BASIC })
    const withInternal = structuredClone(base)
    const period = withInternal.accounts[0]?.periods[0]
    if (!period) throw new Error('sin periodo')
    const t0 = period.transactions[0]
    if (!t0) throw new Error('sin movimientos')
    period.transactions.push(
      { ...t0, id: 'a1.p1.t9001', description: 'RETIRO DE CAJITA', amount: 30000, type: 'credit', internal_transfer: true },
      { ...t0, id: 'a1.p1.t9002', description: 'DEPÓSITO EN CAJITA', amount: 30000, type: 'debit', internal_transfer: true },
    )
    const a = profileOf([base])
    const b = profileOf([withInternal])
    for (const name of ['operating_income_monthly', 'operating_expenses_monthly', 'free_cash_flow_monthly', 'activity_count'] as const) expect(f(b, name).value, name).toEqual(f(a, name).value)
  })

  it('docs/04 §5: un abono no verificado no suma y, si es material, la feature queda no verificada', () => {
    const p = profileOf([stmt({ monthly: [...BASIC, { kind: 'customer_payment', amount: 50000, verification: 'unverified' }] })])
    const clean = profileOf([stmt({ monthly: BASIC })])
    expect(f(p, 'operating_income_monthly').value).toBe(f(clean, 'operating_income_monthly').value)
    expect(f(p, 'operating_income_monthly').verification).toBe('unverified')
  })

  it('abonos inciertos (efectivo, sin descripción) no cuentan como ingreso operativo', () => {
    const p = profileOf([stmt({ monthly: [{ kind: 'customer_payment', amount: 100000 }, { kind: 'cash_deposit', amount: 40000 }, { kind: 'unclassified_credit', amount: 30000 }] })])
    expect(f(p, 'operating_income_monthly').value).toBeCloseTo(100000 / (30 / 30.4375), 1)
  })

  it('préstamos recibidos van a deuda nueva, no a ingresos', () => {
    const p = profileOf([stmt({ monthly: [...BASIC, { kind: 'loan_disbursement', amount: 70000 }] })])
    expect(f(p, 'new_debt_in_period').value).toBe(70000)
    expect(f(p, 'external_debt_signal').value).toBe(80000)
    expect(f(p, 'operating_income_monthly').value).toBe(f(profileOf([stmt({ monthly: BASIC })]), 'operating_income_monthly').value)
  })

  it('saldo diario promedio y días bajo el umbral', () => {
    const p = profileOf([stmt({ opening_balance: 500, monthly: [{ kind: 'customer_payment', amount: 10000 }] })])
    // 500 until day 15 (14 days under 1,000), 10,500 from the 16th to the 30th.
    expect(f(p, 'low_balance_days').value).toBe(15)
    expect(f(p, 'avg_daily_balance').value).toBeCloseTo((500 * 15 + 10500 * 15) / 30, 2)
  })

  it('banderas rojas: embargo en la descripción y saldo negativo', () => {
    const p = profileOf([stmt({ opening_balance: 100, monthly: [{ kind: 'supplier_payment', amount: 5000, description: 'CARGO EMBARGO ORDEN JUDICIAL 123' }, { kind: 'customer_payment', amount: 9000 }] })])
    expect(f(p, 'red_flags').value).toEqual(['garnishment', 'judicial_order', 'overdraft'])
  })

  it('un documento repetido entra una vez; uno que el clasificador no llamó estado de cuenta entra con aviso', () => {
    const s = stmt({ monthly: BASIC })
    const invoice: StatementExtraction = { ...stmt({ monthly: BASIC }, 's2'), classification: { document_type: 'invoice', confidence: 0.9, bank: null } }
    const failed: StatementExtraction = { ...stmt({ monthly: BASIC }, 's3'), extraction: { ...stmt({ monthly: BASIC }, 's3').extraction, status: 'failed' } }
    const { profile, ledger } = buildProfileWithLedger({ statements: [s, s, invoice, failed], request: null, supplier: null, computedAt: AT })
    expect(profile.inputs.document_sha256).toEqual([s.document.sha256, invoice.document.sha256])
    expect(ledger.skipped).toHaveLength(3)
    expect(ledger.skipped.some((n) => n.includes('clasificado como invoice: entra al perfil'))).toBe(true)
    expect(ledger.skipped.some((n) => n.includes('sin extracción'))).toBe(true)
  })

  it('sin estados de cuenta utilizables todo lo del estado es desconocido', () => {
    const p = profileOf([])
    expect(f(p, 'months_of_history').value).toBeNull()
    expect(f(p, 'operating_income_monthly').value).toBeNull()
  })
})

describe('comprador y pagadores', () => {
  const buyer = { name: 'Cadena Norte SA de CV', rfc: null, aliases: [] }

  it('cuenta los pagos del comprador por nombre', () => {
    const p = profileOf([stmt({ monthly: BASIC })], { request: { amount: 50000, maturity: null, buyer } })
    expect(f(p, 'buyer_payments_count').value).toBe(4)
    expect(f(p, 'buyer_payments_amount').value).toBe(120000)
    expect(f(p, 'buyer_payments_count').confidence).toBe(0.9)
  })

  it('sin comprador en la solicitud es desconocido; con comprador que no aparece es cero', () => {
    expect(f(profileOf([stmt({ monthly: BASIC })]), 'buyer_payments_count').value).toBeNull()
    const other = profileOf([stmt({ monthly: BASIC })], { request: { amount: 50000, maturity: null, buyer: { name: 'Tiendas del Sur', rfc: null, aliases: [] } } })
    expect(f(other, 'buyer_payments_count').value).toBe(0)
  })

  it('concentración y recurrencia necesitan pagadores identificados', () => {
    const anonymous = profileOf([stmt({ monthly: [{ kind: 'customer_payment', amount: 100000, count: 4 }] })])
    expect(f(anonymous, 'top_payer_concentration').value).toBeNull()
    const named = profileOf([
      stmt({
        monthly: [
          { kind: 'customer_payment', amount: 60000, count: 3, counterparty: 'Cliente Uno', counterparty_rfc: 'CUN850101AB1' },
          { kind: 'customer_payment', amount: 40000, count: 1, counterparty: 'Cliente Dos', counterparty_rfc: 'CDO850101AB2' },
        ],
      }),
    ])
    expect(f(named, 'top_payer_concentration').value).toBe(0.6)
    expect(f(named, 'recurring_income_share').value).toBe(0.6)
  })
})

describe('bloque fiscal (docs/09 §9)', () => {
  const fiscal = { uuid: 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', regime: '601 General de Ley Personas Morales' }

  it('ancla: las comisiones del estado cuadran con el CFDI firmado por el SAT', () => {
    expect(f(profileOf([stmt({ monthly: BASIC, fiscal })]), 'fiscal_anchor_ok').value).toBe(true)
    expect(f(profileOf([stmt({ monthly: BASIC, fiscal: { ...fiscal, fees_match: false } })]), 'fiscal_anchor_ok').value).toBe(false)
    expect(f(profileOf([stmt({ monthly: BASIC })]), 'fiscal_anchor_ok').value).toBeNull()
  })

  it('régimen fiscal: la clave al inicio del texto; fuera del catálogo es other', () => {
    expect(f(profileOf([stmt({ monthly: BASIC, fiscal })]), 'fiscal_regime').value).toBe('601')
    expect(f(profileOf([stmt({ monthly: BASIC, fiscal: { ...fiscal, regime: '999 Inventado' } })]), 'fiscal_regime').value).toBe('other')
  })

  it('CFDI al RFC genérico: el régimen impreso no es del titular, así que queda desconocido', () => {
    for (const receiver_rfc of ['XAXX010101000', 'XEXX010101000']) {
      const p = profileOf([stmt({ monthly: BASIC, fiscal: { ...fiscal, regime: '616 Sin obligaciones fiscales', receiver_rfc } })])
      expect(f(p, 'fiscal_regime')).toMatchObject({ value: null, verification: 'unverified', note: 'el CFDI va al RFC genérico; el régimen impreso no es del titular' })
      expect(f(p, 'regime_income_plausible')).toMatchObject({ value: null, note: 'el CFDI va al RFC genérico; el régimen impreso no es del titular' })
      expect(Profile.safeParse(p).success).toBe(true)
    }
  })

  it('CFDI sin RFC receptor impreso: el régimen no se puede atribuir al titular (el BBVA imprime 616 sin RFC)', () => {
    const p = profileOf([stmt({ monthly: BASIC, holder_redacted: true, fiscal: { ...fiscal, regime: '616 Sin obligaciones fiscales' } })])
    expect(f(p, 'fiscal_regime')).toMatchObject({ value: null, verification: 'unverified', note: 'el CFDI no trae RFC receptor; el régimen impreso no se puede atribuir al titular' })
    expect(f(p, 'regime_income_plausible').value).toBeNull()
    expect(Profile.safeParse(p).success).toBe(true)
  })

  it('un régimen con tope en un CFDI genérico no cuenta: el tope de RESICO no se aplica al titular', () => {
    const big = profileOf([stmt({ monthly: [{ kind: 'customer_payment', amount: 400000, count: 4 }], fiscal: { ...fiscal, regime: '626', receiver_rfc: 'XAXX010101000' } })])
    expect([f(big, 'fiscal_regime').value, f(big, 'regime_income_plausible').value]).toEqual([null, null])
  })

  it('con otro CFDI que sí va al titular, ese régimen es el que vale', () => {
    const generic = stmt({ monthly: BASIC, fiscal: { ...fiscal, regime: '616 Sin obligaciones fiscales', receiver_rfc: 'XAXX010101000' } }, 's1')
    const own = stmt({ start: '2026-10-01', monthly: BASIC, fiscal: { ...fiscal, uuid: 'B1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B' } }, 's2')
    expect(f(profileOf([generic, own]), 'fiscal_regime')).toMatchObject({ value: '601', verification: 'verified', note: null })
  })

  it('RESICO: ingresos anualizados sobre 3.5 millones no son plausibles', () => {
    const big = profileOf([stmt({ monthly: [{ kind: 'customer_payment', amount: 400000, count: 4 }], fiscal: { ...fiscal, regime: '626' } })])
    expect(f(big, 'regime_income_plausible').value).toBe(false)
    const small = profileOf([stmt({ monthly: [{ kind: 'customer_payment', amount: 200000, count: 4 }], fiscal: { ...fiscal, regime: '626' } })])
    expect(f(small, 'regime_income_plausible').value).toBe(true)
  })

  it('la fecha de timbrado manda si es anterior al corte impreso (corte editado)', () => {
    const s = stmt({ monthly: BASIC, fiscal: { ...fiscal, certified_days_after_end: 2 } })
    const period = s.accounts[0]?.periods[0]
    if (!period) throw new Error('sin periodo')
    period.statement_date = { ...period.statement_date, value: '2026-10-04' }
    // Cutoff "edited" to October 4; the SAT stamped on October 2.
    expect(f(profileOf([s]), 'document_age_days').value).toBe(3)
  })
})

describe('identidad (docs/03 §3, docs/09 §4.6)', () => {
  const supplier: SupplierIdentity = { legal_name: 'Distribuidora Ficticia SA de CV', rfc: 'DFI150304AB1', clabes: [] }

  it('coincide por RFC y nombre', () => {
    expect(f(profileOf([stmt({ monthly: BASIC })], { supplier }), 'identity_match').value).toBe('match')
  })

  it('con encabezado redactado usa el RFC del receptor del CFDI', () => {
    const s = stmt({ monthly: BASIC, holder_redacted: true, fiscal: { uuid: 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', regime: '601', receiver_rfc: 'DFI150304AB1' } })
    expect(f(profileOf([s], { supplier }), 'identity_match').value).toBe('match')
  })

  it('redactado y sin CFDI es desconocido; otro RFC es mismatch', () => {
    expect(f(profileOf([stmt({ monthly: BASIC, holder_redacted: true })], { supplier }), 'identity_match').value).toBeNull()
    expect(f(profileOf([stmt({ monthly: BASIC })], { supplier: { ...supplier, rfc: 'OTR150304AB1' } }), 'identity_match').value).toBe('mismatch')
  })

  it('sin proveedor registrado es desconocido', () => {
    expect(f(profileOf([stmt({ monthly: BASIC })]), 'identity_match').note).toContain('sin proveedor registrado')
  })
})

describe('fuentes externas', () => {
  const uuid = 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B'

  function snapshot(patch: Partial<ExternalSnapshot>): ExternalSnapshot {
    return { ...emptyExternalSnapshot(), ...patch }
  }

  it('sin fuentes disponibles sus features son desconocidas, nunca cero', () => {
    const p = profileOf([stmt({ monthly: BASIC })])
    for (const name of ['existing_exposure_balance', 'buro_score', 'sat_status', 'cfdi_sat_status', 'program_available_limit', 'statement_reuse_count'] as const) expect(f(p, name).value, name).toBeNull()
    expect(p.inputs.external.every((e) => !e.available)).toBe(true)
  })

  it('créditos vigentes: saldo, atraso, monto vencido y cuota sobre flujo libre', () => {
    const p = profileOf([stmt({ monthly: BASIC })], {
      external: snapshot({
        existing_credits: {
          available: true,
          simulated: true,
          credits: [
            { product: 'linea', balance: 120000, monthly_payment: 20000, days_past_due: 45, past_due_amount: 30000 },
            { product: 'otra', balance: 10000, monthly_payment: 1000, days_past_due: 0, past_due_amount: null },
          ],
        },
      }),
    })
    expect(f(p, 'existing_exposure_balance').value).toBe(130000)
    expect(f(p, 'existing_exposure_days_past_due').value).toBe(45)
    expect(f(p, 'existing_exposure_past_due_amount').value).toBe(30000)
    expect(f(p, 'existing_exposure_payment_ratio').value).toBeCloseTo(21000 / (f(p, 'free_cash_flow_monthly').value as number), 3)
    expect(f(p, 'existing_exposure_balance').provenance).toBe('external')
  })

  it('SAT: el peor estado de los CFDI y la parte del ingreso de pagadores en 69-B', () => {
    const s = stmt({
      monthly: [
        { kind: 'customer_payment', amount: 70000, counterparty: 'Pagador Principal', counterparty_rfc: 'PPR850101AB1' },
        { kind: 'customer_payment', amount: 30000, counterparty: 'Otro Cliente', counterparty_rfc: 'OCL850101AB2' },
      ],
      fiscal: { uuid, regime: '601' },
    })
    const p = profileOf([s], {
      external: snapshot({
        tax_authority: {
          available: true,
          simulated: true,
          taxpayer: { rfc_valid: true, compliance_opinion: 'positive', list_status: 'clear' },
          cfdi: [{ uuid, status: 'cancelled' }],
          listed_counterparties: [{ rfc: 'PPR850101AB1', list_status: 'efos_definitive' }],
        },
      }),
    })
    expect(f(p, 'cfdi_sat_status').value).toBe('cancelled')
    expect(f(p, 'sat_status').value).toBe('compliant')
    expect(f(p, 'sat_list_status').value).toBe('clear')
    expect(f(p, 'income_from_listed_rfc_share').value).toBe(0.7)
  })

  it('historial: reuso del UUID en el tenant y visto en otro prestamista', () => {
    const p = profileOf([stmt({ monthly: BASIC, fiscal: { uuid, regime: '601' } })], {
      external: snapshot({
        internal: { available: true, simulated: true, prior_applications: [], statement_reuse: [{ uuid, application_id: 'app-7' }], seen_elsewhere: [{ uuid: uuid.toLowerCase(), seen_on: '2026-10-02' }] },
      }),
    })
    expect(f(p, 'statement_reuse_count').value).toBe(1)
    expect(f(p, 'statement_seen_elsewhere_days').value).toBe(3)
    expect(f(p, 'prior_applications').value).toEqual([])
  })

  it('sin CFDI no hay huella: reuso desconocido', () => {
    const p = profileOf([stmt({ monthly: BASIC })], { external: snapshot({ internal: { available: true, simulated: true, prior_applications: [], statement_reuse: [], seen_elsewhere: [] } }) })
    expect(f(p, 'statement_reuse_count').value).toBeNull()
  })
})

describe('robustez documental', () => {
  const fiscal = { uuid: 'A1B2C3D4-0000-4E5F-8A9B-0C1D2E3F4A5B', regime: '601' }

  function issue(id: string, code: Issue['code'], extra: Partial<Issue> = {}): Issue {
    return { id, code, severity: 'warning', message: 'problema de prueba', page: null, path: null, account_id: null, period_id: null, transaction_id: null, details: {}, ...extra }
  }

  function flagged(spec: Spec, flags: DocumentFlag[], issues: Issue[] = [], seed = 'r1'): StatementExtraction {
    const s = stmt(spec, seed)
    return { ...s, flags: [...s.flags, ...flags], issues }
  }

  const tamper = (s: StatementExtraction) => f(profileOf([s]), 'document_tamper_signals')

  it('un estado sintético lleva las banderas que se le piden (escenario 28), sin repetirlas', () => {
    expect(stmt({ monthly: BASIC, flags: ['pages_missing', 'pages_missing'] }).flags).toEqual(['pages_missing'])
    expect(stmt({ monthly: BASIC }).flags).toEqual([])
    expect(f(profileOf([stmt({ monthly: BASIC, flags: ['pages_missing'] })]), 'document_pages_missing').value).toBe(true)
  })

  it('un documento sin señales: páginas completas y ninguna señal, verificadas y con confianza 1', () => {
    const p = profileOf([stmt({ monthly: BASIC })])
    expect(Profile.safeParse(p).success).toBe(true)
    expect(f(p, 'document_pages_missing')).toMatchObject({ value: false, verification: 'verified', confidence: 1, evidence: [] })
    expect(f(p, 'document_tamper_signals')).toMatchObject({ value: [], verification: 'verified', confidence: 1, evidence: [] })
  })

  it('sin estados de cuenta utilizables, las dos son desconocidas', () => {
    const p = profileOf([])
    expect([f(p, 'document_pages_missing').value, f(p, 'document_tamper_signals').value]).toEqual([null, null])
  })

  it('la bandera pages_missing da document_pages_missing; la evidencia es sha:id del problema', () => {
    const s = flagged({ monthly: BASIC }, ['pages_missing'], [issue('i1', 'page_missing', { details: { missing: [2], total: 3 } })])
    const p = profileOf([s])
    expect(f(p, 'document_pages_missing')).toMatchObject({ value: true, verification: 'verified', confidence: 1, evidence: [`${s.document.sha256.slice(0, 12)}:i1`] })
    // Missing pages are not tampering.
    expect(f(p, 'document_tamper_signals').value).toEqual([])
  })

  it('el problema page_missing sin la bandera no cuenta: manda la bandera del documento', () => {
    expect(f(profileOf([flagged({ monthly: BASIC }, [], [issue('i1', 'page_missing')])]), 'document_pages_missing').value).toBe(false)
  })

  it('una bandera sin problema que la explique igual cuenta, con la bandera como evidencia', () => {
    const s = flagged({ monthly: BASIC }, ['pages_missing'])
    expect(f(profileOf([s]), 'document_pages_missing')).toMatchObject({ value: true, evidence: [`${s.document.sha256.slice(0, 12)}:pages_missing`] })
  })

  it('prompt_injection: la bandera possible_prompt_injection', () => {
    const s = flagged({ monthly: BASIC }, ['possible_prompt_injection'], [issue('i1', 'possible_prompt_injection')])
    expect(tamper(s)).toMatchObject({ value: ['prompt_injection'], evidence: [`${s.document.sha256.slice(0, 12)}:i1`] })
  })

  it('fiscal_chain_mismatch: solo los problemas de severidad error; un aviso de fecha o de formato no cuenta', () => {
    const error = flagged({ monthly: BASIC, fiscal }, [], [issue('i1', 'fiscal_chain_mismatch', { severity: 'error' })])
    expect(tamper(error).value).toEqual(['fiscal_chain_mismatch'])
    const warning = flagged({ monthly: BASIC, fiscal }, [], [issue('i1', 'fiscal_chain_mismatch', { severity: 'warning' })])
    expect(tamper(warning).value).toEqual([])
  })

  it('fiscal_stamp_far_from_period: date_out_of_period del CFDI sí, el de los movimientos no', () => {
    const cfdi = flagged({ monthly: BASIC, fiscal }, [], [issue('i1', 'date_out_of_period')])
    expect(tamper(cfdi)).toMatchObject({ value: ['fiscal_stamp_far_from_period'], evidence: [`${cfdi.document.sha256.slice(0, 12)}:i1`] })
    // Movements outside the period (extract.ts) always carry the period.
    const periodId = cfdi.accounts[0]?.periods[0]?.id ?? null
    const movements = flagged({ monthly: BASIC, fiscal }, [], [issue('i1', 'date_out_of_period', { period_id: periodId, details: { count: 3 } })])
    expect(tamper(movements).value).toEqual([])
    // With no CFDI in the document there is no stamp that could be far off.
    expect(tamper(flagged({ monthly: BASIC }, [], [issue('i1', 'date_out_of_period')])).value).toEqual([])
  })

  it('pages_duplicated: la bandera; header_read_conflict: el problema, con cualquier severidad', () => {
    const dup = flagged({ monthly: BASIC }, ['pages_duplicated'], [issue('i1', 'duplicate_page_removed', { page: 2, details: { same_as: 1 } })])
    expect(tamper(dup)).toMatchObject({ value: ['pages_duplicated'], evidence: [`${dup.document.sha256.slice(0, 12)}:i1`] })
    expect(tamper(flagged({ monthly: BASIC }, [], [issue('i1', 'header_read_conflict', { severity: 'info' })])).value).toEqual(['header_read_conflict'])
  })

  it('varias señales de varios documentos: lista cerrada, ordenada y sin repetir', () => {
    const a = flagged({ monthly: BASIC, fiscal }, ['possible_prompt_injection', 'pages_duplicated'], [issue('i1', 'fiscal_chain_mismatch', { severity: 'error' }), issue('i2', 'header_read_conflict')], 'a')
    const b = flagged({ start: '2026-10-01', monthly: BASIC }, ['possible_prompt_injection'], [], 'b')
    const p = profileOf([a, b])
    expect(f(p, 'document_tamper_signals').value).toEqual(['fiscal_chain_mismatch', 'header_read_conflict', 'pages_duplicated', 'prompt_injection'])
    expect(f(p, 'document_tamper_signals').evidence).toHaveLength(5)
    expect(Profile.safeParse(p).success).toBe(true)
  })
})

describe('el sobregiro calculado solo se cree si el periodo cuadra', () => {
  /** Daily balance is computed from movements only: with no per-row printed balance it is the only source. */
  function withoutPrintedBalances(s: StatementExtraction): StatementExtraction {
    for (const a of s.accounts) for (const p of a.periods) for (const t of p.transactions) t.balance = null
    return s
  }

  // 100 opening balance, deposits of 4,500 on days 7 and 22 and a 5,000 charge on day 15: from 15 to 21 the daily
  // balance is -400. (Balance is end-of-day: a charge and deposit on the same day do not take it below zero.)
  const NEGATIVE: Spec['monthly'] = [
    { kind: 'supplier_payment', amount: 5000, description: 'PAGO A PROVEEDOR ACME' },
    { kind: 'customer_payment', amount: 9000, count: 2, description: 'SPEI RECIBIDO CLIENTE' },
  ]
  const negative = (spec: Partial<Spec> = {}, seed = 'o1') => withoutPrintedBalances(stmt({ opening_balance: 100, monthly: NEGATIVE, ...spec }, seed))

  it('si el periodo cuadra, el saldo diario negativo es sobregiro', () => {
    const p = profileOf([negative()])
    expect(f(p, 'red_flags')).toMatchObject({ value: ['overdraft'], evidence: ['saldo diario calculado'] })
  })

  it('si el periodo no cuadra, el saldo calculado no es confiable y no se inventa el sobregiro', () => {
    const p = profileOf([negative({ reconciled: false })])
    expect(f(p, 'red_flags')).toMatchObject({ value: [], verification: 'verified', note: 'saldo calculado no confiable: el periodo no cuadra' })
    expect(f(p, 'integrity_ok').value).toBe(false)
  })

  it('ADR 0072: con dos meses solo cuenta el último; el saldo inicial del mes evaluado sale del anterior', () => {
    // Month 1 goes to -400; month 2 opens at 4,100 and never goes below zero.
    const s = negative({ months: 2 })
    expect(f(profileOf([s]), 'red_flags').value).toEqual([])
    const single = negative({ months: 2, periods: 'single' })
    expect(f(profileOf([single]), 'red_flags').value).toEqual([])
    expect(f(profileOf([single]), 'avg_daily_balance').value).toBe(f(profileOf([s]), 'avg_daily_balance').value)
    // The previous month not reconciling does not touch the evaluated one.
    const first = s.accounts[0]?.periods[0]
    if (!first?.reconciliation) throw new Error('sin primer periodo')
    first.reconciliation.status = 'not_reconciled'
    expect(f(profileOf([s]), 'integrity_ok').value).toBe(true)
  })

  it('un cuadre parcial tampoco basta: solo cuenta reconciled', () => {
    const s = negative()
    const period = s.accounts[0]?.periods[0]
    if (!period?.reconciliation) throw new Error('sin periodo')
    period.reconciliation.status = 'partially_reconciled'
    expect(f(profileOf([s]), 'red_flags').value).toEqual([])
  })

  it('el sobregiro por saldo impreso negativo o por SOBREGIRO en la descripción sigue igual aunque no cuadre', () => {
    // The row's printed balance is the bank's.
    const printed = stmt({ opening_balance: 100, reconciled: false, monthly: NEGATIVE })
    expect(f(profileOf([printed]), 'red_flags').value).toEqual(['overdraft'])
    const text = negative({ reconciled: false, monthly: [...NEGATIVE, { kind: 'fee', amount: 100, description: 'COMISION POR SOBREGIRO' }] })
    expect(f(profileOf([text]), 'red_flags').value).toEqual(['overdraft'])
  })

  it('las demás banderas no dependen del cuadre', () => {
    const s = negative({ reconciled: false, monthly: [...NEGATIVE, { kind: 'supplier_payment', amount: 100, description: 'CARGO EMBARGO CUENTA' }] })
    expect(f(profileOf([s]), 'red_flags').value).toEqual(['garnishment'])
  })
})

describe('domicilio del titular', () => {
  const ADDRESS = 'AV. REFORMA 100, COL. JUÁREZ, CUAUHTÉMOC, CDMX, C.P. 06600'
  const withAddress = (address: string | null, seed: string) => syntheticStatement({ start: '2026-09-01', opening_balance: 50000, monthly: BASIC }, { ...holder, address }, seed)

  it('un estado de cuenta con domicilio: presente, verificado y con su evidencia; el domicilio no entra al perfil', () => {
    const p = profileOf([withAddress(ADDRESS, 'dom1')])
    expect(f(p, 'holder_address_present')).toMatchObject({ value: true, verification: 'verified', evidence: [expect.stringMatching(/:holder\.address$/)] })
    expect(JSON.stringify(p)).not.toContain('REFORMA')
  })

  it('sin domicilio en ningún documento: falso, con la nota', () => {
    expect(f(profileOf([withAddress(null, 'dom2')]), 'holder_address_present')).toMatchObject({ value: false, note: 'ningún estado de cuenta trae el domicilio del titular' })
  })

  it('basta uno de varios estados de cuenta', () => {
    expect(f(profileOf([withAddress(null, 'dom3'), withAddress(ADDRESS, 'dom4')]), 'holder_address_present').value).toBe(true)
  })

  it('leído pero no ubicado en el texto (escaneado por visión): presente y sin verificar', () => {
    const s = withAddress(ADDRESS, 'dom5')
    const unverified = { ...s, holder: { ...s.holder, address: { ...s.holder.address, verification: 'unverified' as const, source: null, confidence: 0.3 } } }
    expect(f(profileOf([unverified]), 'holder_address_present')).toMatchObject({ value: true, verification: 'unverified' })
  })
})
