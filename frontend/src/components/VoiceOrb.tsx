import { useEffect, useRef } from 'react'
import type { Analysers } from '../session/audio'
import type { AgentState } from '../types'

/** Frequency bins averaged for the level: roughly the speech range at fftSize 512. */
const FIRST_BIN = 1
const LAST_BIN = 44

/** Raw speech averages sit around 0.4-0.6; stretch that so pauses read 0 and loud syllables near 1. */
const FLOOR = 0.15
const SPAN = 0.5

/** Loudness of the speech bins, 0 to 1. */
function readLevel(analyser: AnalyserNode | null, bins: Uint8Array<ArrayBuffer>): number {
  if (!analyser) return 0
  analyser.getByteFrequencyData(bins)
  let sum = 0
  for (let index = FIRST_BIN; index <= LAST_BIN; index++) sum += bins[index]
  const raw = sum / (LAST_BIN - FIRST_BIN + 1) / 255
  return Math.min(1, Math.max(0, (raw - FLOOR) / SPAN))
}

/** Rise quickly, fall slowly, like a level meter. */
function ease(current: number, target: number): number {
  const next = current + (target - current) * (target > current ? 0.4 : 0.1)
  return next < 0.001 ? 0 : next
}

/**
 * The presenter as an orb. It swells with the presenter's voice while it
 * speaks, breathes while it listens (with a ring that follows the
 * microphone, so the user can see they are heard), and swirls while it
 * thinks. Colours come from CSS; this only feeds it the audio levels.
 */
export function VoiceOrb({
  state,
  answering,
  getAnalysers,
}: {
  state: AgentState
  answering: boolean
  getAnalysers: () => Analysers
}) {
  const orb = useRef<HTMLDivElement>(null)
  const levels = useRef({ level: 0, mic: 0 })

  useEffect(() => {
    const element = orb.current
    if (!element) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.style.setProperty('--level', '0')
      element.style.setProperty('--mic', '0')
      return
    }

    const bins = new Uint8Array(256)
    let frame = 0

    const tick = () => {
      const { agent, user } = getAnalysers()
      const current = levels.current
      current.level = ease(current.level, state === 'speaking' ? readLevel(agent, bins) : 0)
      current.mic = ease(current.mic, state === 'listening' ? readLevel(user, bins) : 0)
      element.style.setProperty('--level', current.level.toFixed(3))
      element.style.setProperty('--mic', current.mic.toFixed(3))
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state, getAnalysers])

  return (
    <div className="orb-stage" aria-hidden="true">
      <div ref={orb} className={`orb orb--${state}${answering ? ' is-answering' : ''}`}>
        <span className="orb-glow" />
        <span className="orb-ring" />
        <span className="orb-core">
          <span className="orb-swirl" />
          <span className="orb-swirl orb-swirl--slow" />
          <span className="orb-shine" />
        </span>
      </div>
    </div>
  )
}
