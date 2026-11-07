import { describeFailure, multipleStatementsReason, type Question } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import { ANALYST_NOTICE, answerLabel, DOCUMENT_REPLIES, documentRequestReplies, failureNotice, isConversational, isDocumentRequest, isSkip, parseAmount, parseConfirmation, parseLegalName, parseMaturity, parseMultipleReplies, parseReply, parseRfc, notQualifiedReasons, parseYesNo, personTypeOf, questionSubject, REGISTRATION_REPLIES, renderDocumentRequest, renderQuestion, renderQuestionAt, renderReask, renderSummary, renderVerdict } from './conversation.ts'
import { signSvix, verifySvix } from './svix.ts'
import { ResendEmailTransport } from './transports.ts'

const deposit: Question = {
  id: 'q1',
  topic: 'deposit_classification',
  kind: 'deposit',
  transaction: { document_sha256: 'a'.repeat(64), transaction_id: 't1' },
  facts: [],
  options: [
    { value: 'customer_payment', label: 'Pago de un cliente o venta' },
    { value: 'loan_disbursement', label: 'Préstamo o crédito' },
    { value: 'own_transfer', label: 'Traspaso desde otra cuenta mía' },
    { value: 'interest', label: 'Intereses o rendimientos' },
    { value: 'other', label: 'Otra cosa' },
  ],
  text: '¿Qué fue el abono?',
  text_source: 'template',
}

const cat = (text: string) => {
  const a = parseReply(text, deposit)
  return a === null ? null : a.kind === 'deposit' ? a.category : a.kind
}

describe('respuestas por WhatsApp o correo', () => {
  it.each([
    ['1', 'customer_payment'],
    ['2)', 'loan_disbursement'],
    ['Opción 3', 'own_transfer'],
    ['Es un pago de cliente, de Cadena Norte', 'customer_payment'],
    ['fue una venta', 'customer_payment'],
    ['Es un préstamo de la financiera', 'loan_disbursement'],
    ['un traspaso de mi otra cuenta', 'own_transfer'],
    ['rendimientos', 'interest'],
    ['otra cosa', 'other'],
    ['no sé, no recuerdo', 'decline'],
  ])('"%s" → %s', (text, expected) => {
    expect(cat(text)).toBe(expected)
  })

  it('no adivina: ambigua o sin señal vuelve a preguntar', () => {
    expect(cat('un cliente me prestó dinero, un préstamo')).toBeNull()
    expect(cat('hola buenas tardes')).toBeNull()
    expect(cat('9')).toBeNull()
    expect(cat('respondo por la solicitud 4821')).toBeNull()
  })

  it('el mensaje numera las opciones y la repregunta también', () => {
    expect(renderQuestion(deposit, 1, 2)).toMatch(/^Pregunta 1 de 2\. .*\n\nResponde con el número:\n1\) Pago de un cliente o venta\n2\)/s)
    expect(renderReask(deposit)).toContain('5) Otra cosa')
  })
})

const charge: Question = {
  ...deposit,
  id: 'q2',
  topic: 'charge_classification',
  kind: 'charge',
  options: [
    { value: 'loan_payment', label: 'Pago de un crédito o préstamo' },
    { value: 'supplier_payment', label: 'Pago a un proveedor o gasto del negocio' },
    { value: 'own_transfer', label: 'Traspaso a otra cuenta mía' },
    { value: 'personal_expense', label: 'Gasto personal' },
    { value: 'other', label: 'Otra cosa' },
  ],
  text: '¿Qué fue el cargo?',
}
const accountUse: Question = {
  ...deposit,
  id: 'q3',
  topic: 'account_use',
  kind: 'account_use',
  transaction: null,
  options: [
    { value: 'business_only', label: 'Solo para mi negocio' },
    { value: 'mixed', label: 'Para mi negocio y también gastos personales' },
  ],
  text: '¿Usas esta cuenta solo para tu negocio o también para gastos personales?',
}
const buyerQ: Question = { ...deposit, id: 'q4', topic: 'main_buyer', kind: 'buyer', transaction: null, options: [], text: '¿Quién es tu cliente principal?' }

const pick = (text: string, q: Question) => {
  const a = parseReply(text, q)
  if (a === null) return null
  return a.kind === 'charge' ? a.category : a.kind === 'account_use' ? a.use : a.kind === 'buyer' ? `name:${a.name}` : a.kind
}

describe('preguntas nuevas por WhatsApp', () => {
  it('cargos, uso de la cuenta y cliente principal son conversacionales; identidad y documentos no', () => {
    expect([deposit, charge, accountUse, buyerQ].every(isConversational)).toBe(true)
    expect(isConversational({ ...deposit, kind: 'identity', topic: 'identity_fields' })).toBe(false)
    expect(isConversational({ ...deposit, kind: 'documents', topic: 'recent_statement' })).toBe(false)
  })

  it.each([
    ['1', 'loan_payment'],
    ['4', 'personal_expense'],
    ['era la mensualidad del préstamo', 'loan_payment'],
    ['le pagué al proveedor de la mercancía', 'supplier_payment'],
    ['un traspaso a mi otra cuenta', 'own_transfer'],
    ['fue un gasto personal', 'personal_expense'],
    ['otra cosa', 'other'],
    ['no sé', 'decline'],
  ])('cargo: "%s" → %s', (text, expected) => {
    expect(pick(text, charge)).toBe(expected)
  })

  it('cargo ambiguo vuelve a preguntar', () => {
    expect(pick('pago de mi tarjeta personal', charge)).toBeNull()
    expect(pick('hola', charge)).toBeNull()
  })

  it.each([
    ['1', 'business_only'],
    ['2', 'mixed'],
    ['solo para el negocio', 'business_only'],
    ['también la uso para cosas personales', 'mixed'],
    ['para las dos cosas', 'mixed'],
    ['no estoy seguro', 'decline'],
  ])('uso de la cuenta: "%s" → %s', (text, expected) => {
    expect(pick(text, accountUse)).toBe(expected)
  })

  it('uso de la cuenta ambiguo vuelve a preguntar', () => {
    expect(pick('sí', accountUse)).toBeNull()
    expect(pick('solo negocio, aunque también algo personal', accountUse)).toBeNull()
  })

  it.each([
    ['Cadena Comercial del Norte SA de CV', 'name:Cadena Comercial del Norte SA de CV'],
    ['Mi cliente principal es Tiendas Luna.', 'name:Tiendas Luna'],
    ['es   Walmart de México', 'name:Walmart de México'],
    ['no sé', 'decline'],
    ['omitir', 'decline'],
    ['varios', 'decline'],
  ])('cliente principal: "%s" → %s', (text, expected) => {
    expect(pick(text, buyerQ)).toBe(expected)
  })

  it('cliente principal: saludos, preguntas o números no son un nombre', () => {
    expect(pick('hola', buyerQ)).toBeNull()
    expect(pick('hola de nuevo', buyerQ)).toBeNull()
    expect(pick('Buenas tardes, ¿qué necesitan?', buyerQ)).toBeNull()
    expect(pick('¿a qué te refieres?', buyerQ)).toBeNull()
    expect(pick('2', buyerQ)).toBeNull()
    expect(pick('x'.repeat(150), buyerQ)).toBeNull()
  })

  it('la pregunta de texto libre no lleva opciones y la repregunta pide el nombre', () => {
    expect(renderQuestion(buyerQ, 1, 1)).toBe('¿Quién es tu cliente principal?')
    expect(renderReask(buyerQ)).toMatch(/nombre de la empresa/)
    expect(renderQuestion(accountUse, 2, 2)).toMatch(/\n1\) Solo para mi negocio\n2\) Para mi negocio y también gastos personales$/)
  })
})

describe('firma de webhooks (Svix)', () => {
  const secret = `whsec_${Buffer.from('secreto-de-prueba-32-bytes-000000').toString('base64')}`
  const now = 1_800_000_000
  const body = '{"type":"email.received"}'

  it('acepta la firma correcta dentro de la ventana', () => {
    const sig = signSvix(secret, 'msg_1', now, body)
    expect(verifySvix(secret, { id: 'msg_1', timestamp: String(now), signature: `v1,${sig}` }, body, now + 10)).toBe(true)
    expect(verifySvix(secret, { id: 'msg_1', timestamp: String(now), signature: `v1,otra v1,${sig}` }, body, now)).toBe(true)
  })

  it('rechaza cuerpo alterado, firma ajena, encabezados faltantes y replay viejo', () => {
    const sig = signSvix(secret, 'msg_1', now, body)
    expect(verifySvix(secret, { id: 'msg_1', timestamp: String(now), signature: `v1,${sig}` }, `${body} `, now)).toBe(false)
    expect(verifySvix(secret, { id: 'msg_2', timestamp: String(now), signature: `v1,${sig}` }, body, now)).toBe(false)
    expect(verifySvix(secret, { id: undefined, timestamp: String(now), signature: `v1,${sig}` }, body, now)).toBe(false)
    expect(verifySvix(secret, { id: 'msg_1', timestamp: String(now), signature: `v1,${sig}` }, body, now + 301)).toBe(false)
  })
})

describe('correo con Resend', () => {
  it('manda al destino del buzón con llave de idempotencia y sin filtrar el error', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const ok = new ResendEmailTransport({ apiKey: 're_test', from: 'aclaraciones@tenant.test', fetch: (url, init) => { calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} }); return Promise.resolve(new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })) } })
    expect(await ok.send({ id: 'm1', channel: 'email', destination: 'dueno@proveedor.test', body: 'hola' })).toEqual({ externalId: 'em_1' })
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('m1')
    const ko = new ResendEmailTransport({ apiKey: 're_test', from: 'x@t.test', fetch: () => Promise.resolve(new Response('{"to":"dueno@proveedor.test"}', { status: 422 })) })
    await expect(ko.send({ id: 'm2', channel: 'email', destination: 'dueno@proveedor.test', body: 'hola' })).rejects.toThrow(/^Resend respondió 422$/)
  })
})

describe('registro de proveedores por WhatsApp', () => {
  it('lee la razón social y descarta lo que no lo es', () => {
    expect(parseLegalName('  Distribuidora   del Norte SA de CV ')).toBe('Distribuidora del Norte SA de CV')
    expect(parseLegalName('ok')).toBeNull()
    expect(parseLegalName('12345')).toBeNull()
    expect(parseLegalName('x'.repeat(201))).toBeNull()
  })

  it('acepta RFC de persona moral y física, sin espacios ni guiones', () => {
    expect(parseRfc('dno150304ab1')).toBe('DNO150304AB1')
    expect(parseRfc('GOMA-800101-H2A')).toBe('GOMA800101H2A')
    expect(parseRfc('ÑAN 150304 AB1')).toBe('ÑAN150304AB1')
    expect(parseRfc('DNO15030AB1')).toBeNull()
    expect(parseRfc('hola')).toBeNull()
  })

  it('el RFC solo aparece en la confirmación de lo leído, al mismo número que mandó el estado de cuenta', () => {
    const texts = [REGISTRATION_REPLIES.welcome('Prestamista'), REGISTRATION_REPLIES.ask_rfc({ kind: 'missing' }), REGISTRATION_REPLIES.ask_rfc({ kind: 'corrected' }), REGISTRATION_REPLIES.thanks('Distribuidora'), REGISTRATION_REPLIES.idle('Distribuidora')]
    for (const t of texts) expect(t).not.toMatch(/[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}/)
    expect(REGISTRATION_REPLIES.confirm('Distribuidora SA de CV', 'DNO150304AB1')).toMatch(/a nombre de Distribuidora SA de CV, con RFC DNO150304AB1\.\n\n¿Son correctos\? Responde sí o no\./)
    expect(REGISTRATION_REPLIES.confirm('Ana López', null)).toMatch(/a nombre de Ana López\.\n\n¿Es correcto\?/)
    expect(REGISTRATION_REPLIES.ask_rfc({ kind: 'root', root: 'LOPA800101' })).toMatch(/sin homoclave \(LOPA800101\)/)
  })

  it('lee sí o no como lo escribe un proveedor', () => {
    for (const t of ['sí', 'Si', 'sip', 'Sí, son correctos', 'correcto', 'Así es', 'ok', '1']) expect(parseYesNo(t)).toBe(true)
    for (const t of ['no', 'No.', 'nel', 'no son correctos', 'no, el RFC está mal', '2']) expect(parseYesNo(t)).toBe(false)
    for (const t of ['no sé', 'tal vez', 'hola', '']) expect(parseYesNo(t)).toBeNull()
  })

  it('persona moral o física por la longitud del RFC', () => {
    expect(personTypeOf('DNO150304AB1')).toBe('moral')
    expect(personTypeOf('GOMA800101H2A')).toBe('fisica')
  })
})

describe('datos de la factura y aviso del veredicto', () => {
  it('lee montos como los escribe un proveedor', () => {
    expect(parseAmount('180000')).toBe(180000)
    expect(parseAmount('$180,000.50')).toBe(180000.5)
    expect(parseAmount('180 mil')).toBe(180000)
    expect(parseAmount('250k')).toBe(250000)
    expect(parseAmount('1.2 millones')).toBe(1200000)
    expect(parseAmount('180,000 pesos')).toBe(180000)
    expect(parseAmount('mucho')).toBeNull()
    expect(parseAmount('0')).toBeNull()
    expect(parseAmount('18,00')).toBeNull()
  })

  it('lee vencimientos y rechaza los pasados o inexistentes', () => {
    const today = '2026-11-06'
    expect(parseMaturity('20/12/2026', today)).toEqual({ date: '2026-12-20' })
    expect(parseMaturity('5-1-27', today)).toEqual({ date: '2027-01-05' })
    expect(parseMaturity('2026-12-20', today)).toEqual({ date: '2026-12-20' })
    expect(parseMaturity('20 de diciembre de 2026', today)).toEqual({ date: '2026-12-20' })
    expect(parseMaturity('20 dic 2026', today)).toEqual({ date: '2026-12-20' })
    expect(parseMaturity('01/01/2020', today)).toEqual({ past: true })
    expect(parseMaturity('31/02/2027', today)).toBeNull()
    expect(parseMaturity('pronto', today)).toBeNull()
  })

  it('"omitir" y sus variantes', () => {
    for (const t of ['omitir', 'Omitir ', 'no sé', 'no se', 'ninguno']) expect(isSkip(t)).toBe(true)
    expect(isSkip('Cadena Norte')).toBe(false)
  })

  it('el aviso dice el resultado y el monto, nunca motivos ni datos del documento', () => {
    const request = { amount: 180000, maturity: '2026-12-20', buyer: { name: 'Cadena Norte' } }
    const t = 'Prestamista Demo'
    expect(renderVerdict({ status: 'qualified', limit: 180000, request, tenantName: t })).toMatch(/^Buenas noticias: tu factura de \$180,000\.00 pesos a Cadena Norte con vencimiento el 20\/12\/2026 califica/)
    expect(renderVerdict({ status: 'qualified_with_limit', limit: 95000, request, tenantName: t })).toMatch(/hasta \$95,000\.00 pesos/)
    // A request that fits under the line is approved in full, without "con un límite".
    expect(renderVerdict({ status: 'qualified_with_limit', limit: 112304.66, request: { amount: 50000, maturity: null, buyer: null }, tenantName: t })).toBe('Buenas noticias: tu solicitud de adelanto de $50,000.00 pesos está aprobada con Prestamista Demo. Te contactaremos para los siguientes pasos.')
    expect(renderVerdict({ status: 'qualified_with_limit', limit: 40000, request: { amount: 50000, maturity: null, buyer: null }, tenantName: t })).toMatch(/Califica con un límite: podemos adelantarte hasta \$40,000\.00 pesos/)
    expect(renderVerdict({ status: 'qualified_with_limit', limit: 95000, request: null, tenantName: t })).toMatch(/^Revisamos tu estado de cuenta\. Podemos adelantarte hasta \$95,000\.00 pesos/)
    expect(renderVerdict({ status: 'not_qualified', limit: null, request, tenantName: t })).toMatch(/no califica para adelanto con [^.]+\. Si tu situación cambia/)
    expect(renderVerdict({ status: 'human_review', limit: null, request: null, tenantName: t })).toMatch(/analista/)
    expect(renderVerdict({ status: 'failed', limit: null, request: null, tenantName: t })).toMatch(/problema de nuestro lado/)
  })
})

describe('por qué no se pudo revisar, dicho al proveedor', () => {
  it('dice qué mandó y qué necesitamos', () => {
    expect(failureNotice({ kind: 'not_bank_statement', documentType: 'credit_card_statement' })).toMatch(/^Lo que mandaste es un estado de cuenta de tarjeta de crédito\. Para revisar tu solicitud necesitamos el estado de cuenta de tu cuenta de cheques o débito/)
    expect(failureNotice({ kind: 'not_bank_statement', documentType: 'invoice' })).toMatch(/parece una factura/)
    expect(failureNotice({ kind: 'not_bank_statement', documentType: 'other' })).toMatch(/no parece un estado de cuenta bancario/)
    expect(failureNotice({ kind: 'extraction_failed', documentType: null })).toMatch(/^No pudimos leer tu estado de cuenta/)
    expect(failureNotice(null)).toMatch(/problema de nuestro lado/)
    expect(renderVerdict({ status: 'failed', limit: null, request: null, tenantName: 'X', failure: { kind: 'not_bank_statement', documentType: 'credit_card_statement' } })).toMatch(/tarjeta de crédito/)
  })

  it('PDF con contraseña y escaneado ilegible tienen su propio aviso', () => {
    const password = 'Tu PDF tiene contraseña y no lo puedo abrir. Descárgalo de nuevo desde tu banco sin contraseña (o quítasela) y mándamelo por aquí.'
    expect(DOCUMENT_REPLIES.password_protected).toBe(password)
    expect(failureNotice({ kind: 'password_protected', documentType: null })).toBe(password)
    expect(failureNotice({ kind: 'scanned_unreadable', documentType: null })).toBe('No pude leer tu estado de cuenta: parece escaneado o una foto. Descárgalo en PDF desde el portal o la app de tu banco.')
    expect(renderVerdict({ status: 'failed', limit: null, request: null, tenantName: 'X', failure: { kind: 'scanned_unreadable', documentType: null } })).toMatch(/parece escaneado o una foto/)
  })
})

describe('varios estados de cuenta en un PDF, dicho al proveedor (robustez documental, sección W)', () => {
  const notice = 'Tu PDF trae más de un estado de cuenta. Mándanos cada estado de cuenta en un PDF aparte, tal como lo descargaste de tu banco.'

  it('pide cada estado de cuenta en su propio PDF, sin decir cuántos ni nada del documento', () => {
    expect(failureNotice({ kind: 'multiple_statements', documentType: null })).toBe(notice)
    expect(failureNotice(describeFailure(multipleStatementsReason(3)))).toBe(notice)
    expect(renderVerdict({ status: 'failed', limit: null, request: null, tenantName: 'X', failure: { kind: 'multiple_statements', documentType: null } })).toBe(notice)
  })
})

describe('pedido del PDF completo por páginas faltantes (robustez documental, sección W)', () => {
  const missingPages: Question = { id: 'q1', topic: 'missing_pages', kind: 'documents', transaction: null, facts: [], options: [], text: 'Al estado de cuenta que mandaste le faltan páginas (por ejemplo la 2 de 3). ¿Nos mandas el PDF completo?', text_source: 'template' }

  it('solo las páginas faltantes se contestan con un PDF por el chat; las demás preguntas de documentos siguen fuera', () => {
    expect(isDocumentRequest(missingPages)).toBe(true)
    expect(isDocumentRequest({ ...missingPages, topic: 'recent_statement' })).toBe(false)
    expect(isDocumentRequest({ ...missingPages, topic: 'reconciliation_gap' })).toBe(false)
    expect(isDocumentRequest(deposit)).toBe(false)
    // Not conversational: free text does not answer it and it is not numbered with the chat questions.
    expect(isConversational(missingPages)).toBe(false)
    expect(parseReply('ya te lo mandé', missingPages)).toBeNull()
  })

  it('sale por el chat con el texto de la pregunta y cómo contestarla', () => {
    expect(renderDocumentRequest(missingPages)).toBe(`${missingPages.text}\n\nMándalo por este chat como PDF, tal como lo descargaste de tu banco.`)
  })
})

describe('por qué no califica, breve y sin cifras', () => {
  const dim = (feature: string, weight: number, points: number, value: number | null, relative_to: string | null = null, used = true) => ({ id: feature, feature, relative_to, value, normalized: null, weight, points, used, excluded_reason: null })
  const decision = (dimensions: ReturnType<typeof dim>[], gates: unknown[] = []) => ({ evaluation: { gates, dimensions, caps: [], limit: null } }) as unknown as Parameters<typeof notQualifiedReasons>[0]

  it('deuda que se lleva casi todo y flujo negativo: las dos que más puntos pierden', () => {
    const d = decision([dim('operating_income_monthly', 35, 0, null, 'requested_amount', false), dim('buyer_payments_count', 25, 0, null), dim('debt_service_monthly', 15, 0, 0.96, 'operating_income_monthly'), dim('payment_capacity_pct', 15, 0, -0.25), dim('recurring_income_share', 10, 6, 0.4)])
    const reasons = notQualifiedReasons(d)
    expect(reasons).toEqual(['tus pagos a créditos se llevan casi todo lo que te entra', 'en el periodo salió más dinero del que entró'])
    const text = renderVerdict({ status: 'not_qualified', limit: null, request: null, tenantName: 'Prestamista', reasons })
    expect(text).toBe('Revisamos tu estado de cuenta. Por ahora no calificas para adelanto con Prestamista porque tus pagos a créditos se llevan casi todo lo que te entra y en el periodo salió más dinero del que entró. Si tu situación cambia, mándanos un estado de cuenta más reciente.')
    expect(text).not.toMatch(/\d/)
  })

  it('una regla que descarta va primero; sin causa clara, no se inventa', () => {
    expect(notQualifiedReasons(decision([dim('payment_capacity_pct', 15, 0, -1)], [{ id: 'no_arrears', feature: 'existing_exposure_days_past_due', outcome: 'fail', effect: 'not_qualified' }]))).toEqual(['tienes pagos atrasados en un adelanto anterior'])
    expect(notQualifiedReasons(decision([dim('payment_capacity_pct', 15, 14, 0.6)]))).toEqual([])
    expect(notQualifiedReasons(null)).toEqual([])
  })
})


describe('resumen, confirmación y varias respuestas', () => {
  const q = (id: string, amount: number, date: string): Question => ({ ...deposit, id, transaction: { document_sha256: 'a'.repeat(64), transaction_id: id }, facts: [{ name: 'fecha', value: date }, { name: 'monto', value: amount }, { name: 'concepto', value: 'DEPOSITO' }] })
  const identity: Question = { ...deposit, id: 'q4', topic: 'identity_fields', kind: 'identity', transaction: null, facts: [], options: [], text: 'Confirma la razón social y el RFC del titular. Gracias.' }
  const questions = [q('q1', 150000, '2026-09-15'), q('q2', 30000.5, '2026-09-20'), q('q3', 8000, '2026-10-01'), identity]
  const cats = (r: ReturnType<typeof parseMultipleReplies>) => (r?.kind === 'answers' ? r.answers.map((a) => (a.kind === 'deposit' ? a.category : a.kind)) : r)

  it('el resumen numera lo que entendió de cada pregunta del chat, con cifras solo de los hechos', () => {
    const text = renderSummary(questions, [
      { question_id: 'q1', kind: 'deposit', category: 'customer_payment', counterparty: null },
      { question_id: 'q2', kind: 'decline', note: null },
    ])
    expect(text).toBe(
      'Esto es lo que entendí:\n1) abono de $150,000.00 pesos del 15 de septiembre: Pago de un cliente o venta\n2) abono de $30,000.50 pesos del 20 de septiembre: No lo sé\n3) abono de $8,000.00 pesos del 1 de octubre: sin respuesta\n\n¿Es correcto? Responde sí para enviarlo a evaluación, o el número de la respuesta que quieres cambiar.',
    )
    // Identity is never asked over chat: not in the summary, not counted in "Pregunta N de M".
    expect(renderQuestionAt(questions, 1)).toMatch(/^Pregunta 2 de 3\. /)
    expect(questionSubject(identity)).toBe('Confirma la razón social y el RFC del titular.')
  })

  it('una respuesta de texto libre o de otro tipo se muestra tal cual', () => {
    const free: Question = { ...deposit, id: 'q9', options: [] }
    expect(answerLabel(free, { question_id: 'q9', kind: 'identity', legal_name: 'Cadena Norte', rfc: null, clabe: null })).toBe('Cadena Norte')
    expect(answerLabel(deposit, undefined)).toBe('sin respuesta')
  })

  it.each([
    ['1, 3, 1', ['customer_payment', 'own_transfer', 'customer_payment']],
    ['1 3', ['customer_payment', 'own_transfer']],
    ['2 y 5', ['loan_disbursement', 'other']],
    ['el primero es cliente y el segundo préstamo', ['customer_payment', 'loan_disbursement']],
    ['El segundo fue un préstamo, el primero un cliente', ['customer_payment', 'loan_disbursement']],
    ['cliente, préstamo', ['customer_payment', 'loan_disbursement']],
    ['cliente\ntraspaso\nno sé', ['customer_payment', 'own_transfer', 'decline']],
  ])('varias respuestas: %s', (text, expected) => {
    expect(cats(parseMultipleReplies(text, questions.slice(0, 3)))).toEqual(expected)
  })

  it('más respuestas que preguntas o una opción que no existe se repregunta; una sola respuesta no es de esta forma', () => {
    expect(parseMultipleReplies('1, 3, 1', questions.slice(1, 3))).toEqual({ kind: 'too_many', given: 3, pending: 2 })
    expect(parseMultipleReplies('1 9', questions.slice(0, 3))).toEqual({ kind: 'invalid' })
    expect(parseMultipleReplies('el primero es cliente y el tercero asdf', questions.slice(0, 3))).toEqual({ kind: 'invalid' })
    expect(parseMultipleReplies('1', questions.slice(0, 3))).toBeNull()
    // A comma phrase that is a single answer.
    expect(parseMultipleReplies('Es un pago de cliente, de Cadena Norte', questions.slice(0, 3))).toBeNull()
    // No options (free text): never split.
    expect(parseMultipleReplies('1 2', [identity])).toBeNull()
  })

  it.each([
    ['sí', { kind: 'confirm' }],
    ['Si, todo bien', { kind: 'confirm' }],
    ['correcto', { kind: 'confirm' }],
    ['no', { kind: 'reject' }],
    ['2', { kind: 'change', number: 2 }],
    ['la 3', { kind: 'change', number: 3 }],
    ['me equivoqué en la 2', { kind: 'change', number: 2 }],
    ['quiero cambiar la segunda', { kind: 'change', number: 2 }],
    ['7', { kind: 'change', number: 7 }],
  ])('respuesta al resumen: %s', (text, expected) => {
    expect(parseConfirmation(text, questions)).toEqual(expected)
  })

  it('una corrección libre se lee contra la pregunta que nombra', () => {
    const correct = (text: string) => {
      const r = parseConfirmation(text, questions)
      return r?.kind === 'correct' ? [r.number, r.answer.kind === 'deposit' ? r.answer.category : r.answer.kind, r.answer.question_id] : r
    }
    expect(correct('me equivoqué, el 2 era préstamo')).toEqual([2, 'loan_disbursement', 'q2'])
    expect(correct('no, la segunda es un traspaso de mi otra cuenta')).toEqual([2, 'own_transfer', 'q2'])
    expect(correct('el 1 es la 4')).toEqual([1, 'interest', 'q1'])
    expect(correct('préstamo era la 3')).toEqual([3, 'loan_disbursement', 'q3'])
    expect(correct('3: no sé')).toEqual([3, 'decline', 'q3'])
    expect(parseConfirmation('hola, ¿qué es esto?', questions)).toBeNull()
  })

  it('el aviso del analista es uno solo para todos los casos', () => {
    expect(REGISTRATION_REPLIES.analyst).toBe(ANALYST_NOTICE)
    expect(ANALYST_NOTICE).toBe('Un analista revisará tu estado de cuenta y te avisaremos el resultado por este chat.')
  })
})

describe('pedido de un estado de cuenta con domicilio', () => {
  const address: Question = { id: 'q1', topic: 'statement_with_address', kind: 'documents', transaction: null, facts: [], options: [], text: 'El estado de cuenta que mandaste no trae tu domicilio. ¿Nos mandas uno que sí lo traiga? Suele venir en la primera página, junto a tu nombre.', text_source: 'template' }
  const pages: Question = { ...address, topic: 'missing_pages', text: 'Al estado de cuenta que mandaste le faltan páginas. ¿Nos mandas el PDF completo?' }

  it('también se contesta mandando el PDF por el chat y no es conversacional', () => {
    expect(isDocumentRequest(address)).toBe(true)
    expect(isConversational(address)).toBe(false)
    expect(renderDocumentRequest(address)).toMatch(/no trae tu domicilio[\s\S]*Mándalo por este chat como PDF/)
  })

  it('las respuestas hablan del domicilio, no de páginas faltantes; las de páginas no cambian', () => {
    const r = documentRequestReplies(address)
    for (const text of Object.values(r)) expect(text).not.toMatch(/completo|faltan páginas/)
    expect(r.sameFile).toMatch(/no trae tu domicilio/)
    expect(r.sendPdf).toMatch(/que traiga tu domicilio/)
    expect(documentRequestReplies(pages)).toEqual({ received: DOCUMENT_REPLIES.answer_received, forReview: DOCUMENT_REPLIES.answer_for_review, sameFile: DOCUMENT_REPLIES.answer_same_file, sendPdf: DOCUMENT_REPLIES.send_pdf })
  })
})
