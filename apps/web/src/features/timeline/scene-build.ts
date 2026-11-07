/** Construcción de la maqueta: placas, estaciones, losetas de páginas, orbes, compuertas, pilares y torre. */
import * as THREE from 'three'
import type { PageVerification, SceneLayout, ScenePick, StationId } from './scene-state'
import type { LabelLayer } from './scene-labels'
import { C, isVerdict, modelColor, PLATE_D, PLATE_T, PLATE_W, STATION_LABEL, STATION_POS, SURFACE, TILE_TILT, TOWER_X, Y } from './scene-config'

type Owner = <T extends { dispose: () => void }>(x: T) => T
type Mat = THREE.MeshStandardMaterial

export interface BuildCtx {
  scene: THREE.Scene
  own: Owner
  pickables: THREE.Object3D[]
  labels: LabelLayer
  relayMat: Mat
  relayEdgeMat: THREE.MeshBasicMaterial
  towerMat: Mat
}

export interface Stage {
  pageMats: Record<PageVerification, Mat>
  pageMeshes: Map<string, THREE.Mesh>
  orbs: Map<string, { mesh: THREE.Mesh; flash: THREE.Mesh; mat: Mat }>
  gates: Map<string, { group: THREE.Group; mat: Mat }>
  pillars: Map<string, { mesh: THREE.Mesh; mat: Mat; hatch: Mat; base: number }>
  stationDisks: Map<StationId, THREE.Mesh>
  tower: THREE.Mesh[]
}

const pickOf = (pick: ScenePick): ScenePick => pick

function makePageMaterials(own: Owner): Record<PageVerification, Mat> {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 32
  const g = cv.getContext('2d')
  if (g) {
    g.fillStyle = '#ececef'
    g.fillRect(0, 0, 32, 32)
    g.strokeStyle = 'rgba(20,23,31,.35)'
    g.lineWidth = 2
    for (let i = -32; i < 64; i += 8) {
      g.beginPath()
      g.moveTo(i, 32)
      g.lineTo(i + 32, 0)
      g.stroke()
    }
  }
  const tex = own(new THREE.CanvasTexture(cv))
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  const mk = (color: number, map?: THREE.Texture) => own(new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...(map ? { map } : {}) }))
  return { pending: mk(0xffffff, tex), verified: mk(C.lime), unverified: mk(C.amber), conflict: mk(C.coral), none: mk(0xdedee2) }
}

/** Número de página en un lienzo: el texto va en la geometría para que gire con la loseta. */
function numberTexture(own: Owner, n: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 96
  const g = cv.getContext('2d')
  if (g) {
    g.fillStyle = 'rgba(252,252,252,.92)'
    g.beginPath()
    g.arc(48, 48, 40, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#14171f'
    g.font = '600 46px "Geist Variable", ui-sans-serif, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(n), 48, 51)
  }
  const tex = own(new THREE.CanvasTexture(cv))
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Placa del tamaño del contenido. Las translúcidas no escriben profundidad y se pintan en orden fijo. */
function plate(ctx: BuildCtx, y: number, color: number, opacity: number, order: number, material?: Mat): void {
  const geo = ctx.own(new THREE.BoxGeometry(PLATE_W, PLATE_T, PLATE_D))
  const mat = material ?? ctx.own(new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.85, depthWrite: opacity >= 1 }))
  const m = new THREE.Mesh(geo, mat)
  m.position.set(0, y, 0)
  m.renderOrder = order
  ctx.scene.add(m)
  const edge = new THREE.LineSegments(ctx.own(new THREE.EdgesGeometry(geo)), ctx.own(new THREE.LineBasicMaterial({ color: C.plateEdge, transparent: true, depthWrite: false })))
  edge.position.copy(m.position)
  edge.renderOrder = order + 1
  ctx.scene.add(edge)
}

function buildPlates(ctx: BuildCtx): void {
  plate(ctx, Y.models, C.plate, 0.4, 1)
  plate(ctx, Y.worker, C.white, 1, 0)
  plate(ctx, Y.relay, C.indigo, 0.08, 3, ctx.relayMat)
  plate(ctx, Y.supplier, C.plate, 0.45, 5)

  // El borde del relay brilla cuando algo lo cruza (el relleno casi no se ve).
  const frameGeo = [ctx.own(new THREE.BoxGeometry(PLATE_W, 0.09, 0.09)), ctx.own(new THREE.BoxGeometry(0.09, 0.09, PLATE_D))]
  for (const [geo, x, z] of [[0, 0, PLATE_D / 2], [0, 0, -PLATE_D / 2], [1, PLATE_W / 2, 0], [1, -PLATE_W / 2, 0]] as const) {
    const bar = new THREE.Mesh(frameGeo[geo], ctx.relayEdgeMat)
    bar.position.set(x, Y.relay, z)
    bar.renderOrder = 4
    ctx.scene.add(bar)
  }

  // Teléfono del proveedor.
  const phone = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(1.3, 2.3, 0.2)), ctx.own(new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.4 })))
  phone.position.set(-11, Y.supplier + 1.25, -1.2)
  const screen = new THREE.Mesh(ctx.own(new THREE.PlaneGeometry(1.1, 1.95)), ctx.own(new THREE.MeshStandardMaterial({ color: C.lime, roughness: 0.6 })))
  screen.position.set(-11, Y.supplier + 1.25, -1.09)
  ctx.scene.add(phone, screen)

  // Las capas se nombran a la izquierda, fuera de las placas.
  const left = -PLATE_W / 2 - 0.6
  const layers: [string, number][] = [['Proveedor', Y.supplier], ['Relay · buzón', Y.relay], ['Worker · workflow', Y.worker], ['Modelos', Y.models]]
  for (const [name, y] of layers) ctx.labels.add(name, new THREE.Vector3(left, y, 0), 'layer', 'right')
}

const STATION_DISKS: StationId[] = ['extract', 'classify-transactions', 'decide', 'ask-owner', 'explain', 'verdict_ok', 'verdict_review', 'verdict_no']
const VERDICT_COLOR: Partial<Record<StationId, number>> = { verdict_ok: C.lime, verdict_review: C.amber, verdict_no: C.coral }

function buildStations(ctx: BuildCtx, stage: Stage): void {
  const diskGeo = ctx.own(new THREE.CylinderGeometry(0.8, 0.8, 0.08, 32))
  for (const id of STATION_DISKS) {
    const color = VERDICT_COLOR[id] ?? C.plateEdge
    const d = new THREE.Mesh(diskGeo, ctx.own(new THREE.MeshStandardMaterial({ color, roughness: 0.7, emissive: color, emissiveIntensity: 0 })))
    const p = STATION_POS[id]
    d.position.set(p.x, SURFACE + 0.04, p.z)
    d.userData['pick'] = pickOf({ type: 'station', station: id })
    ctx.pickables.push(d)
    ctx.scene.add(d)
    stage.stationDisks.set(id, d)
  }
  // Banda de cola.
  const queue = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(2.4, 0.08, 1.3)), stage.pageMats.pending)
  queue.position.set(STATION_POS.queue.x, SURFACE + 0.04, STATION_POS.queue.z)
  queue.userData['pick'] = pickOf({ type: 'station', station: 'queue' })
  ctx.pickables.push(queue)
  ctx.scene.add(queue)
  // Las estaciones se nombran en fila, al borde frontal de la placa del worker.
  for (const [id, label] of Object.entries(STATION_LABEL) as [StationId, string][]) {
    const p = STATION_POS[id]
    const verdict = isVerdict(id)
    ctx.labels.add(label, new THREE.Vector3(verdict ? p.x + 1.2 : p.x, SURFACE, verdict ? p.z + 0.2 : PLATE_D / 2 + 0.55), 'station')
  }
}

/** Losetas grandes, inclinadas hacia la cámara, junto a la estación de extracción. */
function buildPages(ctx: BuildCtx, stage: Stage, layout: SceneLayout): void {
  const total = layout.documents.reduce((a, d) => a + d.pages.length, 0)
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(total * 1.5))))
  const areaW = 8.2
  const rowsOf = (n: number) => Math.ceil(n / cols)
  const totalRows = Math.max(layout.documents.reduce((a, d) => a + rowsOf(d.pages.length), 0), 1)
  const w = Math.min(1.45, (areaW / cols) * 0.86)
  const h = Math.min(w * 1.3, 2.9 / totalRows / 0.62)
  const pitchX = areaW / cols
  const pitchZ = 2.9 / totalRows
  const geo = ctx.own(new THREE.BoxGeometry(w, 0.06, h))
  const numGeo = ctx.own(new THREE.PlaneGeometry(Math.min(w, h) * 0.46, Math.min(w, h) * 0.46))
  const tile = (doc: number, page: number, r: number, c: number) => {
    const mesh = new THREE.Mesh(geo, stage.pageMats.pending)
    mesh.rotation.x = TILE_TILT
    mesh.position.set(-12.3 + c * pitchX + pitchX / 2, SURFACE + (h / 2) * Math.sin(TILE_TILT) + 0.04, -3.7 + r * pitchZ + pitchZ / 2)
    mesh.userData['pick'] = pickOf({ type: 'page', document: doc, page })
    mesh.userData['baseY'] = mesh.position.y
    const num = new THREE.Mesh(numGeo, ctx.own(new THREE.MeshBasicMaterial({ map: numberTexture(ctx.own, page), transparent: true })))
    num.rotation.x = -Math.PI / 2
    num.position.y = 0.04
    mesh.add(num)
    stage.pageMeshes.set(`${String(doc)}:${String(page)}`, mesh)
    ctx.pickables.push(mesh)
    ctx.scene.add(mesh)
  }
  let row = 0
  for (const doc of layout.documents) {
    doc.pages.forEach((page, i) => { tile(doc.index, page, row + Math.floor(i / cols), i % cols) })
    row += rowsOf(doc.pages.length)
  }
}

function buildOrbs(ctx: BuildCtx, stage: Stage, layout: SceneLayout): void {
  const geo = ctx.own(new THREE.SphereGeometry(0.7, 28, 20))
  const flashGeo = ctx.own(new THREE.SphereGeometry(1, 20, 14))
  const n = layout.models.length
  layout.models.forEach((model, i) => {
    const x = -1 + (i - (n - 1) / 2) * 4.6
    const mat = ctx.own(new THREE.MeshStandardMaterial({ color: modelColor(model), roughness: 0.35, emissive: modelColor(model), emissiveIntensity: 0.05 }))
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(x, Y.models + 0.95, 0)
    mesh.userData['pick'] = pickOf({ type: 'orb', model })
    ctx.pickables.push(mesh)
    ctx.scene.add(mesh)
    const flash = new THREE.Mesh(flashGeo, ctx.own(new THREE.MeshBasicMaterial({ color: C.indigoSoft, transparent: true, opacity: 0, depthWrite: false })))
    flash.position.copy(mesh.position)
    flash.visible = false
    flash.renderOrder = 6
    ctx.scene.add(flash)
    stage.orbs.set(model, { mesh, flash, mat })
    ctx.labels.add(model, new THREE.Vector3(x, Y.models + 2.0, 0), 'orb', 'center', model)
  })
}

function buildGates(ctx: BuildCtx, stage: Stage, layout: SceneLayout): void {
  const decide = STATION_POS.decide
  const post = ctx.own(new THREE.BoxGeometry(0.1, 2.0, 0.1))
  const lintel = ctx.own(new THREE.BoxGeometry(0.1, 0.1, 1.3))
  const n = layout.gates.length
  const gap = Math.min(1.2, 5 / Math.max(n, 1))
  layout.gates.forEach((id, i) => {
    const mat = ctx.own(new THREE.MeshStandardMaterial({ color: C.mute, roughness: 0.5, emissive: C.mute, emissiveIntensity: 0.08 }))
    const parts = [new THREE.Mesh(post, mat), new THREE.Mesh(post, mat), new THREE.Mesh(lintel, mat)]
    ;(parts[0] as THREE.Mesh).position.set(0, 1.0, -0.65)
    ;(parts[1] as THREE.Mesh).position.set(0, 1.0, 0.65)
    ;(parts[2] as THREE.Mesh).position.set(0, 2.0, 0)
    for (const m of parts) {
      m.userData['pick'] = pickOf({ type: 'gate', id })
      ctx.pickables.push(m)
    }
    const group = new THREE.Group()
    group.add(...parts)
    group.position.set(decide.x + (i - (n - 1) / 2) * gap, SURFACE, decide.z)
    ctx.scene.add(group)
    stage.gates.set(id, { group, mat })
  })
}

function buildPillars(ctx: BuildCtx, stage: Stage, layout: SceneLayout): void {
  const decide = STATION_POS.decide
  const m = layout.dimensions.length
  const dgap = Math.min(1.3, 5 / Math.max(m, 1))
  const maxWeight = Math.max(...layout.dimensions.map((d) => d.weight), 1e-9)
  layout.dimensions.forEach((d, j) => {
    // Los pesos pueden venir en cualquier escala (1, 100…): la base del pilar es proporcional al mayor.
    const size = 0.35 + (d.weight / maxWeight) * 0.75
    const mat = ctx.own(new THREE.MeshStandardMaterial({ color: C.indigo, roughness: 0.5 }))
    const mesh = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(size, 1, size)), mat)
    mesh.position.set(decide.x + (j - (m - 1) / 2) * dgap, SURFACE + 0.05, -1.6)
    mesh.scale.y = 0.05
    ctx.scene.add(mesh)
    stage.pillars.set(d.id, { mesh, mat, hatch: stage.pageMats.pending, base: SURFACE })
  })
}

function buildTower(ctx: BuildCtx, stage: Stage): void {
  const geo = ctx.own(new THREE.BoxGeometry(1.6, 0.7, 1.6))
  ctx.own(ctx.towerMat)
  for (let i = 0; i < 12; i++) {
    const seg = new THREE.Mesh(geo, ctx.towerMat)
    seg.position.set(TOWER_X, Y.models + 0.4 + i * 0.78, 0)
    seg.visible = false
    seg.userData['pick'] = pickOf({ type: 'analyst' })
    ctx.scene.add(seg)
    stage.tower.push(seg)
  }
  const base = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(2.8, 0.12, 2.8)), ctx.own(new THREE.MeshStandardMaterial({ color: C.plate, roughness: 0.8 })))
  base.position.set(TOWER_X, Y.models, 0)
  base.userData['pick'] = pickOf({ type: 'analyst' })
  ctx.pickables.push(base, ...stage.tower)
  ctx.scene.add(base)
  ctx.labels.add('Analista', new THREE.Vector3(TOWER_X, Y.models, 2.4), 'layer')
}

export function buildStage(ctx: BuildCtx, layout: SceneLayout): Stage {
  const stage: Stage = {
    pageMats: makePageMaterials(ctx.own),
    pageMeshes: new Map(),
    orbs: new Map(),
    gates: new Map(),
    pillars: new Map(),
    stationDisks: new Map(),
    tower: [],
  }
  buildPlates(ctx)
  buildStations(ctx, stage)
  buildPages(ctx, stage, layout)
  buildOrbs(ctx, stage, layout)
  buildGates(ctx, stage, layout)
  buildPillars(ctx, stage, layout)
  buildTower(ctx, stage)
  return stage
}
