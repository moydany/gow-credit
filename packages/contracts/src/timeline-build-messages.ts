/**
 * Message rule: request created, incoming supplier messages and outgoing relay messages. Times
 * are those of their own rows (exact).
 */
import { addEvent, cut, ms, str, type Chap, type Ctx } from './timeline-build-base.ts'
import { verdictChapter } from './timeline-build-jobs.ts'
import { INBOUND_ES, ORIGIN_ES, OUTBOUND_ES } from './timeline-build-text.ts'
import type { TimelineInboundRow } from './timeline-sources.ts'

type Origin = keyof typeof ORIGIN_ES

const MEDIA_KINDS = ['image', 'audio', 'video', 'sticker'] as const
const DOCUMENT_RECEIVED = 'document_received'

function originOfActor(actor: string): Origin {
  if (actor.startsWith('inbound:')) {
    const ch = actor.slice('inbound:'.length)
    return ch === 'whatsapp' || ch === 'email' ? ch : 'unknown'
  }
  return actor.startsWith('user:') ? 'backoffice' : 'api'
}

/** The incoming message that brought the document: the one the log names or, failing that, the first with that result. */
function linkedInbound(ctx: Ctx, receivedId: string | null): TimelineInboundRow | undefined {
  const link = ctx.audit.find((a) => a.action === `inbound.${DOCUMENT_RECEIVED}` && a.details.application_id === ctx.app.id)
  const id = link?.subject ?? receivedId
  const byId = id ? ctx.inboundById.get(id) : undefined
  return byId ?? ctx.src.inbound.filter((m) => m.resolution === DOCUMENT_RECEIVED).sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt))[0]
}

function originOf(ctx: Ctx): Origin {
  const received = ctx.audit.find((a) => a.action === 'application.received' && a.subject === ctx.app.id)
  const inbound = linkedInbound(ctx, str(received?.details.inbound_message_id))
  if (inbound) return inbound.channel === 'manual' ? 'backoffice' : inbound.channel
  return received ? originOfActor(received.actor) : 'unknown'
}

export function emitCreated(ctx: Ctx): void {
  const { app } = ctx
  const origin = originOf(ctx)
  addEvent<'application_created'>(
    ctx,
    { id: `applications:${app.id}`, kind: 'application_created', lane: 'queue', precision: 'exact', label: `Solicitud creada${ORIGIN_ES[origin]}`, source: { table: 'applications', id: app.id }, origin },
    ms(app.createdAt),
    null,
    ctx.C.reception(),
  )
}

function inboundChapter(ctx: Ctx, m: TimelineInboundRow): Chap | null {
  const r = m.resolution ?? ''
  if (r.startsWith('registration_') || r === 'registered_idle') return ctx.C.registration()
  if (r.startsWith('intake_')) return ctx.C.intake()
  if (r.startsWith('offer_')) return ctx.C.offer()
  if (r === DOCUMENT_RECEIVED) return ctx.C.reception()
  const clar = m.clarificationId ? ctx.clarById.get(m.clarificationId) : undefined
  return clar ? ctx.C.clarification(clar.round) : null
}

function inboundLabel(resolution: string | null): string {
  if (resolution === null) return 'Mensaje del proveedor (sin procesar)'
  return INBOUND_ES[resolution] ?? `Mensaje del proveedor (${resolution})`
}

/** Messages whose reply Haiku read: the log says so, or a linked interpreter call exists. */
function interpretedIds(ctx: Ctx): Set<string> {
  const ids = new Set<string>()
  for (const a of ctx.audit) if (a.action.startsWith('inbound.') && a.details.interpreted === 'haiku' && a.subject !== null) ids.add(a.subject)
  for (const x of ctx.inboundExchanges) if (x.row.inboundMessageId) ids.add(x.row.inboundMessageId)
  return ids
}

export function emitInbound(ctx: Ctx): void {
  const interpreted = interpretedIds(ctx)
  for (const m of ctx.src.inbound) {
    const chap = inboundChapter(ctx, m)
    ctx.inboundChapters.set(m.id, chap)
    const media = MEDIA_KINDS.find((k) => k === m.mediaKind) ?? null
    const startMs = ms(m.receivedAt)
    addEvent<'inbound_message'>(
      ctx,
      { id: `inbound_messages:${m.id}`, kind: 'inbound_message', lane: 'supplier', precision: 'exact', label: inboundLabel(m.resolution), source: { table: 'inbound_messages', id: m.id }, channel: m.channel, resolution: m.resolution, has_document: m.hasDocument, media_kind: media, interpreted: interpreted.has(m.id) },
      startMs,
      m.processedAt ? Math.max(startMs, ms(m.processedAt)) : null,
      chap,
    )
  }
}

function outboundChapter(ctx: Ctx, kind: string, createdMs: number, clarificationId: string | null): Chap | null {
  if (kind === 'invoice') return ctx.C.intake()
  if (kind === 'registration') return ctx.C.registration()
  if (kind === 'verdict') return verdictChapter(ctx, createdMs)
  const clar = clarificationId ? ctx.clarById.get(clarificationId) : undefined
  return clar ? ctx.C.clarification(clar.round) : null
}

const DELIVERY_SUFFIX = { failed: ' (no se pudo enviar)', pending: ' (pendiente)', sent: '' } as const

export function emitOutbound(ctx: Ctx): void {
  for (const o of ctx.src.outbound) {
    const startMs = ms(o.createdAt)
    const label = cut(`${OUTBOUND_ES[o.kind] ?? `Mensaje (${o.kind})`}${DELIVERY_SUFFIX[o.status]}`)
    addEvent<'outbound_message'>(
      ctx,
      { id: `outbound_messages:${o.id}`, kind: 'outbound_message', lane: 'relay', precision: 'exact', label, source: { table: 'outbound_messages', id: o.id }, channel: o.channel, message_kind: o.kind, delivery: o.status, attempts: Math.max(0, o.attempts) },
      startMs,
      o.sentAt && ms(o.sentAt) >= startMs ? ms(o.sentAt) : null,
      outboundChapter(ctx, o.kind, startMs, o.clarificationId),
    )
  }
}

