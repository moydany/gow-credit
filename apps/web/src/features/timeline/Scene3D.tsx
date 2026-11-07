import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { CameraPreset } from './scene'
import type { SceneLayout, ScenePick, SceneState } from './scene-state'
import type { TimelineScene } from './scene'

const PRESETS: { id: CameraPreset; label: string }[] = [
  { id: 'maqueta', label: 'Maqueta' },
  { id: 'frente', label: 'Frente' },
  { id: 'arriba', label: 'Arriba' },
]

export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Contenedor de la escena: crea y destruye el motor de three, y le pasa el estado de cada instante. */
export function Scene3D({ layout, state, onPick }: { layout: SceneLayout; state: SceneState; onPick: (pick: ScenePick) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const engine = useRef<TimelineScene | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [preset, setPreset] = useState<CameraPreset>('maqueta')
  const [follow, setFollow] = useState(true)
  const latest = useRef({ state, onPick, preset, follow })
  latest.current = { state, onPick, preset, follow }
  const key = JSON.stringify(layout)

  useEffect(() => {
    const host = hostRef.current
    const labels = labelsRef.current
    if (!host || !labels) return
    let scene: TimelineScene | null = null
    let cancelled = false
    // three se importa aquí: así el chunk también es dinámico respecto de esta pantalla y no pesa si WebGL no existe.
    void import('./scene')
      .then(({ TimelineScene }) => {
        if (cancelled) return
        try {
          scene = new TimelineScene(host, labels, JSON.parse(key) as SceneLayout, { reducedMotion: prefersReducedMotion(), onPick: (p) => { latest.current.onPick(p) } })
        } catch {
          setFailed('Tu navegador no pudo abrir WebGL.')
          return
        }
        engine.current = scene
        scene.setPreset(latest.current.preset, false)
        scene.setFollow(latest.current.follow)
        scene.apply(latest.current.state)
      })
      .catch(() => { setFailed('No se pudo cargar la escena 3D.') })
    return () => {
      cancelled = true
      engine.current = null
      scene?.dispose()
    }
  }, [key])

  useEffect(() => { engine.current?.apply(state) }, [state])
  useEffect(() => { engine.current?.setPreset(preset) }, [preset])
  useEffect(() => { engine.current?.setFollow(follow) }, [follow])

  if (failed) {
    return (
      <div className="hatch grid h-full min-h-[160px] place-items-center rounded-[22px] p-6 text-center text-[14px] text-ink-2" role="status">
        {failed} La línea de tiempo de abajo sigue funcionando.
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-[320px] overflow-hidden rounded-[22px] bg-[linear-gradient(180deg,#eceef2,#dcdfe6)]">
      <div ref={hostRef} className="absolute inset-0" />
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" />
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="Cámara" className="flex gap-1 rounded-full bg-card/90 p-1 shadow-sm">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => { setPreset(p.id) }} className={clsx('h-8 rounded-full px-3 text-[12.5px] font-medium transition-colors', preset === p.id ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken')}>
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" aria-pressed={follow} onClick={() => { setFollow((f) => !f) }} className={clsx('h-8 rounded-full px-3.5 text-[12.5px] font-medium shadow-sm transition-colors', follow ? 'bg-ink text-white' : 'bg-card/90 text-ink-2 hover:bg-sunken')}>
          Seguir
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-2.5 left-3.5 text-[11.5px] text-muted">Arrastra para girar · rueda para acercar · clic en un objeto para ver su evento</p>
    </div>
  )
}
