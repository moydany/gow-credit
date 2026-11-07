/** Model beams and message capsules: objects reused from one frame to the next. */
import * as THREE from 'three'
import type { Capsule, SceneState, StationId } from './scene-state'
import { C, STATION_POS } from './scene-config'

type PageRef = { document: number; page: number }

export class Effects {
  private readonly beamGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 6)
  private readonly beamMats = {
    ok: new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.8 }),
    error: new THREE.MeshBasicMaterial({ color: C.coral, transparent: true, opacity: 0.9 }),
  }
  private readonly beamPool: THREE.Mesh[] = []
  private readonly capsuleGeo = new THREE.CapsuleGeometry(0.2, 0.5, 4, 8)
  private readonly capsuleMats = {
    in: new THREE.MeshStandardMaterial({ color: C.indigo, roughness: 0.4 }),
    out: new THREE.MeshStandardMaterial({ color: C.lime, roughness: 0.4 }),
    failed: new THREE.MeshStandardMaterial({ color: C.coral, roughness: 0.4 }),
  }
  private readonly capsulePool: THREE.Mesh[] = []

  constructor(
    private readonly scene: THREE.Scene,
    private readonly orbs: Map<string, { mesh: THREE.Mesh }>,
    private readonly pageMeshes: Map<string, THREE.Mesh>,
  ) {}

  apply(state: SceneState): void {
    this.applyBeams(state)
    this.applyCapsules(state)
  }

  private endpoint(station: StationId | null, ref: PageRef | null): THREE.Vector3 | null {
    if (ref) return this.pageMeshes.get(`${String(ref.document)}:${String(ref.page)}`)?.position.clone() ?? null
    return station ? STATION_POS[station].clone() : null
  }

  private beamMesh(i: number): THREE.Mesh {
    let mesh = this.beamPool[i]
    if (!mesh) {
      mesh = new THREE.Mesh(this.beamGeo, this.beamMats.ok)
      this.scene.add(mesh)
      this.beamPool.push(mesh)
    }
    return mesh
  }

  private placeBeam(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, progress: number, kind: 'ok' | 'error', thin: boolean): void {
    const dir = to.clone().sub(from)
    const len = dir.length() * progress
    mesh.visible = len >= 1e-3
    if (!mesh.visible) return
    dir.normalize()
    mesh.material = this.beamMats[kind]
    mesh.position.copy(from).addScaledVector(dir, len / 2)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    mesh.scale.set(thin ? 0.6 : 1, len, thin ? 0.6 : 1)
  }

  private applyBeams(state: SceneState): void {
    let used = 0
    for (const b of state.beams) {
      const orb = this.orbs.get(b.model)
      if (!orb) continue
      const targets = b.pages.length > 0 ? b.pages.map((ref) => this.endpoint(null, ref)) : [this.endpoint(b.station, null)]
      for (const to of targets) {
        if (!to) continue
        this.placeBeam(this.beamMesh(used), orb.mesh.position, to, b.progress, b.kind, b.fading)
        used++
      }
    }
    for (let i = used; i < this.beamPool.length; i++) (this.beamPool[i] as THREE.Mesh).visible = false
  }

  private capsuleMesh(i: number): THREE.Mesh {
    let mesh = this.capsulePool[i]
    if (!mesh) {
      mesh = new THREE.Mesh(this.capsuleGeo, this.capsuleMats.in)
      mesh.rotation.z = Math.PI / 2
      this.scene.add(mesh)
      this.capsulePool.push(mesh)
    }
    return mesh
  }

  /** Point along the station path, with `progress` spread by distance. */
  private pathPoint(c: Capsule): THREE.Vector3 | null {
    const pts = c.path.map((s) => STATION_POS[s])
    const lens = pts.slice(1).map((p, i) => p.distanceTo(pts[i] as THREE.Vector3))
    let d = Math.min(Math.max(c.progress, 0), 1) * lens.reduce((a, b) => a + b, 0)
    let k = 0
    while (k < lens.length - 1 && d > (lens[k] as number)) {
      d -= lens[k] as number
      k++
    }
    const a = pts[k]
    const b = pts[k + 1]
    const len = lens[k]
    return a && b && len !== undefined ? new THREE.Vector3().lerpVectors(a, b, d / Math.max(len, 1e-6)) : null
  }

  private applyCapsules(state: SceneState): void {
    state.capsules.forEach((c, i) => {
      const mesh = this.capsuleMesh(i)
      const p = this.pathPoint(c)
      mesh.visible = p !== null
      if (p) mesh.position.copy(p)
      mesh.material = c.failed ? this.capsuleMats.failed : this.capsuleMats[c.direction]
      mesh.scale.setScalar(c.message === 'document' ? 1.4 : 1)
    })
    for (let i = state.capsules.length; i < this.capsulePool.length; i++) (this.capsulePool[i] as THREE.Mesh).visible = false
  }

  dispose(): void {
    this.beamGeo.dispose()
    this.capsuleGeo.dispose()
    for (const m of Object.values(this.beamMats)) m.dispose()
    for (const m of Object.values(this.capsuleMats)) m.dispose()
  }
}
