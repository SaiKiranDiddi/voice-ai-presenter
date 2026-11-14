import { useEffect, useRef } from 'react'
import type { AgentState, TranscriptLine } from '../types'

const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Paused',
  ended: 'Call ended',
  error: 'Something went wrong',
}

const STATE_HINT: Record<AgentState, string> = {
  idle: 'Start the call to hear the presentation.',
  connecting: 'Setting up the call.',
  listening: 'Ask a question. The presentation resumes by itself.',
  thinking: 'Working on a reply.',
  speaking: 'Just start talking to interrupt.',
  paused: 'Microphone is off. Resume when you are ready.',
  ended: 'Start again whenever you like.',
  error: 'See the message below.',
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceStatus({
  state,
  latencyMs,
  secondsLeft,
}: {
  state: AgentState
  latencyMs: number | null
  secondsLeft: number | null
}) {
  return (
    <div className="status">
      <div className={`orb orb--${state}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="status-text">
        <p className="status-label" role="status">
          {STATE_LABEL[state]}
        </p>
        <p className="status-hint">{STATE_HINT[state]}</p>
      </div>
      <dl className="metrics">
        <div>
          <dt>Response time</dt>
          <dd>{latencyMs === null ? '–' : `${latencyMs} ms`}</dd>
        </div>
        <div>
          <dt>Time left</dt>
          <dd>{secondsLeft === null ? '–' : formatClock(secondsLeft)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function Controls({
  live,
  speaking,
  muted,
  paused,
  onStopSpeaking,
  onPause,
  onResume,
  onToggleMute,
  onEnd,
}: {
  live: boolean
  speaking: boolean
  muted: boolean
  paused: boolean
  onStopSpeaking: () => void
  onPause: () => void
  onResume: () => void
  onToggleMute: () => void
  onEnd: () => void
}) {
  if (!live) return null
  return (
    <div className="controls">
      <button type="button" className="wide" onClick={paused ? onResume : onPause}>
        {paused ? '▶ Resume' : '❚❚ Pause'}
      </button>
      <button type="button" onClick={onStopSpeaking} disabled={!speaking}>
        Stop talking
      </button>
      <button type="button" onClick={onToggleMute} aria-pressed={muted} disabled={paused}>
        {muted ? 'Unmute mic' : 'Mute mic'}
      </button>
      <button type="button" className="danger" onClick={onEnd}>
        End call
      </button>
    </div>
  )
}

export function Transcript({ lines }: { lines: TranscriptLine[] }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [lines])

  return (
    <div className="transcript" aria-label="Transcript">
      <h3 className="panel-heading">Transcript</h3>
      <div className="transcript-scroll">
        {lines.length === 0 && <p className="transcript-empty">The conversation will appear here.</p>}
        {lines.map((line) => (
          <p key={line.id} className={`line line--${line.role}`}>
            <span className="line-role">{line.role === 'agent' ? 'Presenter' : 'You'}</span>
            {line.text}
            {line.interrupted && <span className="line-cut"> (interrupted)</span>}
          </p>
        ))}
        <div ref={end} />
      </div>
    </div>
  )
}
