/**
 * Etiquetas HTML proyectadas sobre el lienzo (la CSP no permite fuentes remotas). Se colocan por
 * prioridad (capas, estaciones, orbes); la que choca con una ya puesta se oculta.
 */
import type * as THREE from 'three'

export type LabelKind = 'layer' | 'station' | 'orb'
interface Label {
  el: HTMLElement
  pos: THREE.Vector3
  kind: LabelKind
  anchor: 'center' | 'right'
  /** Ancho medido (se lee una vez). */
  w: number
  model?: string
}
type Box = { x0: number; x1: number; y0: number; y1: number }

const BASE = 'position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;will-change:transform;font-family:var(--font-sans);font-size:12px;'
const STYLE: Record<LabelKind, string> = {
  layer: 'font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#3b404b;',
  station: 'font-weight:500;color:#3b404b;',
  orb: 'font-weight:500;color:#3a47d1;background:rgba(252,252,252,.92);padding:2px 8px;border-radius:99px;',
}
const ORDER: LabelKind[] = ['layer', 'station', 'orb']

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0

export class LabelLayer {
  private readonly labels: Label[] = []

  constructor(private readonly layer: HTMLElement) {}

  add(text: string, pos: THREE.Vector3, kind: LabelKind, anchor: 'center' | 'right' = 'center', model?: string): void {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText = BASE + STYLE[kind]
    this.layer.appendChild(el)
    this.labels.push({ el, pos, kind, anchor, w: 0, ...(model ? { model } : {}) })
  }

  /** Coloca una etiqueta; devuelve su caja si quedó visible. */
  private placeOne(l: Label, camera: THREE.Camera, w: number, h: number, show: boolean, placed: Box[]): Box | null {
    const v = l.pos.clone().project(camera)
    const x = (v.x * 0.5 + 0.5) * w
    const y = (-v.y * 0.5 + 0.5) * h
    if (l.w === 0) l.w = l.el.offsetWidth
    const lw = l.w || 60
    const x0 = l.anchor === 'right' ? x - lw : x - lw / 2
    const box = { x0: x0 - 4, x1: x0 + lw + 4, y0: y - 10, y1: y + 10 }
    const inside = v.z < 1 && box.x0 > -4 && box.x1 < w + 4 && box.y0 > -4 && box.y1 < h + 4
    const visible = show && inside && !placed.some((p) => overlaps(box, p))
    l.el.style.visibility = visible ? 'visible' : 'hidden'
    if (!visible) return null
    l.el.style.transform = `translate(${String(Math.round(x0))}px, ${String(Math.round(y))}px) translateY(-50%)`
    return box
  }

  /** Los orbes solo muestran su etiqueta si están activos o bajo el puntero. */
  place(camera: THREE.Camera, w: number, h: number, active: Set<string | undefined>, hover: string | null): void {
    const placed: Box[] = []
    for (const kind of ORDER) {
      for (const l of this.labels.filter((x) => x.kind === kind)) {
        const show = kind !== 'orb' || (l.model !== undefined && (active.has(l.model) || hover === l.model))
        const box = this.placeOne(l, camera, w, h, show, placed)
        if (box) placed.push(box)
      }
    }
  }

  dispose(): void {
    for (const l of this.labels) l.el.remove()
    this.labels.length = 0
  }
}
