/**
 * Maqueta 3D del recorrido (three.js vanilla). Aplica un `SceneState` (scene-state.ts) a objetos que se
 * crean una vez y se reutilizan; no decide nada del recorrido. Renderiza bajo demanda: un fotograma
 * cuando cambia el estado, la cámara o el tamaño, y fotogramas seguidos solo mientras dura una
 * transición (ficha en arco, cámara). Sin bucle perpetuo en pausa.
 *
 * Construcción en scene-build.ts, haces y cápsulas en scene-effects.ts, etiquetas en scene-labels.ts.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneLayout, ScenePick, SceneState, StationId } from './scene-state'
import { buildStage, type Stage } from './scene-build'
import { C, ease, GATE_COLOR, STATION_POS, STATUS_COLOR, Y, type CameraPreset } from './scene-config'
import { Effects } from './scene-effects'
import { LabelLayer } from './scene-labels'

export { STATION_POS, type CameraPreset }

interface Options {
  reducedMotion: boolean
  onPick: (pick: ScenePick) => void
}
interface TokenTween {
  from: THREE.Vector3
  to: THREE.Vector3
  k: number
  dur: number
  arc: number
}
interface CamTween {
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  k: number
}

const PRESET_VIEW: Record<CameraPreset, { el: number; az: number; halfW: number; halfH: number; target: [number, number, number] }> = {
  maqueta: { el: 32, az: 24, halfW: 21, halfH: 9.4, target: [1.5, 5.2, 0] },
  frente: { el: 4, az: 0, halfW: 21, halfH: 8.4, target: [1.5, 5.2, 0] },
  arriba: { el: 86, az: 0, halfW: 18, halfH: 8, target: [1.5, Y.worker, 0] },
}

export class TimelineScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400)
  private readonly controls: OrbitControls
  private readonly raycaster = new THREE.Raycaster()
  private readonly resizeObserver: ResizeObserver
  private readonly labels: LabelLayer
  private readonly disposables: { dispose: () => void }[] = []
  private readonly pickables: THREE.Object3D[] = []
  private readonly stage: Stage
  private readonly effects: Effects

  private readonly towerMat = new THREE.MeshStandardMaterial({ color: C.coralSoft, roughness: 0.7 })
  private readonly tokenMat = new THREE.MeshStandardMaterial({ color: C.mute, roughness: 0.55 })
  private readonly token: THREE.Mesh
  private readonly tokenRing: THREE.Mesh
  private readonly ghost: THREE.Mesh
  private readonly ghostMat = new THREE.MeshStandardMaterial({ color: C.mute, transparent: true, opacity: 0.38, roughness: 0.6, depthWrite: false })
  private readonly relayMat = new THREE.MeshStandardMaterial({ color: C.indigo, transparent: true, opacity: 0.08, roughness: 0.4, emissive: C.indigo, emissiveIntensity: 0, depthWrite: false })
  private readonly relayEdgeMat = new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.28, depthWrite: false })

  private tokenTween: TokenTween | null = null
  private camTween: CamTween | null = null
  private tokenKey = ''
  private state: SceneState | null = null
  private follow = true
  private preset: CameraPreset = 'maqueta'
  private raf = 0
  private last = 0
  private disposed = false
  private downAt: { x: number; y: number } | null = null
  private hoverOrb: string | null = null
  private baseTarget = new THREE.Vector3()
  private userMoved = false
  private ready = false

  constructor(
    private readonly host: HTMLElement,
    labelLayer: HTMLElement,
    layout: SceneLayout,
    private readonly opts: Options,
  ) {
    // Si no hay WebGL esto lanza; quien llama lo captura y muestra el aviso.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none'
    this.renderer.domElement.setAttribute('role', 'img')
    this.renderer.domElement.setAttribute('aria-label', 'Maqueta 3D del recorrido de la solicitud')
    host.appendChild(this.renderer.domElement)
    this.labels = new LabelLayer(labelLayer)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd2da, 1.55))
    const sun = new THREE.DirectionalLight(0xffffff, 1.35)
    sun.position.set(14, 26, 20)
    this.scene.add(sun)

    const own = <T extends { dispose: () => void }>(x: T): T => {
      this.disposables.push(x)
      return x
    }
    this.stage = buildStage({ scene: this.scene, own, pickables: this.pickables, labels: this.labels, relayMat: this.relayMat, relayEdgeMat: this.relayEdgeMat, towerMat: this.towerMat }, layout)
    this.effects = new Effects(this.scene, this.stage.orbs, this.stage.pageMeshes)

    const cardGeo = own(new THREE.BoxGeometry(1.3, 0.9, 0.12))
    this.token = new THREE.Mesh(cardGeo, this.tokenMat)
    this.token.userData['pick'] = { type: 'token' } satisfies ScenePick
    this.pickables.push(this.token)
    this.ghost = new THREE.Mesh(cardGeo, this.ghostMat)
    this.ghost.visible = false
    this.tokenRing = new THREE.Mesh(own(new THREE.TorusGeometry(0.85, 0.04, 8, 40)), own(new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.55 })))
    this.tokenRing.rotation.x = Math.PI / 2
    this.tokenRing.visible = false
    this.scene.add(this.token, this.ghost, this.tokenRing)
    this.token.position.copy(STATION_POS.chat)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = false
    this.controls.minDistance = 10
    this.controls.maxDistance = 120
    this.controls.maxPolarAngle = Math.PI * 0.97
    this.controls.addEventListener('change', () => { this.requestRender() })
    this.controls.addEventListener('start', () => { this.userMoved = true })

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointermove', this.onMove)

    this.resizeObserver = new ResizeObserver(() => { this.resize() })
    this.resizeObserver.observe(host)
    this.resize()
    this.ready = true
    this.setPreset('maqueta', false)
  }

  // ───────────────────────── estado → objetos ─────────────────────────

  apply(state: SceneState): void {
    if (this.disposed) return
    this.state = state
    this.applyToken(state)
    this.applyRelay(state)
    this.applyPages(state)
    this.applyDecision(state)
    this.applyOrbs(state)
    this.effects.apply(state)
    this.applyTower(state)
    this.requestRender()
  }

  private applyToken(state: SceneState): void {
    const key = `${state.token.station}:${String(state.token.floating)}`
    const target = STATION_POS[state.token.station].clone()
    if (state.token.floating) target.y += 0.8
    if (key !== this.tokenKey) this.moveToken(state, key, target)
    this.tokenMat.color.setHex(STATUS_COLOR[state.token.status] ?? C.mute)
    this.tokenRing.visible = state.token.floating
    for (const [id, disk] of this.stage.stationDisks) (disk.material as THREE.MeshStandardMaterial).emissiveIntensity = id === state.token.station ? 0.55 : 0
    // Fantasma (decisión de sombra)
    this.ghost.visible = state.ghost !== null
    if (state.ghost) {
      this.ghost.position.copy(STATION_POS.decide).add(new THREE.Vector3(0.8, 0.45, -0.9))
      this.ghostMat.color.setHex(STATUS_COLOR[state.ghost.status] ?? C.mute)
    }
  }

  private moveToken(state: SceneState, key: string, target: THREE.Vector3): void {
    const first = this.tokenKey === ''
    this.tokenKey = key
    if (first || this.opts.reducedMotion) {
      this.token.position.copy(target)
      this.tokenTween = null
    } else {
      const arc = state.token.station === 'chat' || state.token.floating ? 1.6 : 0.7
      this.tokenTween = { from: this.token.position.clone(), to: target, k: 0, dur: 0.75, arc }
    }
    if (this.follow && !first) this.focusStation(state.token.station)
  }

  private applyRelay(state: SceneState): void {
    // Relleno casi invisible (nunca opaco); lo que se nota es el borde.
    this.relayMat.emissiveIntensity = state.relayGlow * 0.25
    this.relayMat.opacity = 0.08 + state.relayGlow * 0.14
    this.relayEdgeMat.opacity = 0.28 + state.relayGlow * 0.72
  }

  private applyPages(state: SceneState): void {
    for (const p of state.pages) {
      const mesh = this.stage.pageMeshes.get(`${String(p.document)}:${String(p.page)}`)
      if (!mesh) continue
      mesh.material = this.stage.pageMats[p.verification]
      mesh.position.y = (mesh.userData['baseY'] as number) + (p.reading ? 0.3 : 0)
    }
  }

  private applyDecision(state: SceneState): void {
    for (const g of state.gates) {
      const gate = this.stage.gates.get(g.id)
      if (!gate) continue
      gate.mat.color.setHex(GATE_COLOR[g.color])
      gate.mat.emissive.setHex(GATE_COLOR[g.color])
      gate.mat.emissiveIntensity = g.color === 'unknown' ? 0.05 : 0.3
    }
    for (const d of state.dimensions) {
      const p = this.stage.pillars.get(d.id)
      if (!p) continue
      const h = Math.max(d.value * 2.2, 0.05)
      p.mesh.scale.y = h
      p.mesh.position.y = p.base + h / 2
      p.mesh.material = d.used ? p.mat : p.hatch
    }
  }

  private applyOrbs(state: SceneState): void {
    for (const m of state.models) {
      const o = this.stage.orbs.get(m.model)
      if (!o) continue
      o.mat.emissiveIntensity = m.active ? 0.7 : 0.05
      o.mesh.scale.setScalar(m.active ? 1.12 : 1)
      o.flash.visible = false
    }
    for (const f of state.flashes) {
      const o = this.stage.orbs.get(f.model)
      if (!o) continue
      o.flash.visible = true
      o.flash.scale.setScalar(1.1 + (1 - f.strength) * 0.7)
      ;(o.flash.material as THREE.MeshBasicMaterial).opacity = f.strength * 0.7
    }
  }

  private applyTower(state: SceneState): void {
    this.towerMat.emissive.setHex(state.analyst.active ? C.coral : 0x000000)
    this.towerMat.emissiveIntensity = state.analyst.active ? 0.45 : 0
    this.stage.tower.forEach((seg, i) => { seg.visible = i < state.analyst.level })
  }

  // ───────────────────────── cámara ─────────────────────────

  setFollow(on: boolean): void {
    this.follow = on
    if (on && this.state) this.focusStation(this.state.token.station)
  }

  setPreset(preset: CameraPreset, animate = true): void {
    this.preset = preset
    this.userMoved = false
    const v = PRESET_VIEW[preset]
    const aspect = this.camera.aspect || 1.6
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    // Toda la pila (26 de ancho + la torre en x = TOWER_X, 11 de alto) cabe con margen; el worker queda al centro.
    const el = THREE.MathUtils.degToRad(v.el)
    const az = THREE.MathUtils.degToRad(v.az)
    const target = new THREE.Vector3(...v.target)
    const dist = Math.max(v.halfW / (tanHalf * aspect), v.halfH / tanHalf)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    this.baseTarget.copy(target)
    this.moveCamera(target.clone().addScaledVector(dir, dist), target, animate)
  }

  /** Seguir: el objetivo se desplaza hacia la estación; la distancia al objetivo no cambia (sin zoom). */
  private focusStation(station: StationId): void {
    const to = this.baseTarget.clone().lerp(STATION_POS[station], 0.2)
    const delta = to.clone().sub(this.controls.target)
    if (delta.lengthSq() < 0.01) return
    this.moveCamera(this.camera.position.clone().add(delta), to, true)
  }

  private moveCamera(pos: THREE.Vector3, target: THREE.Vector3, animate: boolean): void {
    if (!animate || this.opts.reducedMotion) {
      this.camera.position.copy(pos)
      this.controls.target.copy(target)
      this.controls.update()
      this.camTween = null
    } else {
      this.camTween = { fromPos: this.camera.position.clone(), toPos: pos, fromTarget: this.controls.target.clone(), toTarget: target, k: 0 }
    }
    this.requestRender()
  }

  currentPreset(): CameraPreset {
    return this.preset
  }

  // ───────────────────────── render ─────────────────────────

  resize(): void {
    if (this.disposed) return
    const w = Math.max(this.host.clientWidth, 1)
    const h = Math.max(this.host.clientHeight, 1)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // Mientras nadie haya movido la cámara, el encuadre sigue al tamaño real del contenedor.
    if (this.ready && !this.userMoved && !this.camTween) this.setPreset(this.preset, false)
    this.requestRender()
  }

  requestRender(): void {
    if (this.disposed || this.raf) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private stepTokenTween(dt: number): boolean {
    const tt = this.tokenTween
    if (!tt) return false
    tt.k = Math.min(1, tt.k + dt / tt.dur)
    const e = ease(tt.k)
    this.token.position.lerpVectors(tt.from, tt.to, e)
    this.token.position.y += tt.arc * Math.sin(Math.PI * e)
    if (tt.k >= 1) this.tokenTween = null
    return tt.k < 1
  }

  private stepCameraTween(dt: number): boolean {
    const ct = this.camTween
    if (!ct) return false
    ct.k = Math.min(1, ct.k + dt / 0.65)
    const e = ease(ct.k)
    this.camera.position.lerpVectors(ct.fromPos, ct.toPos, e)
    this.controls.target.lerpVectors(ct.fromTarget, ct.toTarget, e)
    this.camera.lookAt(this.controls.target)
    if (ct.k < 1) return true
    this.camTween = null
    this.controls.update()
    return false
  }

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (this.disposed) return
    const dt = Math.min(Math.max(now - this.last, 0), 50) / 1000
    this.last = now
    const tokenMoving = this.stepTokenTween(dt)
    this.tokenRing.position.copy(this.token.position).setY(this.token.position.y - 0.6)
    const cameraMoving = this.stepCameraTween(dt)
    this.renderer.render(this.scene, this.camera)
    const active = new Set<string | undefined>(this.state?.models.filter((m) => m.active).map((m) => m.model))
    this.labels.place(this.camera, this.host.clientWidth, this.host.clientHeight, active, this.hoverOrb)
    if (tokenMoving || cameraMoving) this.requestRender()
  }

  // ───────────────────────── puntero ─────────────────────────

  private pickAt(ev: PointerEvent): ScenePick | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObjects(this.pickables, false).find((h) => h.object.visible)
    return (hit?.object.userData['pick'] as ScenePick | undefined) ?? null
  }

  private readonly onDown = (ev: PointerEvent): void => {
    this.downAt = { x: ev.clientX, y: ev.clientY }
  }
  private readonly onUp = (ev: PointerEvent): void => {
    const d = this.downAt
    this.downAt = null
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return
    const pick = this.pickAt(ev)
    if (pick) this.opts.onPick(pick)
  }
  private readonly onMove = (ev: PointerEvent): void => {
    if (ev.buttons !== 0) return
    const pick = this.pickAt(ev)
    this.renderer.domElement.style.cursor = pick ? 'pointer' : 'grab'
    const orb = pick?.type === 'orb' ? pick.model : null
    if (orb !== this.hoverOrb) {
      this.hoverOrb = orb
      this.requestRender()
    }
  }

  // ───────────────────────── limpieza ─────────────────────────

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointerup', this.onUp)
    el.removeEventListener('pointermove', this.onMove)
    this.controls.dispose()
    this.scene.traverse((o) => {
      if (!('geometry' in o)) return
      const obj = o as THREE.Mesh
      obj.geometry.dispose()
      const mat = obj.material
      if (Array.isArray(mat)) mat.forEach((x) => { disposeMaterial(x) })
      else disposeMaterial(mat)
    })
    for (const d of this.disposables) d.dispose()
    this.effects.dispose()
    for (const m of [this.tokenMat, this.ghostMat, this.relayMat, this.relayEdgeMat, this.towerMat]) m.dispose()
    this.labels.dispose()
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    el.remove()
  }
}

function disposeMaterial(m: THREE.Material): void {
  const map = (m as THREE.MeshStandardMaterial).map
  if (map) map.dispose()
  m.dispose()
}
