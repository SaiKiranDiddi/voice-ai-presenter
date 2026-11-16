import { useEffect, useRef } from 'react'
import type { Analysers } from '../session/audio'
import type { AgentState, TranscriptLine } from '../types'
import { MicIcon, MicOffIcon, PhoneOffIcon, StopIcon } from './Icons'
import { VoiceOrb } from './VoiceOrb'

const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  ended: 'Call ended',
  error: 'Something went wrong',
}

const STATE_HINT: Record<AgentState, string> = {
  idle: 'Start the call to hear the presentation.',
  connecting: 'Setting up the call.',
  listening: 'Ask a question. The presentation resumes by itself.',
  thinking: 'Working on a reply.',
  speaking: 'Just start talking to interrupt.',
  ended: 'Start again whenever you like.',
  error: 'See the message below.',
}

export function VoiceStatus({
  state,
  answering,
  latencyMs,
  getAnalysers,
}: {
  state: AgentState
  answering: boolean
  latencyMs: number | null
  getAnalysers: () => Analysers
}) {
  return (
    <div className={`voice voice--${state}`}>
      <VoiceOrb state={state} answering={answering} getAnalysers={getAnalysers} />
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
  onStopSpeaking,
  onToggleMute,
  onEnd,
}: {
  live: boolean
  speaking: boolean
  muted: boolean
  onStopSpeaking: () => void
  onToggleMute: () => void
  onEnd: () => void
}) {
  if (!live) return null
  return (
    <div className="controls">
      <button type="button" className="control" onClick={onStopSpeaking} disabled={!speaking}>
        <StopIcon />
        <span>Stop talking</span>
      </button>
      <button
        type="button"
        className={`control ${muted ? 'is-on' : ''}`}
        onClick={onToggleMute}
        aria-pressed={muted}
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
