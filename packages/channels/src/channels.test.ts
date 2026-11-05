import type { Question } from '@gow/contracts'
import { describe, expect, it } from 'vitest'
import { parseReply, renderQuestion, renderReask } from './conversation.ts'
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
