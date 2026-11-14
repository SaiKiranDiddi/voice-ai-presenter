import { useEffect, useRef } from 'react'
import type { Analysers } from '../hooks/useRealtimeSession'
import type { AgentState, TranscriptLine } from '../types'
import { MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, StopIcon } from './Icons'
import { VoiceVisual } from './VoiceVisual'

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

export function VoiceStatus({
  state,
  latencyMs,
  getAnalysers,
}: {
  state: AgentState
  latencyMs: number | null
  getAnalysers: () => Analysers
}) {
  return (
    <div className={`voice voice--${state}`}>
      <VoiceVisual state={state} getAnalysers={getAnalysers} />
      <div className="voice-text">
        <p className="voice-label" role="status">
          <span className="voice-dot" aria-hidden="true" />
          {STATE_LABEL[state]}
        </p>
        <p className="voice-hint">{STATE_HINT[state]}</p>
      </div>
      {latencyMs !== null && (
        <p className="voice-metric" title="Time from the end of your question to the first sound of the reply">
          Response time <strong>{latencyMs} ms</strong>
        </p>
      )}
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
      <button type="button" className="control control--main" onClick={paused ? onResume : onPause}>
        {paused ? <PlayIcon /> : <PauseIcon />}
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button type="button" className="control" onClick={onStopSpeaking} disabled={!speaking}>
        <StopIcon />
        <span>Stop talking</span>
      </button>
      <button
        type="button"
        className={`control ${muted ? 'is-on' : ''}`}
        onClick={onToggleMute}
        aria-pressed={muted}
        disabled={paused}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
        <span>{muted ? 'Unmute' : 'Mute'}</span>
      </button>
      <button type="button" className="control control--danger" onClick={onEnd}>
        <PhoneOffIcon />
        <span>End call</span>
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
          <div key={line.id} className={`line line--${line.role}`}>
            <span className="line-role">{line.role === 'agent' ? 'Presenter' : 'You'}</span>
            <p className="line-text">
              {line.text}
              {line.interrupted && <span className="line-cut">interrupted</span>}
            </p>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  )
}
