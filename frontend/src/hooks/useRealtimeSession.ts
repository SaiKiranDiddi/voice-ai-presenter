/**
 * React glue for one voice call. It wires three pieces together and exposes
 * their state to the UI:
 *   - connection.ts: the WebRTC call to OpenAI (audio + event channel)
 *   - presenter.ts:  the presentation flow (which block, when, tool calls)
 *   - our backend:   the ephemeral secret, and a log of each call's events
 * Everything worth testing lives in the Presenter; this file only plumbs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createSession, postEvents } from '../api'
import { createMeterContext, meter, openMicrophone, type Analysers } from '../session/audio'
import { openRealtimeCall, type RealtimeCall } from '../session/connection'
import { Presenter } from '../session/presenter'
import type { AgentState, Deck, FocusMode, LoggedEvent, Slide, TranscriptLine } from '../types'

const LOG_FLUSH_MS = 4000
const NO_ANALYSERS: Analysers = { agent: null, user: null }

interface Options {
  deck: Deck | null
  /** Show a slide and highlight a block. */
  onFocus: (slideId: string, blockId: string, mode: FocusMode) => void
  /** Drop the highlight but keep the slide. */
  onClearHighlight: () => void
}

/** Everything that exists only while a call is up. */
interface Live {
  presenter: Presenter
  call: RealtimeCall | null
  mic: MediaStream | null
  speaker: HTMLAudioElement
  meterContext: AudioContext | null
  analysers: Analysers
  sessionId: string
  startedAt: number
  logs: LoggedEvent[]
  timers: number[]
}

export function useRealtimeSession({ deck, onFocus, onClearHighlight }: Options) {
  const [state, setState] = useState<AgentState>('idle')
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  const live = useRef<Live | null>(null)
  // The latest props, for callbacks that outlive a render.
  const props = useRef({ deck, onFocus, onClearHighlight })
  useEffect(() => {
    props.current = { deck, onFocus, onClearHighlight }
  })

  const flushLogs = useCallback(() => {
    const s = live.current
    if (s?.sessionId && s.logs.length > 0) postEvents(s.sessionId, s.logs.splice(0))
  }, [])

  const teardown = useCallback(
    (finalState: AgentState) => {
      const s = live.current
      if (!s) return
      live.current = null
      s.timers.forEach((timer) => window.clearInterval(timer))
      s.presenter.dispose()
      s.logs.push({ type: 'session_end', at_ms: Math.round(performance.now() - s.startedAt), data: { state: finalState } })
      if (s.sessionId && s.logs.length > 0) postEvents(s.sessionId, s.logs.splice(0))
      s.call?.close()
      void s.meterContext?.close().catch(() => {})
      s.mic?.getTracks().forEach((track) => track.stop())
      s.speaker.srcObject = null
      setSecondsLeft(null)
      setMuted(false)
      setState(finalState)
    },
    [],
  )

  const start = useCallback(
    async (accessCode: string) => {
      const currentDeck = props.current.deck
      if (live.current || !currentDeck) return
      setError(null)
      setNotice(null)
      setTranscript([])
      setLatencyMs(null)
      setState('connecting')

      const log = (type: string, data: Record<string, unknown> = {}) => {
        const at_ms = s.startedAt ? Math.round(performance.now() - s.startedAt) : 0
        s.logs.push({ type, at_ms, data })
      }
      const s: Live = {
        presenter: new Presenter(currentDeck, {
          send: (event) => s.call?.send(event),
          focus: (...args) => props.current.onFocus(...args),
          clearHighlight: () => props.current.onClearHighlight(),
          setState,
          setTranscript,
          setError,
          setLatency: setLatencyMs,
          log,
          endCall: () => {
            if (live.current !== s) return
            setNotice('The presentation is finished, so the call ended. Start again to replay it.')
            teardown('ended')
          },
        }),
        call: null,
        mic: null,
        speaker: Object.assign(new Audio(), { autoplay: true }),
        meterContext: createMeterContext(),
        analysers: { agent: null, user: null },
        sessionId: '',
        startedAt: 0,
        logs: [],
        timers: [],
      }
      live.current = s

      try {
        // Mic first: a denied prompt should not spend a session from the rate limit.
        s.mic = await openMicrophone()
        s.analysers.user = meter(s.meterContext, s.mic)
        const session = await createSession(accessCode)
        s.sessionId = session.session_id

        s.call = await openRealtimeCall(session.client_secret, s.mic, {
          onRemoteStream: (stream) => {
            s.speaker.srcObject = stream
            s.analysers.agent = meter(s.meterContext, stream)
          },
          onEvent: (event) => s.presenter.handle(event),
          onDrop: () => {
            if (live.current !== s) return
            setError('The call dropped. Check your connection and start again.')
            teardown('error')
          },
          onOpen: () => {
            s.startedAt = performance.now()
            log('session_start', { model: session.model })
            setSecondsLeft(session.max_seconds)
            s.timers.push(window.setInterval(flushLogs, LOG_FLUSH_MS))
            s.timers.push(
              window.setInterval(() => {
                const left = Math.max(0, Math.ceil(session.max_seconds - (performance.now() - s.startedAt) / 1000))
                setSecondsLeft(left)
                if (left === 0) {
                  setNotice(`The call reached its ${Math.round(session.max_seconds / 60)}-minute limit and ended. Start again to continue.`)
                  teardown('ended')
                }
              }, 1000),
            )
            s.presenter.start()
          },
        })
        // Ended (e.g. unmounted) while we were connecting.
        if (live.current !== s) s.call.close()
      } catch (cause) {
        setError(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Microphone access was blocked. Allow the microphone and try again.'
            : cause instanceof Error
              ? cause.message
              : 'Could not start the session.',
        )
        teardown('error')
      }
    },
    [flushLogs, teardown],
  )

  const stop = useCallback(() => teardown('ended'), [teardown])

  const micTrack = () => live.current?.mic?.getAudioTracks()[0]

  const stopSpeaking = useCallback(() => live.current?.presenter.stopSpeaking(), [])

  const presentSlide = useCallback((slide: Slide) => live.current?.presenter.goToSlide(slide.id), [])

  const toggleMute = useCallback(() => {
    const track = micTrack()
    if (!track) return
    track.enabled = !track.enabled
    setMuted(!track.enabled)
  }, [])

  /** The agent's and the user's audio analysers, for drawing the voice visual. */
  const getAnalysers = useCallback((): Analysers => live.current?.analysers ?? NO_ANALYSERS, [])

  useEffect(() => {
    window.addEventListener('pagehide', flushLogs)
    return () => {
      window.removeEventListener('pagehide', flushLogs)
      teardown('ended')
    }
  }, [flushLogs, teardown])

  return {
    state,
    live: state === 'listening' || state === 'thinking' || state === 'speaking',
    transcript,
    latencyMs,
    error,
    notice,
    muted,
    secondsLeft,
    start,
    stop,
    stopSpeaking,
    toggleMute,
    presentSlide,
    getAnalysers,
  }
}
