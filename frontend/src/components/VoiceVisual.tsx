import { useEffect, useRef } from 'react'
import type { Analysers } from '../session/audio'
import type { AgentState } from '../types'

const BARS = 36
const MIN_HEIGHT = 0.06

/** Which CSS colour each state draws in. */
const COLOUR: Record<AgentState, [string, string]> = {
  idle: ['--neutral-bar', '--neutral-bar'],
  ended: ['--neutral-bar', '--neutral-bar'],
  paused: ['--neutral-bar', '--neutral-bar'],
  connecting: ['--accent-bright', '--accent'],
  thinking: ['--accent-bright', '--accent'],
  speaking: ['--accent-bright', '--accent-strong'],
  listening: ['--ink-2', '--ink'],
  error: ['--danger', '--danger'],
}

/** A resting shape, tallest in the middle, used when nothing is moving. */
function restingHeight(index: number, scale: number): number {
  const centre = 1 - Math.abs(index - (BARS - 1) / 2) / (BARS / 2)
  return MIN_HEIGHT + scale * centre * centre
}

/**
 * The voice waveform. While the presenter speaks it follows the presenter's
 * audio; while it listens it follows the microphone, so the user can see they
 * are being heard. Other states draw a calm shape of their own.
 */
export function VoiceVisual({ state, getAnalysers }: { state: AgentState; getAnalysers: () => Analysers }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const heights = useRef<number[]>(Array.from({ length: BARS }, () => MIN_HEIGHT))

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const styles = getComputedStyle(element)
    const [top, bottom] = COLOUR[state].map((name) => styles.getPropertyValue(name).trim() || '#0b7a83')
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const bins = new Uint8Array(256)
    let frame = 0

    const draw = (time: number) => {
      const ratio = window.devicePixelRatio || 1
      const width = element.clientWidth
      const height = element.clientHeight
      if (element.width !== width * ratio || element.height !== height * ratio) {
        element.width = width * ratio
        element.height = height * ratio
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)

      const { agent, user } = getAnalysers()
      const source = state === 'speaking' ? agent : state === 'listening' ? user : null
      if (source && !still) source.getByteFrequencyData(bins)

      const gradient = context.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, top)
      gradient.addColorStop(1, bottom)
      context.fillStyle = gradient

      const slot = width / BARS
      const barWidth = Math.max(2, slot * 0.56)
      for (let index = 0; index < BARS; index++) {
        // Mirror around the centre: low frequencies, where speech lives, in the middle.
        const distance = Math.abs(index - (BARS - 1) / 2) / (BARS / 2)
        let target: number
        if (still) {
          target = restingHeight(index, state === 'speaking' || state === 'listening' ? 0.5 : 0.12)
        } else if (source) {
          const bin = 1 + Math.floor(distance * 44)
          const level = (bins[bin] + bins[bin + 1]) / 2 / 255
          target = MIN_HEIGHT + Math.pow(level, 1.4) * (1 - distance * 0.35) * 0.94
          if (state === 'listening') target = Math.max(target, restingHeight(index, 0.08 + 0.03 * Math.sin(time / 600)))
        } else if (state === 'thinking' || state === 'connecting') {
          // A pulse travelling outwards from the centre.
          const wave = Math.sin(time / 260 - distance * 7)
          target = MIN_HEIGHT + 0.2 * Math.max(0, wave) * (1 - distance * 0.6)
        } else {
          target = restingHeight(index, 0.1)
        }
        const current = heights.current[index]
        // Rise quickly, fall slowly, like a level meter.
        const next = still ? target : current + (target - current) * (target > current ? 0.45 : 0.14)
        heights.current[index] = next

        const barHeight = Math.max(barWidth, next * height)
        const x = slot * index + (slot - barWidth) / 2
        context.beginPath()
        context.roundRect(x, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2)
        context.fill()
      }
      if (!still) frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [state, getAnalysers])

  return <canvas ref={canvas} className={`voice-visual voice-visual--${state}`} aria-hidden="true" />
}
