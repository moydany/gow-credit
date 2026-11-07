/** 3D model constants: palette, sizes, each station's position and colors by status. */
import * as THREE from 'three'
import type { GateColor, StationId } from './scene-state'

export type CameraPreset = 'maqueta' | 'frente' | 'arriba'

export const C = {
  lime: 0xa6f23b,
  amber: 0xf5b83d,
  coral: 0xf0594a,
  coralSoft: 0xf4b3ab,
  indigo: 0x6574ff,
  indigoSoft: 0xc9cfff,
  ink: 0x14171f,
  ink2: 0x3b404b,
  plate: 0xf4f4f5,
  plateEdge: 0xd6d6db,
  mute: 0x9a9fa9,
  white: 0xfcfcfc,
}

export const PLATE_W = 26
export const PLATE_D = 8
export const PLATE_T = 0.12
/** Layers well separated vertically: depth (8) is less than the step between plates (3.6). */
export const Y = { supplier: 10.8, relay: 7.2, worker: 3.6, models: 0 }
export const SURFACE = Y.worker + PLATE_T / 2
export const TOWER_X = 15.6
export const TILE_TILT = 0.85

/** Resting position of the token at each station. */
export const STATION_POS: Record<StationId, THREE.Vector3> = {
  chat: new THREE.Vector3(-11, Y.supplier + 1.3, 0),
  relay: new THREE.Vector3(-11, Y.relay + 1.0, 0),
  queue: new THREE.Vector3(-11.4, SURFACE + 0.9, 1.7),
  extract: new THREE.Vector3(-8, SURFACE + 0.9, 1.7),
  'classify-transactions': new THREE.Vector3(-4.6, SURFACE + 0.9, 1.7),
  decide: new THREE.Vector3(-0.6, SURFACE + 0.9, 1.7),
  'ask-owner': new THREE.Vector3(4, SURFACE + 0.9, 1.7),
  explain: new THREE.Vector3(7, SURFACE + 0.9, 1.7),
  verdict_ok: new THREE.Vector3(10.6, SURFACE + 0.9, -2),
  verdict_review: new THREE.Vector3(10.6, SURFACE + 0.9, 0.5),
  verdict_no: new THREE.Vector3(10.6, SURFACE + 0.9, 3),
  analyst: new THREE.Vector3(TOWER_X, 8, 0),
}

export const STATION_LABEL: Partial<Record<StationId, string>> = {
  queue: 'Cola',
  extract: 'Extraer',
  'classify-transactions': 'Clasificar',
  decide: 'Decidir',
  'ask-owner': 'Preguntar',
  explain: 'Explicar',
  verdict_ok: 'Con línea',
  verdict_review: 'Revisión',
  verdict_no: 'No califica',
}

export const STATUS_COLOR: Record<string, number> = {
  received: C.mute,
  extracting: C.mute,
  extracted: C.mute,
  deciding: C.mute,
  needs_clarification: C.indigo,
  human_review: C.amber,
  qualified: C.lime,
  qualified_with_limit: C.lime,
  not_qualified: C.coral,
  failed: C.ink,
}

export const GATE_COLOR: Record<GateColor, number> = { pass: C.lime, unknown: C.mute, clarify: C.indigo, review: C.amber, reject: C.coral, fail: C.coralSoft }

const MODEL_COLORS: [string, number][] = [
  ['gemini', C.indigo],
  ['opus', C.ink2],
  ['haiku', C.amber],
]
export const modelColor = (model: string): number => MODEL_COLORS.find(([k]) => model.includes(k))?.[1] ?? C.mute

export const ease = (k: number): number => 1 - Math.pow(1 - k, 3)

export const isVerdict = (id: StationId): boolean => id.startsWith('verdict_')
