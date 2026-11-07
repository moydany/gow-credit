import { describe, expect, it } from 'vitest'
import { ApplicationTimeline, type TimelineEvent, type TimelineEventKind } from './timeline.ts'
import { buildTimeline, EXCHANGE_CREATED_AT_MARKS } from './timeline-build.ts'
import type { TimelineSources } from './timeline-sources.ts'
import { at, auditRow, DAY, exchange, extractionPayload, FIXTURE_SECRETS, MINUTE, SAMPLE_APPLICATION_ID, SECOND, sampleTimelineSources, TIMELINE_SAMPLE_KINDS, whatsappSources, type TimelineSampleKind } from './testing/timeline-fixtures.ts'

function ofKind<K extends TimelineEventKind>(t: ApplicationTimeline, kind: K): Array<Extract<TimelineEvent, { kind: K }>> {
  return t.events.filter((e): e is Extract<TimelineEvent, { kind: K }> => e.kind === kind)
}

const ms = (iso: string): number => Date.parse(iso)
const rel = (t: ApplicationTimeline, iso: string): number => ms(iso) - ms(at(0).toISOString())
const byId = (t: ApplicationTimeline, id: string): TimelineEvent => {
  const e = t.events.find((x) => x.id === id)
  if (!e) throw new Error(`no hay evento ${id}`)
  return e
}
const step = (t: ApplicationTimeline, name: string) => ofKind(t, 'workflow_step').filter((e) => e.step === name)

describe('buildTimeline: contrato y orden', () => {
  it.each(TIMELINE_SAMPLE_KINDS)('%s: la salida pasa ApplicationTimeline.parse y vuelve a pasarlo', (kind) => {
    const t = buildTimeline(sampleTimelineSources(kind))
    expect(ApplicationTimeline.safeParse(t).success).toBe(true)
    expect(ApplicationTimeline.parse(t)).toEqual(t)
  })

  it.each(TIMELINE_SAMPLE_KINDS)('%s: eventos ordenados por inicio, ids únicos, cada uno en un capítulo existente', (kind) => {
    const t = buildTimeline(sampleTimelineSources(kind))
    const starts = t.events.map((e) => ms(e.start))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(new Set(t.events.map((e) => e.id)).size).toBe(t.events.length)
    const chapterIds = new Set(t.chapters.map((c) => c.id))
    expect(chapterIds.size).toBe(t.chapters.length)
    for (const e of t.events) expect(chapterIds.has(e.chapter)).toBe(true)
    for (const e of t.events) if (e.end) expect(ms(e.end)).toBeGreaterThanOrEqual(ms(e.start))
    expect(ms(t.start)).toBe(Math.min(...starts))
    expect(ms(t.end)).toBe(Math.max(...t.events.map((e) => ms(e.end ?? e.start))))
    expect(t.totals.duration_ms).toBe(ms(t.end) - ms(t.start))
  })

  it.each(TIMELINE_SAMPLE_KINDS)('%s: los capítulos son la envolvente de sus eventos y van en orden del tiempo', (kind) => {
    const t = buildTimeline(sampleTimelineSources(kind))
    for (const c of t.chapters) {
      const mine = t.events.filter((e) => e.chapter === c.id)
      expect(mine.length).toBeGreaterThan(0)
      expect(ms(c.start)).toBe(Math.min(...mine.map((e) => ms(e.start))))
      expect(ms(c.end)).toBe(Math.max(...mine.map((e) => ms(e.end ?? e.start))))
    }
    const starts = t.chapters.map((c) => ms(c.start))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it.each(TIMELINE_SAMPLE_KINDS)('%s: es determinista, también con las filas en otro orden', (kind: TimelineSampleKind) => {
    const a = buildTimeline(sampleTimelineSources(kind))
    const b = buildTimeline(sampleTimelineSources(kind))
    expect(b).toEqual(a)
    const src = sampleTimelineSources(kind)
    const shuffled: TimelineSources = {
      ...src,
      audit: [...src.audit].reverse(),
      exchanges: [...src.exchanges].reverse(),
      inbound: [...src.inbound].reverse(),
      outbound: [...src.outbound].reverse(),
      decisions: [...src.decisions].reverse(),
      clarifications: [...src.clarifications].reverse(),
    }
    expect(buildTimeline(shuffled)).toEqual(a)
  })

  it.each(TIMELINE_SAMPLE_KINDS)('%s: ningún texto lleva montos, RFC, nombres ni domicilio del documento', (kind) => {
    const t = buildTimeline(sampleTimelineSources(kind))
    const texts = t.events.map((e) => e.label).concat(t.chapters.map((c) => c.title), t.limitations)
    for (const text of texts) for (const secret of FIXTURE_SECRETS) expect(text).not.toContain(secret)
    const all = JSON.stringify(t)
    for (const secret of ['XAXX010101000', 'COMERCIALIZADORA', 'REFORMA', 'BANCO FICTICIO', 'SPEI RECIBIDO']) expect(all).not.toContain(secret)
    for (const e of ofKind(t, 'decision')) expect(JSON.stringify(e)).not.toContain('90000')
    for (const e of t.events) expect(e.label.length).toBeLessThanOrEqual(160)
  })
})

describe('buildTimeline: WhatsApp con aclaración, reanudación y veredicto', () => {
  const t = buildTimeline(whatsappSources())

  it('crea la solicitud con su canal y marca los mensajes interpretados', () => {
    const created = ofKind(t, 'application_created')[0]
    expect(created?.origin).toBe('whatsapp')
    expect(created?.precision).toBe('exact')
    expect(created?.lane).toBe('queue')
    const inbound = ofKind(t, 'inbound_message')
    expect(inbound.map((m) => m.resolution)).toEqual(['document_received', 'intake_step', 'intake_completed', 'completed'])
    expect(inbound.map((m) => m.interpreted)).toEqual([false, true, false, false])
    expect(inbound[0]?.has_document).toBe(true)
    expect(inbound.every((m) => m.lane === 'supplier' && m.precision === 'exact')).toBe(true)
    // start = received, end = processed
    expect(rel(t, inbound[0]?.start ?? '')).toBe(0)
    expect(rel(t, inbound[0]?.end ?? '')).toBe(2 * SECOND)
  })

  it('los salientes van por el relevo con su entrega', () => {
    const out = ofKind(t, 'outbound_message')
    expect(out.map((o) => o.message_kind)).toEqual(['invoice', 'invoice', 'invoice', 'question', 'verdict'])
    expect(out.every((o) => o.lane === 'relay' && o.delivery === 'sent')).toBe(true)
    const q = out.find((o) => o.message_kind === 'question')
    expect(rel(t, q?.start ?? '')).toBe(138 * SECOND)
    expect(rel(t, q?.end ?? '')).toBe(139 * SECOND)
  })

  it('espera en cola derivada: del encolado a la primera actividad, para process y para resume', () => {
    const waits = ofKind(t, 'queue_wait')
    expect(waits.map((w) => w.job)).toEqual(['process', 'resume'])
    expect(waits.every((w) => w.precision === 'derived' && w.lane === 'queue')).toBe(true)
    // process: from when the invoice data was completed until extraction started
    expect(rel(t, waits[0]?.start ?? '')).toBe(87 * SECOND)
    expect(rel(t, waits[0]?.end ?? '')).toBe(100 * SECOND)
    // resume: from when the clarification was answered
    expect(rel(t, waits[1]?.start ?? '')).toBe(DAY + 3 * SECOND)
    expect(rel(t, waits[1]?.end ?? '')).toBe(DAY + 153 * SECOND)
  })

  it('pasos del workflow con su precisión y su ronda', () => {
    const extract = step(t, 'extract')
    expect(extract).toHaveLength(1)
    expect(extract[0]).toMatchObject({ precision: 'exact', round: 0, lane: 'workflow' })
    expect(rel(t, extract[0]?.start ?? '')).toBe(100 * SECOND)
    expect(rel(t, extract[0]?.end ?? '')).toBe(130 * SECOND)
    expect(step(t, 'classify-transactions')[0]).toMatchObject({ precision: 'exact' })
    expect(step(t, 'decide')[0]).toMatchObject({ precision: 'inferred', round: 0 })
    // ask-owner: from drafting the questions until the clarification opens, both with their own time
    const ask = step(t, 'ask-owner')[0]
    expect(ask?.precision).toBe('exact')
    expect(rel(t, ask?.start ?? '')).toBe(134 * SECOND)
    expect(rel(t, ask?.end ?? '')).toBe(138 * SECOND)
    // resume job: round 1
    expect(step(t, 'apply-answers')[0]).toMatchObject({ precision: 'inferred', round: 1 })
    expect(step(t, 're-decide')[0]).toMatchObject({ precision: 'inferred', round: 1 })
    expect(step(t, 'explain')[0]).toMatchObject({ precision: 'exact', round: 1 })
    expect(step(t, 'finalize')[0]).toMatchObject({ precision: 'inferred' })
    // the suspended job neither explains nor closes with finalize
    expect(step(t, 'explain')).toHaveLength(1)
    expect(step(t, 'finalize')).toHaveLength(1)
  })

  it('cierre de cada trabajo con su estado', () => {
    const done = ofKind(t, 'job_finished')
    expect(done.map((j) => [j.job, j.application_status])).toEqual([
      ['process', 'needs_clarification'],
      ['resume', 'qualified_with_limit'],
    ])
    expect(done.every((j) => j.precision === 'exact' && j.lane === 'queue')).toBe(true)
  })

  it('aclaración: abierta, suspendida un día y contestada', () => {
    const opened = ofKind(t, 'clarification_opened')[0]
    const answered = ofKind(t, 'clarification_answered')[0]
    const suspended = ofKind(t, 'workflow_suspended')[0]
    expect(opened).toMatchObject({ round: 1, questions: 2, lane: 'workflow', precision: 'exact' })
    expect(answered).toMatchObject({ round: 1, answers: 2, lane: 'supplier', precision: 'exact' })
    expect(suspended).toMatchObject({ round: 1, lane: 'workflow', precision: 'exact' })
    expect(rel(t, suspended?.start ?? '')).toBe(138 * SECOND)
    expect(rel(t, suspended?.end ?? '')).toBe(DAY + 3 * SECOND)
  })

  it('las decisiones se colocan al inicio del paso de decisión, sin montos', () => {
    const decisions = ofKind(t, 'decision')
    expect(decisions.map((d) => [d.decision_kind, d.status])).toEqual([
      ['active', 'needs_clarification'],
      ['active', 'qualified_with_limit'],
      ['shadow', 'qualified'],
    ])
    expect(decisions.every((d) => d.precision === 'inferred' && d.lane === 'engine')).toBe(true)
    expect(ms(decisions[0]?.start ?? '')).toBe(ms(step(t, 'decide')[0]?.start ?? ''))
    expect(ms(decisions[1]?.start ?? '')).toBe(ms(step(t, 're-decide')[0]?.start ?? ''))
    expect(decisions[0]).toMatchObject({ has_limit: false, asks: ['deposit_classification'], policy_version: 3, band_index: null })
    expect(decisions[1]).toMatchObject({ has_limit: true, asks: [], band_index: 1, score: 62.5 })
    expect(decisions[2]).toMatchObject({ policy_version: 4 })
    expect(decisions[1]?.gates).toEqual([
      { id: 'no_arrears', outcome: 'pass', effect: 'none' },
      { id: 'recent_statement', outcome: 'pass', effect: 'none' },
    ])
    expect(decisions[0]?.gates[1]).toEqual({ id: 'recent_statement', outcome: 'unknown', effect: 'needs_clarification' })
    expect(decisions[1]?.dimensions).toEqual([{ id: 'capacity', weight: 35, normalized: 0.6, used: true }])
  })

  it('verdict_queued y el análisis del analista', () => {
    const v = ofKind(t, 'verdict_queued')[0]
    expect(v).toMatchObject({ application_status: 'qualified_with_limit', lane: 'relay', precision: 'exact' })
    const a = ofKind(t, 'analyst_action')[0]
    expect(a).toMatchObject({ action: 'application.viewed', lane: 'analyst' })
  })

  it('capítulos en español, en orden', () => {
    expect(t.chapters.map((c) => c.title)).toEqual([
      'Recepción',
      'Datos de la factura',
      'Extracción',
      'Movimientos',
      'Decisión · ronda 1',
      'Aclaración · ronda 1',
      'Reanudación · ronda 1',
      'Decisión · ronda 2',
      'Explicación',
      'Veredicto',
      'Revisión del analista',
    ])
    expect(t.chapters.map((c) => c.kind)).toEqual(['reception', 'intake', 'extraction', 'classification', 'decision', 'clarification', 'resume', 'decision', 'explanation', 'verdict', 'analyst'])
    const clarification = t.chapters.find((c) => c.kind === 'clarification')
    expect(clarification?.round).toBe(1)
    // the question, its drafting, the suspension, the answer and the job close live in the clarification
    const kinds = new Set(t.events.filter((e) => e.chapter === clarification?.id).map((e) => e.kind))
    for (const k of ['clarification_opened', 'clarification_answered', 'workflow_suspended', 'outbound_message', 'inbound_message', 'job_finished', 'model_call', 'workflow_step'] as const) expect(kinds.has(k)).toBe(true)
  })

  it('una espera de un día es un tramo comprimible que espera al proveedor; la cola y lo ocioso también se rotulan', () => {
    expect(t.gaps.map((g) => g.reason)).toEqual(['waiting_supplier', 'waiting_queue', 'idle'])
    const [supplier, queue, idle] = t.gaps
    expect(rel(t, supplier?.start ?? '')).toBe(139 * SECOND)
    expect(rel(t, supplier?.end ?? '')).toBe(DAY)
    expect(ms(supplier?.end ?? '') - ms(supplier?.start ?? '')).toBeGreaterThan(23 * 60 * MINUTE)
    expect(rel(t, queue?.start ?? '')).toBe(DAY + 3 * SECOND)
    expect(rel(t, queue?.end ?? '')).toBe(DAY + 153 * SECOND)
    expect(ms(idle?.end ?? '') - ms(idle?.start ?? '')).toBeGreaterThan(MINUTE)
    for (const g of t.gaps) expect(ms(g.end) - ms(g.start)).toBeGreaterThan(60 * SECOND)
    const gapMs = t.gaps.reduce((s, g) => s + ms(g.end) - ms(g.start), 0)
    expect(t.totals.active_ms).toBe(t.totals.duration_ms - gapMs)
    expect(t.totals.active_ms).toBeLessThan(10 * MINUTE)
  })

  it('totales: llamadas, caché y costo', () => {
    const calls = ofKind(t, 'model_call')
    expect(t.totals.model_calls).toBe(calls.length)
    expect(calls).toHaveLength(9)
    expect(t.totals.cache_hits).toBe(0)
    expect(t.totals.cost_usd).toBeCloseTo(0.09, 6)
  })

  it('avisos de lo que no se pudo saber', () => {
    expect(t.limitations.some((l) => l.includes('reintentos de la cola'))).toBe(true)
    expect(t.limitations.some((l) => l.includes('por inferencia'))).toBe(true)
    // every call has an exchange: no inferred-calls warning
    expect(t.limitations.some((l) => l.includes('sin fila de intercambio') || l.includes('no tienen fila de intercambio'))).toBe(false)
  })
})

describe('buildTimeline: llamadas al modelo y páginas', () => {
  it('empareja cada intercambio con la llamada del payload de su documento (latencia y orden) para saber las páginas', () => {
    const t = buildTimeline(whatsappSources())
    const calls = ofKind(t, 'model_call')
    const tx = calls.filter((c) => c.purpose === 'transactions')
    expect(tx).toHaveLength(2)
    // both start together; the 15 s one read pages 1-2 and the 18 s one page 3
    const a = tx.find((c) => c.latency_ms === 15000)
    const b = tx.find((c) => c.latency_ms === 18000)
    expect(a?.pages).toEqual([1, 2])
    expect(b?.pages).toEqual([3])
    expect(a?.exchange_id).toBe('x-ext-tx-a')
    expect(a?.id).toBe('llm_exchanges:x-ext-tx-a')
    expect(a?.source).toEqual({ table: 'llm_exchanges', id: 'x-ext-tx-a' })
    expect(a?.document_index).toBe(0)
    expect(calls.find((c) => c.purpose === 'summary')?.pages).toEqual([])
    // calls that are not about the document
    for (const p of ['classify_transactions', 'clarification_questions', 'next_steps', 'explanation']) {
      const c = calls.find((x) => x.purpose === p)
      expect(c?.document_index).toBeNull()
      expect(c?.pages).toEqual([])
    }
  })

  it('el inicio sale de la hora guardada y la latencia (hoy created_at es el inicio) y el fin es el inicio más la latencia', () => {
    expect(EXCHANGE_CREATED_AT_MARKS).toBe('start')
    const t = buildTimeline(whatsappSources())
    const c = byId(t, 'llm_exchanges:x-ext-tx-b')
    expect(c.precision).toBe('exact')
    expect(rel(t, c.start)).toBe(110 * SECOND)
    expect(rel(t, c.end ?? '')).toBe(128 * SECOND)
    const i = byId(t, 'llm_exchanges:x-interpret')
    expect(i.kind === 'model_call' && i.document_index).toBeNull()
    expect(i.chapter).toBe(byId(t, 'inbound_messages:in-2').chapter)
  })

  it('con otra marca de tiempo conserva el emparejamiento (solo se mueve el inicio)', () => {
    // The matching test does not depend on the mark: latency_ms decides anyway.
    const t = buildTimeline(sampleTimelineSources('api'))
    const tx = ofKind(t, 'model_call').filter((c) => c.purpose === 'transactions')
    expect(tx.map((c) => [c.latency_ms, c.pages]).sort()).toEqual([
      [15000, [1, 2]],
      [18000, [3]],
    ])
  })

  it('los aciertos de caché y el costo suman', () => {
    const t = buildTimeline(sampleTimelineSources('api'))
    expect(t.totals.cache_hits).toBe(1)
    expect(t.totals.model_calls).toBe(7)
    expect(t.totals.cost_usd).toBeCloseTo(0.06, 6)
    expect(ofKind(t, 'model_call').find((c) => c.cache_hit)?.purpose).toBe('next_steps')
  })

  it('un intercambio con error no se empareja con ninguna llamada del payload', () => {
    const src = sampleTimelineSources('api')
    src.exchanges.push(exchange('x-err', { startMs: 15 * SECOND, purpose: 'transactions', latencyMs: 15000, sha: 'a'.repeat(64), outcome: 'error' }))
    const t = buildTimeline(src)
    const err = ofKind(t, 'model_call').find((c) => c.exchange_id === 'x-err')
    expect(err).toMatchObject({ outcome: 'error', error_code: 'invalid_output', pages: [], input_tokens: 0 })
    expect(ofKind(t, 'model_call').filter((c) => c.purpose === 'transactions' && c.outcome === 'ok').map((c) => c.pages).sort()).toEqual([[1, 2], [3]])
  })
})

describe('buildTimeline: documentos y páginas', () => {
  it('páginas con movimientos, issues y el peor estado de verificación', () => {
    const t = buildTimeline(whatsappSources())
    expect(t.documents).toEqual([
      {
        document_id: 'doc-1',
        origin: 'submitted',
        page_count: 3,
        route: 'text_and_vision',
        extraction_status: 'complete',
        pages: [
          { page: 1, transactions: 2, issues: 0, verification: 'verified' },
          { page: 2, transactions: 1, issues: 1, verification: 'conflict' },
          { page: 3, transactions: 0, issues: 0, verification: 'none' },
        ],
      },
    ])
  })

  it('verificación: cuenta los valores, las páginas con issues y las banderas, al terminar la extracción', () => {
    const t = buildTimeline(whatsappSources())
    const v = ofKind(t, 'verification')[0]
    expect(v).toMatchObject({ lane: 'workflow', precision: 'exact', document_index: 0, extraction_status: 'complete', conflict: 1, pages_with_issues: [2], flags: ['multi_account', 'multi_period'] })
    expect((v?.verified ?? 0) + (v?.unverified ?? 0) + (v?.conflict ?? 0)).toBeGreaterThan(5)
    expect(rel(t, v?.start ?? '')).toBe(130 * SECOND)
  })

  it('una solicitud sin extracción deja el documento sin páginas', () => {
    const src = sampleTimelineSources('api')
    const doc = src.documents[0]
    if (!doc) throw new Error('falta el documento')
    doc.extraction = null
    const t = buildTimeline(src)
    expect(t.documents[0]).toMatchObject({ page_count: null, route: null, extraction_status: null, pages: [] })
  })
})

describe('buildTimeline: llegada por la API', () => {
  const t = buildTimeline(sampleTimelineSources('api'))

  it('origen api, un solo trabajo, sin aclaración ni tramos sin actividad', () => {
    expect(ofKind(t, 'application_created')[0]?.origin).toBe('api')
    expect(ofKind(t, 'job_finished').map((j) => j.job)).toEqual(['process'])
    expect(ofKind(t, 'clarification_opened')).toHaveLength(0)
    expect(ofKind(t, 'workflow_suspended')).toHaveLength(0)
    expect(ofKind(t, 'inbound_message')).toHaveLength(0)
    expect(t.gaps).toEqual([])
    expect(t.totals.active_ms).toBe(t.totals.duration_ms)
    expect(t.chapters.map((c) => c.title)).toEqual(['Recepción', 'Extracción', 'Movimientos', 'Decisión · ronda 1', 'Explicación', 'Veredicto'])
  })

  it('la cola espera de la creación a la extracción y el cierre es el último evento', () => {
    const wait = ofKind(t, 'queue_wait')[0]
    expect(rel(t, wait?.start ?? '')).toBe(0)
    expect(rel(t, wait?.end ?? '')).toBe(5 * SECOND)
    expect(wait?.precision).toBe('derived')
    expect(t.events.at(-1)?.kind).toBe('job_finished')
    expect(step(t, 'finalize')[0]?.precision).toBe('inferred')
    expect(step(t, 'explain')[0]?.precision).toBe('exact')
  })
})

describe('buildTimeline: extracción anterior al registro de llamadas (sin intercambios)', () => {
  const t = buildTimeline(sampleTimelineSources('legacy'))
  const calls = ofKind(t, 'model_call')

  it('crea las llamadas inferidas, sin exchange_id, dentro de la ventana de la extracción', () => {
    expect(calls).toHaveLength(5)
    expect(calls.every((c) => c.precision === 'inferred' && c.exchange_id === null && c.lane === 'models')).toBe(true)
    const extract = step(t, 'extract')[0]
    for (const c of calls) {
      expect(ms(c.start)).toBeGreaterThanOrEqual(ms(extract?.start ?? ''))
      expect(ms(c.end ?? '')).toBeLessThanOrEqual(ms(extract?.end ?? ''))
    }
  })

  it('resumen y clasificación en secuencia, movimientos en paralelo, relectura al final, con sus páginas', () => {
    const by = (p: string) => calls.filter((c) => c.purpose === p)
    const classify = by('classify')[0]
    const summary = by('summary')[0]
    const [tx1, tx2] = by('transactions')
    const retry = by('retry_page')[0]
    expect(ms(classify?.start ?? '')).toBe(ms(step(t, 'extract')[0]?.start ?? ''))
    expect(summary?.start).toBe(classify?.end)
    expect(tx1?.start).toBe(summary?.end)
    expect(tx2?.start).toBe(tx1?.start)
    expect(ms(retry?.start ?? '')).toBe(Math.max(ms(tx1?.end ?? ''), ms(tx2?.end ?? '')))
    expect(tx1?.pages).toEqual([1, 2])
    expect(tx2?.pages).toEqual([3])
    expect(retry?.pages).toEqual([2])
    expect(retry?.document_index).toBe(0)
    // its duration is its latency_ms
    expect(ms(summary?.end ?? '') - ms(summary?.start ?? '')).toBe(8000)
  })

  it('avisa que las llamadas se colocaron por inferencia y cuenta su costo', () => {
    expect(t.limitations.some((l) => l.startsWith('5 llamada(s) al modelo no tienen fila de intercambio'))).toBe(true)
    expect(t.totals.model_calls).toBe(5)
    expect(t.totals.cost_usd).toBeCloseTo(0.05, 6)
  })

  it('recorta a la ventana si las latencias no caben', () => {
    const src = sampleTimelineSources('legacy')
    const payload = src.documents[0]?.extraction?.payload
    if (!payload) throw new Error('falta la extracción')
    payload.extraction.calls = payload.extraction.calls.map((c) => ({ ...c, latency_ms: 600_000 }))
    const clipped = buildTimeline(src)
    const extract = step(clipped, 'extract')[0]
    for (const c of ofKind(clipped, 'model_call')) {
      expect(ms(c.start)).toBeGreaterThanOrEqual(ms(extract?.start ?? ''))
      expect(ms(c.end ?? '')).toBeLessThanOrEqual(ms(extract?.end ?? ''))
    }
    expect(ApplicationTimeline.safeParse(clipped).success).toBe(true)
  })

  it('mezcla: las llamadas con intercambio quedan exactas y solo las demás se infieren', () => {
    const src = sampleTimelineSources('legacy')
    src.exchanges.push(exchange('x-summary', { startMs: 6 * SECOND, purpose: 'summary', latencyMs: 8000, sha: 'a'.repeat(64) }))
    const mixed = buildTimeline(src)
    const m = ofKind(mixed, 'model_call')
    expect(m).toHaveLength(5)
    expect(m.filter((c) => c.precision === 'exact').map((c) => c.purpose)).toEqual(['summary'])
    expect(m.filter((c) => c.precision === 'inferred')).toHaveLength(4)
    expect(mixed.limitations.some((l) => l.startsWith('4 llamada(s)'))).toBe(true)
  })
})

describe('buildTimeline: falla por no ser estado de cuenta', () => {
  const t = buildTimeline(sampleTimelineSources('failed'))

  it('termina en el capítulo de falla y no corre los pasos de después de la extracción', () => {
    expect(ofKind(t, 'job_finished')[0]).toMatchObject({ application_status: 'failed', job: 'process' })
    expect(t.status).toBe('failed')
    const done = ofKind(t, 'job_finished')[0]
    expect(t.chapters.find((c) => c.id === done?.chapter)?.title).toBe('Falla')
    expect(step(t, 'extract')).toHaveLength(1)
    for (const s of ['classify-transactions', 'decide', 'explain', 'finalize']) expect(step(t, s)).toHaveLength(0)
    expect(ofKind(t, 'decision')).toHaveLength(0)
    expect(t.documents[0]).toMatchObject({ extraction_status: 'failed' })
    expect(ofKind(t, 'verification')[0]?.extraction_status).toBe('failed')
  })

  it('empareja la clasificación con su intercambio', () => {
    const c = ofKind(t, 'model_call')
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ purpose: 'classify', exchange_id: 'x-classify', precision: 'exact', document_index: 0 })
  })

  it('sin fila que cierre el trabajo, la falla se toma de la solicitud y se avisa', () => {
    const src = sampleTimelineSources('failed')
    src.audit = src.audit.filter((a) => a.action !== 'application.success')
    src.documents = []
    src.exchanges = []
    const bare = buildTimeline(src)
    const done = ofKind(bare, 'job_finished')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ job: null, application_status: 'failed', source: { table: 'applications', id: SAMPLE_APPLICATION_ID } })
    expect(bare.chapters.some((c) => c.title === 'Falla')).toBe(true)
    expect(bare.limitations.some((l) => l.includes('falló sin dejar'))).toBe(true)
  })
})

describe('buildTimeline: oferta del monto y reevaluación', () => {
  const t = buildTimeline(sampleTimelineSources('offer'))

  it('el segundo trabajo es una reevaluación, sin pasos de workflow ni espera en cola', () => {
    expect(ofKind(t, 'job_finished').map((j) => j.job)).toEqual(['process', 'redecide'])
    expect(ofKind(t, 'queue_wait').map((w) => w.job)).toEqual(['process'])
    expect(ofKind(t, 'workflow_step').every((s) => ms(s.start) < ms(at(10 * MINUTE).toISOString()))).toBe(true)
    const decisions = ofKind(t, 'decision')
    expect(decisions).toHaveLength(2)
    // the re-evaluation decision is placed at the close of its job
    expect(rel(t, decisions[1]?.start ?? '')).toBe(10 * MINUTE + 4 * SECOND)
    expect(decisions[1]?.precision).toBe('inferred')
  })

  it('capítulos: oferta, reevaluación y el veredicto nuevo', () => {
    const titles = t.chapters.map((c) => c.title)
    expect(titles).toContain('Oferta del monto')
    expect(titles).toContain('Reevaluación')
    expect(titles.slice(-3)).toEqual(['Oferta del monto', 'Reevaluación', 'Veredicto'])
    const offer = ofKind(t, 'inbound_message').find((m) => m.resolution === 'offer_accepted')
    expect(t.chapters.find((c) => c.id === offer?.chapter)?.kind).toBe('offer')
    const redecide = ofKind(t, 'job_finished').find((j) => j.job === 'redecide')
    expect(t.chapters.find((c) => c.id === redecide?.chapter)?.kind).toBe('redecide')
    expect(ofKind(t, 'verdict_queued')).toHaveLength(2)
  })

  it('la espera de la oferta es un tramo esperando al proveedor', () => {
    expect(t.gaps).toHaveLength(1)
    expect(t.gaps[0]?.reason).toBe('waiting_supplier')
    expect(rel(t, t.gaps[0]?.end ?? '')).toBe(10 * MINUTE)
  })
})

describe('buildTimeline: casos límite', () => {
  it('una aclaración sin contestar espera al proveedor hasta el final de la línea', () => {
    const src = whatsappSources()
    const jobTwo = src.audit.find((a) => a.id === 'au-job-2')
    const keep = new Set(['au-in-1', 'au-recv', 'au-in-2', 'au-in-3', 'au-job-1'])
    src.audit = src.audit.filter((a) => keep.has(a.id))
    src.audit.push(auditRow({ id: 'au-view', actor: 'user:u-1', action: 'application.viewed', details: {}, atMs: 2 * 60 * MINUTE }))
    src.inbound = src.inbound.filter((m) => m.id !== 'in-4')
    src.outbound = src.outbound.filter((o) => o.id !== 'out-5')
    src.decisions = src.decisions.slice(0, 1)
    src.exchanges = src.exchanges.filter((e) => e.purpose !== 'next_steps' && e.purpose !== 'explanation')
    src.clarifications = [{ ...(src.clarifications[0] ?? failMissing()), status: 'open', answeredAt: null, answers: 0 }]
    src.application = { ...src.application, status: 'needs_clarification' }
    expect(jobTwo).toBeDefined()
    const t = buildTimeline(src)
    expect(ofKind(t, 'clarification_answered')).toHaveLength(0)
    const suspended = ofKind(t, 'workflow_suspended')[0]
    expect(rel(t, suspended?.start ?? '')).toBe(138 * SECOND)
    expect(rel(t, suspended?.end ?? '')).toBe(2 * 60 * MINUTE)
    expect(t.gaps).toHaveLength(1)
    expect(t.gaps[0]?.reason).toBe('waiting_supplier')
    expect(ofKind(t, 'job_finished').map((j) => j.job)).toEqual(['process'])
  })

  it('una solicitud en revisión humana que espera al analista', () => {
    const src = sampleTimelineSources('api')
    src.application = { ...src.application, status: 'human_review' }
    const end = src.audit.find((a) => a.action === 'application.success')
    if (end) end.details = { status: 'human_review' }
    src.decisions = [{ ...(src.decisions[0] ?? failMissing()), status: 'human_review' }]
    src.audit.push(auditRow({ id: 'au-corr', actor: 'user:u-9', action: 'correction.recorded', details: { corrections: 2, targets: ['holder.rfc'] }, atMs: 30 * MINUTE }))
    src.corrections = [{ id: 'co-1', documentId: 'doc-1', target: 'holder.rfc', page: 1, createdAt: at(30 * MINUTE) }]
    const t = buildTimeline(src)
    expect(t.gaps).toHaveLength(1)
    expect(t.gaps[0]?.reason).toBe('waiting_analyst')
    const c = ofKind(t, 'correction')[0]
    expect(c).toMatchObject({ lane: 'analyst', document_index: 0, page: 1, target: 'holder.rfc' })
    expect(ofKind(t, 'analyst_action')[0]?.label).toBe('El analista registró 2 corrección(es)')
    expect(t.chapters.at(-1)?.title).toBe('Revisión del analista')
  })

  it('el resultado del analista no se cuenta dos veces (fila y bitácora)', () => {
    const src = sampleTimelineSources('api')
    src.outcomes = [{ id: 'o-1', createdAt: at(10 * MINUTE) }]
    src.audit.push(auditRow({ id: 'au-out', actor: 'user:u-9', action: 'outcome.recorded', details: { outcome: 'paid' }, atMs: 10 * MINUTE + 100 }))
    const t = buildTimeline(src)
    const actions = ofKind(t, 'analyst_action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.id).toBe('outcomes:o-1')
  })

  it('un trabajo en curso muestra sus llamadas aunque todavía no haya cierre ni extracción guardada', () => {
    const src = sampleTimelineSources('api')
    src.application = { ...src.application, status: 'extracting' }
    src.audit = src.audit.filter((a) => a.action === 'application.received')
    src.decisions = []
    src.documents = src.documents.map((d) => ({ ...d, extraction: null }))
    const t = buildTimeline(src)
    expect(ofKind(t, 'job_finished')).toHaveLength(0)
    expect(ofKind(t, 'model_call')).toHaveLength(7)
    expect(t.limitations.some((l) => l.includes('en curso'))).toBe(true)
    expect(ApplicationTimeline.safeParse(t).success).toBe(true)
  })

  it('lee con tolerancia payloads viejos o dañados', () => {
    const src = whatsappSources()
    src.decisions = [
      { id: 'd-old', kind: 'active', status: 'qualified', policyVersion: null, createdAt: at(DAY + 14 * SECOND + 153 * SECOND), payload: { status: 'qualified', evaluation: { gates: [{ id: 'x' }, 'basura', { id: 'g', outcome: 'pass', effect: 'none' }], dimensions: 3 } } },
      { id: 'd-null', kind: 'shadow', status: 'human_review', policyVersion: 2, createdAt: at(DAY + 14 * SECOND + 153 * SECOND), payload: null },
      { id: 'd-bad', kind: 'shadow', status: 'no_es_un_estado', policyVersion: 2, createdAt: at(DAY + 14 * SECOND + 153 * SECOND), payload: 'texto' },
    ]
    const doc = src.documents[0]
    if (!doc?.extraction) throw new Error('falta la extracción')
    doc.extraction = { ...doc.extraction, payload: JSON.parse('{"extraction":{"calls":[{"purpose":"summary"}]}}') as typeof doc.extraction.payload }
    const t = buildTimeline(src)
    const decisions = ofKind(t, 'decision')
    expect(decisions.map((d) => d.decision_id)).toEqual(['d-old', 'd-null'])
    expect(decisions[0]).toMatchObject({ gates: [{ id: 'g', outcome: 'pass', effect: 'none' }], dimensions: [], policy_version: null, has_limit: false, score: null })
    expect(t.documents[0]).toMatchObject({ page_count: null, pages: [] })
    expect(ApplicationTimeline.safeParse(t).success).toBe(true)
  })

  it('una entrada vacía de eventos aún produce la solicitud creada', () => {
    const t = buildTimeline({ application: { id: 'x', status: 'received', createdAt: at(0), updatedAt: at(0), failureReason: null }, documents: [], inbound: [], outbound: [], audit: [], exchanges: [], decisions: [], clarifications: [], corrections: [], outcomes: [] })
    expect(t.events.map((e) => e.kind)).toEqual(['application_created'])
    expect(t.events[0]).toMatchObject({ origin: 'unknown' })
    expect(t.totals).toEqual({ duration_ms: 0, active_ms: 0, model_calls: 0, cache_hits: 0, cost_usd: 0 })
    expect(t.limitations).toEqual([])
  })
})

describe('buildTimeline: documento de la respuesta dentro de la reanudación', () => {
  const resumeStart = DAY + 153 * SECOND
  const owner = 'c'.repeat(64)
  const src = whatsappSources()
  const shift = (d: Date, to: number): Date => (d.getTime() === at(resumeStart + 14 * SECOND).getTime() ? at(to) : d)
  const end = resumeStart + 45 * SECOND
  src.documents.push({
    documentId: 'doc-2',
    origin: 'owner_answer',
    createdAt: at(DAY),
    sha256: owner,
    extraction: { id: 'ext-2', createdAt: at(end), payload: extractionPayload({ sha: owner, startMs: resumeStart, finishMs: resumeStart + 20 * SECOND, calls: [{ purpose: 'classify', latencyMs: 2000 }, { purpose: 'summary', latencyMs: 8000 }] }) },
  })
  src.exchanges = src.exchanges.map((e) => (e.purpose === 'next_steps' || e.purpose === 'explanation' ? { ...e, createdAt: new Date(e.createdAt.getTime() + 30 * SECOND) } : e))
  src.exchanges.push(exchange('x-own-classify', { startMs: resumeStart, purpose: 'classify', latencyMs: 2000, sha: owner }))
  src.audit = src.audit.map((a) => (a.id === 'au-job-2' || a.id === 'au-verdict' ? { ...a, at: shift(a.at, end) } : a))
  src.decisions = src.decisions.map((d) => ({ ...d, createdAt: shift(d.createdAt, end) }))
  const t = buildTimeline(src)

  it('el documento queda como owner_answer y su extracción pertenece a la reanudación', () => {
    expect(t.documents.map((d) => d.origin)).toEqual(['submitted', 'owner_answer'])
    const extract = step(t, 'extract').find((e) => e.id.endsWith(':1'))
    expect(extract).toMatchObject({ precision: 'exact', round: 1 })
    expect(t.chapters.find((c) => c.id === extract?.chapter)?.title).toBe('Reanudación · ronda 1')
    expect(ofKind(t, 'verification').map((v) => v.document_index)).toEqual([0, 1])
  })

  it('apply-answers contiene la extracción y las llamadas se emparejan con el documento de la respuesta', () => {
    const apply = step(t, 'apply-answers')[0]
    const extract = step(t, 'extract').find((e) => e.id.endsWith(':1'))
    expect(ms(apply?.start ?? '')).toBe(ms(extract?.start ?? ''))
    expect(ms(apply?.end ?? '')).toBeGreaterThanOrEqual(ms(extract?.end ?? ''))
    const own = ofKind(t, 'model_call').filter((c) => c.document_index === 1)
    expect(own.map((c) => [c.purpose, c.precision]).sort()).toEqual([['classify', 'exact'], ['summary', 'inferred']])
    expect(ofKind(t, 'job_finished').map((j) => j.job)).toEqual(['process', 'resume'])
    expect(ApplicationTimeline.safeParse(t).success).toBe(true)
  })
})

function failMissing(): never {
  throw new Error('falta una fila del ejemplo')
}
