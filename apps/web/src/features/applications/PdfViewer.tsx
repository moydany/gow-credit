/**
 * Document viewer: pdf.js on the page the extraction points to. When a value carries its literal
 * snippet (`source.snippet`), it is searched in the page's text layer and highlighted; the color
 * shows verified, unverified or conflicting. A document without a usable text layer (HSBC,
 * vision-only) shows the page unhighlighted and says so.
 */
import clsx from 'clsx'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useMemo, useRef, useState } from 'react'
import { documentUrl } from '../../lib/api'
import { Icon } from '../../ui/icons'
import { IconButton, Skeleton } from '../../ui/primitives'
import { locate, norm } from './locate'
import type { PageAlert } from './pageAlerts'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type Tone = 'verified' | 'unverified' | 'conflict'
export interface PdfFocus {
  page: number
  snippet: string | null
  tone: Tone
  /** Changes on every click, so the same value can be highlighted again. */
  nonce: number
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface RenderedTextItem {
  str: string
  transform: number[]
  width: number
}

function computeHighlightBoxes(
  items: RenderedTextItem[],
  snippet: string | null,
  viewport: { transform: number[] },
  scale: number,
): { flatLength: number; boxes: Box[] } {
  let flat = ''
  const owner: number[] = []
  items.forEach((it, idx) => {
    const n = norm(it.str)
    for (let k = 0; k < n.length; k++) owner.push(idx)
    flat += n
  })
  if (flat.length < 20 || !snippet) return { flatLength: flat.length, boxes: [] }
  const hit = locate(flat, snippet)
  if (!hit) return { flatLength: flat.length, boxes: [] }
  const used = new Set(owner.slice(hit.start, hit.end))
  const boxes: Box[] = []
  for (const idx of used) {
    const it = items[idx]
    if (!it || !it.str.trim()) continue
    const t = pdfjs.Util.transform(viewport.transform, it.transform) as number[]
    const h = Math.hypot(t[2] ?? 0, t[3] ?? 0)
    boxes.push({ left: (t[4] ?? 0) - 2, top: (t[5] ?? 0) - h * 0.9, width: it.width * scale + 4, height: h * 1.15 })
  }
  return { flatLength: flat.length, boxes }
}

export function PdfViewer({ documentId, focus, onPage, alerts, onAlert }: { documentId: string; focus: PdfFocus; onPage: (page: number) => void; alerts: ReadonlyMap<number, readonly PageAlert[]>; onAlert: (page: number, alert: PageAlert) => void }) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [noText, setNoText] = useState(false)
  const [width, setWidth] = useState(0)
  const [rendering, setRendering] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const page = focus.page

  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setError(null)
    const task = pdfjs.getDocument({ url: documentUrl(documentId), withCredentials: true })
    task.promise.then(
      (doc) => { if (!cancelled) setPdf(doc) },
      (e: unknown) => {
        // StrictMode mounts, unmounts and mounts again: the first attempt's abort is not an error.
        if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo abrir el PDF')
      },
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [documentId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.floor(e.contentRect.width))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])

  const pageCount = pdf?.numPages ?? 0
  const current = Math.min(Math.max(page, 1), Math.max(pageCount, 1))

  useEffect(() => {
    if (!pdf || !width) return
    const ctl = { cancelled: false }
    const stopped = () => ctl.cancelled
    let task: pdfjs.RenderTask | null = null
    setRendering(true)
    void (async () => {
      const p = await pdf.getPage(current)
      const base = p.getViewport({ scale: 1 })
      const scale = ((width - 8) / base.width) * zoom
      const viewport = p.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas || stopped()) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${String(viewport.width)}px`
      canvas.style.height = `${String(viewport.height)}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      task = p.render({ canvasContext: ctx, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0], canvas })
      await task.promise.catch(() => undefined)
      if (stopped()) return
      setRendering(false)

      // Highlight the cited snippet.
      const content = await p.getTextContent()
      const items = content.items.filter((i): i is Extract<typeof i, { str: string }> => 'str' in i)
      const { flatLength, boxes: snippetBoxes } = computeHighlightBoxes(items, focus.snippet, viewport, scale)
      setNoText(flatLength < 20)
      setBoxes(snippetBoxes)
    })()
    return () => {
      ctl.cancelled = true
      task?.cancel()
    }
    // `focus.nonce` forces the highlight even when the same value is requested twice.
  }, [pdf, current, width, zoom, focus.snippet, focus.nonce])

  useEffect(() => {
    const first = boxes[0]
    const sc = scrollRef.current
    if (first && sc) sc.scrollTo({ top: Math.max(first.top - sc.clientHeight / 3, 0), behavior: 'smooth' })
  }, [boxes])

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount])
  const toneClass = { verified: 'bg-accent/25 outline-accent-ink/40', unverified: 'hatch-amber outline-amber/80', conflict: 'hatch-coral outline-coral/80' }[focus.tone]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <IconButton icon="left" label="Página anterior" disabled={current <= 1} onClick={() => { onPage(current - 1) }} />
        <p className="tnum min-w-24 text-center text-[14px] font-medium" aria-live="polite">
          Página {current}
          <span className="text-muted"> / {pageCount || '—'}</span>
        </p>
        <IconButton icon="right" label="Página siguiente" disabled={current >= pageCount} onClick={() => { onPage(current + 1) }} />
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton icon="zoomOut" label="Alejar" disabled={zoom <= 0.6} onClick={() => { setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1))) }} />
          <IconButton icon="zoomIn" label="Acercar" disabled={zoom >= 2.4} onClick={() => { setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1))) }} />
        </div>
      </div>

      {pages.length > 1 ? (
        <div className="scroll-thin flex gap-1 overflow-x-auto px-4 pb-3" role="group" aria-label="Páginas">
          {pages.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => { onPage(n) }}
              aria-current={n === current ? 'page' : undefined}
              title={alerts.has(n) ? `Página ${String(n)}: tiene valores por revisar` : `Página ${String(n)}`}
              className={clsx('tnum relative h-8 min-w-8 shrink-0 rounded-full px-2 text-[12px] font-medium transition-colors', n === current ? 'bg-ink text-white' : alerts.has(n) ? 'hatch-amber text-amber-ink hover:brightness-95' : 'bg-sunken text-ink-2 hover:bg-line')}
            >
              {n}
              {/* The page on screen keeps its mark. */}
              {n === current && alerts.has(n) ? <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-amber" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      <PageReview page={current} items={alerts.get(current) ?? []} onAlert={onAlert} />

      <div ref={scrollRef} className="scroll-thin relative min-h-0 flex-1 overflow-auto rounded-b-[27px] bg-sunken px-1 pb-4 pt-1">
        {error ? (
          <p role="alert" className="m-6 rounded-2xl bg-coral-soft p-4 text-[13.5px] text-coral-ink">
            No se pudo abrir el PDF: {error}
          </p>
        ) : !pdf ? (
          <Skeleton className="m-3 h-[600px]" />
        ) : (
          <div ref={wrapRef} className="relative mx-auto w-fit">
            <canvas ref={canvasRef} className={clsx('block rounded-md bg-white shadow-[0_2px_14px_rgb(20_23_31/0.14)] transition-opacity', rendering && 'opacity-60')} />
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              {boxes.map((b, i) => (
                <div key={`${String(focus.nonce)}-${String(i)}`} className={clsx('animate-fade absolute rounded-[5px] outline outline-2 mix-blend-multiply', toneClass)} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
              ))}
            </div>
          </div>
        )}
        {noText && !error ? (
          <p className="mx-4 mt-3 flex items-start gap-2 rounded-2xl bg-card p-3 text-[12.5px] text-muted">
            <Icon name="eye" size={15} className="mt-0.5 shrink-0" /> Esta página no tiene texto seleccionable (se leyó por visión): el valor se ubica por número de página, sin resaltado.
          </p>
        ) : focus.snippet && boxes.length === 0 && !rendering ? (
          <p className="mx-4 mt-3 flex items-start gap-2 rounded-2xl bg-card p-3 text-[12.5px] text-muted">
            <Icon name="search" size={15} className="mt-0.5 shrink-0" /> No se encontró el fragmento citado en esta página; revísalo a ojo.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** What is marked on the page on screen, and why; a click shows it on the page. */
function PageReview({ page, items, onAlert }: { page: number; items: readonly PageAlert[]; onAlert: (page: number, alert: PageAlert) => void }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div className="mx-4 mb-3 rounded-2xl bg-amber-soft px-3.5 py-2.5 text-[12.5px] text-amber-ink">
      <button type="button" className="flex w-full items-center gap-2 text-left font-medium" aria-expanded={open} onClick={() => { setOpen((o) => !o) }}>
        <Icon name="help" size={14} className="shrink-0" />
        <span className="flex-1">{items.length === 1 ? 'Esta página tiene 1 cosa por revisar' : `Esta página tiene ${String(items.length)} cosas por revisar`}</span>
        <Icon name="down" size={14} className={clsx('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <ul className="scroll-thin mt-2 max-h-48 space-y-1.5 overflow-y-auto">
          {items.map((a, i) => (
            <li key={`${a.label}-${String(i)}`}>
              <button type="button" className="w-full rounded-xl bg-white/70 px-3 py-2 text-left hover:bg-white" onClick={() => { onAlert(page, a) }}>
                <span className="block font-medium text-ink">{a.label}</span>
                <span className="block text-ink-2">{a.reason}{a.snippet ? '' : '. No hay un fragmento que resaltar: búscalo a ojo en la página.'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
