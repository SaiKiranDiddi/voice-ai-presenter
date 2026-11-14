import { useCallback, useEffect, useRef, useState } from 'react'
import { createSession, postEvents } from '../api'
import type { AgentState, Block, Deck, FocusMode, LoggedEvent, Slide, TranscriptLine } from '../types'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
const LOG_FLUSH_MS = 4000
/** After an answer, carry on with the deck if the user stays quiet this long. */
const AUTO_RESUME_MS = 5000
/** Output audio is 50 ms per audio token (measured; exact across short and long turns). */
const MS_PER_AUDIO_TOKEN = 50

interface PendingCall {
  call_id: string
  name: string
  arguments: string
}

/**
 * What the response currently being generated or spoken is for. It decides
 * what happens when that speech finishes:
 *   block   -> advance to the next block
 *   reply   -> wait, then resume the deck if the user stays quiet
 *   closing -> the deck is finished; just listen
 */
type TurnKind = 'block' | 'reply' | 'closing'

interface FlatBlock {
  slide: Slide
  block: Block
}

interface Options {
  deck: Deck | null
  /** Show a slide and highlight a block. */
  onFocus: (slideId: string, blockId: string, mode: FocusMode) => void
  /** Drop the highlight but keep the slide. */
  onClearHighlight: () => void
}

interface Internals {
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  stream: MediaStream | null
  audio: HTMLAudioElement | null
  sessionId: string
  startedAt: number
  maxSeconds: number
  logs: LoggedEvent[]
  flushTimer: number | undefined
  clockTimer: number | undefined
  resumeTimer: number | undefined

  // Presentation state, owned here rather than by the model.
  /** The block being spoken, or the one to resume from. Stays put if a block is cut off. */
  cursor: number
  /** The latest block asked of the model. One ahead of the cursor while the next block is prefetched. */
  requested: number
  requestedDone: boolean
  requestedEndsAt: number
  /** When the audio of the block being spoken ends (performance.now() clock). */
  audibleEndsAt: number
  /** When all audio queued so far ends. Audio tokens are 50 ms each, so this is exact. */
  runTail: number
  boundaryTimer: number | undefined
  /** Fires shortly before the current block's audio ends, to request the next block. */
  prefetchTimer: number | undefined
  /**
   * How long before the current block's audio ends the next block is requested.
   * The model takes about a second to start speaking, so this sets the pause
   * between blocks. From NEXT_BLOCK_LEAD_MS, or ?lead=<ms> in the URL.
   */
  leadMs: number
  /** Conversation items of a prefetched block that has not been heard yet. */
  prefetchedItems: string[]
  /** Transcript text of a prefetched block, held back until it is heard. */
  held: Map<string, string>
  turn: TurnKind
  deckFinished: boolean

  // Per-response bookkeeping.
  pending: PendingCall[]
  responseActive: boolean
  turnHasAudio: boolean
  audioDone: boolean
  audioPlaying: boolean
  userSpeaking: boolean
  speechStoppedAt: number | null
  /** Runs once the in-flight response has finished cancelling. */
  afterCancel: (() => void) | null
  paused: boolean
  mutedBeforePause: boolean
}

/** A silent input track, for running the presentation with no microphone (?silent). */
function silentStream(): MediaStream {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const gain = context.createGain()
  gain.gain.value = 0
  const oscillator = context.createOscillator()
  oscillator.connect(gain).connect(destination)
  oscillator.start()
  return destination.stream
}

const fresh = (): Internals => ({
  pc: null,
  dc: null,
  stream: null,
  audio: null,
  sessionId: '',
  startedAt: 0,
  maxSeconds: 600,
  logs: [],
  flushTimer: undefined,
  clockTimer: undefined,
  resumeTimer: undefined,
  cursor: 0,
  requested: 0,
  requestedDone: true,
  requestedEndsAt: 0,
  audibleEndsAt: 0,
  runTail: 0,
  boundaryTimer: undefined,
  prefetchTimer: undefined,
  leadMs: 700,
  prefetchedItems: [],
  held: new Map(),
  turn: 'block',
  deckFinished: false,
  pending: [],
  responseActive: false,
  turnHasAudio: false,
  audioDone: false,
  audioPlaying: false,
  userSpeaking: false,
  speechStoppedAt: null,
  afterCancel: null,
  paused: false,
  mutedBeforePause: false,
})

/**
 * Owns the WebRTC call to the OpenAI Realtime API and the presentation flow.
 *
 * The model is the voice and the judgement (which block answers a question).
 * This hook is the sequencer: it decides which block is presented next, when
 * to resume after a question, and where to resume from. Audio goes browser
 * <-> OpenAI directly; JSON events on the data channel drive everything else.
 */
export function useRealtimeSession({ deck, onFocus, onClearHighlight }: Options) {
  const [state, setState] = useState<AgentState>('idle')
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  const s = useRef<Internals>(fresh())
  const deckRef = useRef(deck)
  const onFocusRef = useRef(onFocus)
  const onClearRef = useRef(onClearHighlight)
  useEffect(() => {
    deckRef.current = deck
    onFocusRef.current = onFocus
    onClearRef.current = onClearHighlight
  })

  const flatBlocks = useCallback(
    (): FlatBlock[] => (deckRef.current?.slides ?? []).flatMap((slide) => slide.blocks.map((block) => ({ slide, block }))),
    [],
  )

  const log = useCallback((type: string, data: Record<string, unknown> = {}) => {
    const at_ms = s.current.startedAt ? Math.round(performance.now() - s.current.startedAt) : 0
    s.current.logs.push({ type, at_ms, data })
  }, [])

  const flushLogs = useCallback(() => {
    if (!s.current.sessionId || s.current.logs.length === 0) return
    postEvents(s.current.sessionId, s.current.logs.splice(0))
  }, [])

  const send = useCallback((event: Record<string, unknown>) => {
    const dc = s.current.dc
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(event))
  }, [])

  const sendSystemNote = useCallback(
    (text: string) => {
      send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
      })
    },
    [send],
  )

  const sendToolOutput = useCallback(
    (callId: string, output: unknown) => {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      })
    },
    [send],
  )

  /** Ask the model to speak. Tools are off for turns where we already know what it should say. */
  const requestSpeech = useCallback(
    (turn: TurnKind) => {
      s.current.turn = turn
      send({ type: 'response.create', response: { tool_choice: 'none' } })
      setState('thinking')
    },
    [send],
  )

  const cancelResumeTimer = useCallback(() => {
    window.clearTimeout(s.current.resumeTimer)
    s.current.resumeTimer = undefined
  }, [])

  // ---- transcript helpers -------------------------------------------------

  const upsertLine = useCallback(
    (id: string, role: TranscriptLine['role'], update: (line: TranscriptLine) => TranscriptLine) => {
      setTranscript((lines) => {
        const index = lines.findIndex((line) => line.id === id)
        if (index === -1) return [...lines, update({ id, role, text: '' })]
        const next = lines.slice()
        next[index] = update(lines[index])
        return next
      })
    },
    [],
  )

  const markAgentInterrupted = useCallback(() => {
    setTranscript((lines) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].role === 'agent') {
          if (lines[i].interrupted) return lines
          const next = lines.slice()
          next[i] = { ...lines[i], interrupted: true }
          return next
        }
      }
      return lines
    })
  }, [])

  // ---- the sequencer ------------------------------------------------------

  /** Drop a prefetched block that has not been heard, and stop the hand-over timer. */
  const resetChain = useCallback(() => {
    const st = s.current
    window.clearTimeout(st.boundaryTimer)
    st.boundaryTimer = undefined
    window.clearTimeout(st.prefetchTimer)
    st.prefetchTimer = undefined
    if (st.requested > st.cursor) {
      // The model generated it but the physician never heard it: remove it
      // from the conversation so the model does not believe it was said.
      for (const id of st.prefetchedItems) send({ type: 'conversation.item.delete', item_id: id })
    }
    st.prefetchedItems = []
    st.held.clear()
    st.requested = st.cursor
    st.requestedDone = true
  }, [send])

  /** Ask the model to speak block `index` (or the closing line). Changes nothing on screen. */
  const requestBlock = useCallback(
    (index: number, lead: 'greeting' | 'resume' | 'jump' | 'next') => {
      const st = s.current
      const blocks = flatBlocks()
      st.requested = index
      st.requestedDone = false

      if (index >= blocks.length) {
        st.turn = 'closing'
        sendSystemNote(
          'CLOSE: The deck is finished. Thank the physician in one sentence and ask whether they have any questions.',
        )
      } else {
        st.turn = 'block'
        const { slide, block } = blocks[index]
        const agenda = (deckRef.current?.slides ?? []).map((sl) => sl.nav.toLowerCase()).join(', ')
        const startsSlide = slide.blocks[0].id === block.id
        const opening = {
          greeting: `First say one sentence that greets the physician and names what you will cover (${agenda}), and one short sentence that they can interrupt with questions at any time. Then present this:`,
          resume: 'Say "Back to the presentation." and then present this:',
          jump: 'Present this now:',
          next: startsSlide
            ? 'This starts a new slide. Name its topic in three or four words as you begin, with no recap, and present this:'
            : 'Carry straight on, with no lead-in or recap, and present this:',
        }[lead]

        // Only the talking point is sent, not the full fact list: the slide
        // shows the detail, and handing over every fact invites reciting it.
        sendSystemNote(
          `PRESENT: ${opening}\n` +
            `Slide: ${slide.title}\n` +
            `Talking point: ${block.talking_point}\n` +
            'Say this in ONE short sentence of 20 words or fewer: the headline only. The slide shows the details, so do not list them or add anything. ' +
            'Then stop. Do not ask a question, do not ask whether to continue, and do not mention what comes next.',
        )
      }
      // Tools are off: we already know what this turn should say.
      send({ type: 'response.create', response: { tool_choice: 'none' } })
    },
    [flatBlocks, send, sendSystemNote],
  )

  /** Block `index` is now the one being heard: move the cursor, the highlight, and the transcript. */
  const makeAudible = useCallback(
    (index: number) => {
      const st = s.current
      const blocks = flatBlocks()
      st.cursor = Math.min(index, blocks.length)
      st.prefetchedItems = []
      for (const [id, text] of st.held) upsertLine(id, 'agent', (line) => ({ ...line, text }))
      st.held.clear()
      if (index >= blocks.length) {
        st.deckFinished = true
        onClearRef.current()
        log('deck_finished')
      } else {
        const { slide, block } = blocks[index]
        st.deckFinished = false
        onFocusRef.current(slide.id, block.id, 'presenting')
        log('present_block', { block_id: block.id })
      }
    },
    [flatBlocks, log, upsertLine],
  )

  /** Start (or restart) presenting from block `index`, from silence. */
  const presentFrom = useCallback(
    (index: number, lead: 'greeting' | 'resume' | 'jump' | 'next') => {
      cancelResumeTimer()
      resetChain()
      requestBlock(index, lead)
      makeAudible(index)
      setState('thinking')
    },
    [cancelResumeTimer, makeAudible, requestBlock, resetChain],
  )

  /**
   * Shortly before a block finishes (leadMs), have the model generate the next
   * one. Its audio starts about a second after the request, so the result is a
   * short, natural pause; requesting earlier would queue it with no gap at all.
   * A timer moves the highlight when the current block's audio ends.
   */
  const tryPrefetchRef = useRef<() => void>(() => {})
  const tryPrefetch = useCallback(() => {
    const st = s.current
    window.clearTimeout(st.prefetchTimer)
    st.prefetchTimer = undefined
    if (!st.pc || st.paused || st.userSpeaking || st.pending.length > 0) return
    if (st.turn !== 'block' || st.requested !== st.cursor || !st.requestedDone) return
    const wait = st.audibleEndsAt - st.leadMs - performance.now()
    if (wait > 0) {
      // Too early: come back then. The checks above run again at that point.
      st.prefetchTimer = window.setTimeout(() => tryPrefetchRef.current(), wait)
      return
    }
    requestBlock(st.cursor + 1, 'next')
    const delay = Math.max(0, st.audibleEndsAt - performance.now())
    st.boundaryTimer = window.setTimeout(() => {
      const now = s.current
      if (!now.pc || now.requested <= now.cursor) return
      makeAudible(now.requested)
      if (now.requestedDone) {
        now.audibleEndsAt = now.requestedEndsAt
        tryPrefetchRef.current()
      }
    }, delay)
  }, [makeAudible, requestBlock])
  useEffect(() => {
    tryPrefetchRef.current = tryPrefetch
  })

  /** The agent finished speaking and the audio has drained. Decide what happens next. */
  const onTurnFinished = useCallback(() => {
    const st = s.current
    switch (st.turn) {
      case 'block':
        // Normally the next block was prefetched and the timer brings it on.
        // This is the fallback if nothing is in flight.
        if (st.requested <= st.cursor) presentFrom(st.cursor + 1, 'next')
        break
      case 'reply':
        setState('listening')
        if (!st.deckFinished) {
          // Hands-free: nobody should have to say "continue" after every answer.
          cancelResumeTimer()
          st.resumeTimer = window.setTimeout(() => {
            if (s.current.pc && !s.current.userSpeaking && !s.current.responseActive) {
              log('auto_resume')
              presentFrom(s.current.cursor, 'resume')
            }
          }, AUTO_RESUME_MS)
        }
        break
      case 'closing':
        setState('listening')
        break
    }
  }, [cancelResumeTimer, log, presentFrom])

  // ---- tools --------------------------------------------------------------

  /** Run the model's tool calls. Only the first one acts; a turn does one thing. */
  const processPending = useCallback(() => {
    const st = s.current
    const calls = st.pending.splice(0)
    if (calls.length === 0) return
    const [call, ...extra] = calls
    for (const other of extra) sendToolOutput(other.call_id, { ok: false, ignored: 'one tool call per turn' })

    const slides = deckRef.current?.slides ?? []
    let args: { slide_id?: string; block_id?: string } = {}
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      // handled below as unknown ids
    }
    log('tool_call', { name: call.name, ...args })

    if (call.name === 'show_answer') {
      // The block id is the source of truth. Tolerate a mismatched slide_id and
      // near-miss ids such as "dosing_schedule" for "dosing.schedule".
      const loose = (id: string | undefined) => (id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const wanted = loose(args.block_id)
      let slide = slides.find((sl) => sl.blocks.some((b) => loose(b.id) === wanted))
      let block = slide?.blocks.find((b) => loose(b.id) === wanted)
      if (!block) {
        slide = slides.find((sl) => sl.id === args.slide_id)
        block = slide?.blocks[0]
      }
      if (!slide || !block) {
        sendToolOutput(call.call_id, {
          ok: false,
          error: 'unknown slide_id or block_id',
          valid_block_ids: slides.flatMap((sl) => sl.blocks.map((b) => b.id)),
        })
        st.turn = 'reply'
        send({ type: 'response.create' })
        setState('thinking')
        return
      }
      onFocusRef.current(slide.id, block.id, 'answering')
      sendToolOutput(call.call_id, {
        ok: true,
        facts: block.facts,
        instruction: st.deckFinished
          ? 'Answer now in one or two short sentences using only these facts.'
          : 'Answer now in one or two short sentences using only these facts. Give the point, not every number. End with: "Anything else, or shall I carry on?"',
      })
      requestSpeech('reply')
      return
    }

    if (call.name === 'continue_presentation') {
      sendToolOutput(call.call_id, { ok: true })
      presentFrom(st.cursor, 'resume')
      return
    }

    if (call.name === 'present_slide') {
      const blocks = flatBlocks()
      const index = blocks.findIndex((entry) => entry.slide.id === args.slide_id)
      if (index === -1) {
        sendToolOutput(call.call_id, { ok: false, error: 'unknown slide_id', valid_slide_ids: slides.map((sl) => sl.id) })
        st.turn = 'reply'
        send({ type: 'response.create' })
        setState('thinking')
        return
      }
      sendToolOutput(call.call_id, { ok: true })
      presentFrom(index, 'jump')
      return
    }

    sendToolOutput(call.call_id, { ok: false, error: `unknown tool ${call.name}` })
    requestSpeech('reply')
  }, [flatBlocks, log, presentFrom, requestSpeech, send, sendToolOutput])

  /** Close out queued tool calls without acting on them, e.g. after a barge-in. */
  const dropPending = useCallback(
    (reason: string) => {
      for (const call of s.current.pending.splice(0)) {
        sendToolOutput(call.call_id, { ok: false, not_done: true, reason })
      }
    },
    [sendToolOutput],
  )

  /**
   * A response is over only when the model has finished generating AND the
   * audio has finished playing. The model generates faster than it speaks, so
   * acting on response.done alone would move the slide mid-sentence.
   */
  const maybeFinishTurn = useCallback(() => {
    const st = s.current
    if (st.responseActive) return
    if (st.userSpeaking) {
      // The user is mid-sentence; their turn decides what happens next.
      dropPending('the physician is speaking')
      return
    }
    if (st.turnHasAudio && !st.audioDone) return
    if (st.pending.length > 0) processPending()
    else onTurnFinished()
  }, [dropPending, onTurnFinished, processPending])

  /** Stop the agent mid-speech, then run `next` once the server confirms. */
  const cancelSpeech = useCallback(
    (next: (() => void) | null) => {
      const st = s.current
      cancelResumeTimer()
      resetChain()
      dropPending('cancelled by the physician')
      if (st.audioPlaying || st.turnHasAudio) send({ type: 'output_audio_buffer.clear' })
      st.audioPlaying = false
      const then = next ?? (() => setState('listening'))
      if (st.responseActive) {
        st.afterCancel = then
        send({ type: 'response.cancel' })
      } else {
        then()
      }
    },
    [cancelResumeTimer, dropPending, resetChain, send],
  )

  // ---- server events ------------------------------------------------------

  const handleEvent = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => {
      const st = s.current
      // Record every non-streaming server event so a call can be replayed from its log.
      if (!event.type.endsWith('.delta')) log('ev', { t: event.type, status: event.response?.status })
      switch (event.type) {
        case 'response.created':
          st.responseActive = true
          st.turnHasAudio = false
          st.audioDone = false
          break

        case 'input_audio_buffer.speech_started': {
          // Barge-in. The server cancels the response and clears its audio for
          // us. The cursor is left alone, so the deck later resumes from the
          // block that was cut off. Whatever the model says next is a reply.
          const wasTalking = st.audioPlaying || st.responseActive
          st.userSpeaking = true
          st.audioPlaying = false
          st.afterCancel = null
          st.turn = 'reply'
          cancelResumeTimer()
          resetChain()
          if (wasTalking) {
            markAgentInterrupted()
            log('interruption')
          }
          dropPending('the physician interrupted')
          setState('listening')
          upsertLine(event.item_id, 'user', (line) => ({ ...line, text: line.text || '…' }))
          break
        }

        case 'input_audio_buffer.speech_stopped':
          st.userSpeaking = false
          st.speechStoppedAt = performance.now()
          setState('thinking')
          break

        case 'conversation.item.input_audio_transcription.completed': {
          const text = (event.transcript ?? '').trim()
          if (text) {
            upsertLine(event.item_id, 'user', (line) => ({ ...line, text }))
            log('user_transcript', { text })
          } else {
            setTranscript((lines) => lines.filter((line) => line.id !== event.item_id))
          }
          break
        }

        case 'response.output_audio_transcript.delta':
          st.turnHasAudio = true
          if (st.requested > st.cursor && st.turn !== 'reply') {
            // Prefetched and not heard yet: keep it out of the transcript for now.
            st.held.set(event.item_id, (st.held.get(event.item_id) ?? '') + event.delta)
          } else {
            upsertLine(event.item_id, 'agent', (line) => ({ ...line, text: line.text + event.delta }))
          }
          break

        case 'response.output_audio_transcript.done':
          if (st.held.has(event.item_id)) {
            st.held.set(event.item_id, event.transcript ?? st.held.get(event.item_id) ?? '')
          } else {
            upsertLine(event.item_id, 'agent', (line) => ({ ...line, text: event.transcript ?? line.text }))
          }
          log('agent_transcript', { text: event.transcript })
          break

        case 'response.function_call_arguments.done':
          st.pending.push({ call_id: event.call_id, name: event.name, arguments: event.arguments })
          break

        case 'response.done': {
          st.responseActive = false
          const status = event.response?.status
          if (status === 'failed') {
            const message = event.response?.status_details?.error?.message ?? 'The model response failed.'
            setError(message)
            log('error', { message })
          }
          // A cancel we asked for wins even if the response managed to finish
          // first; otherwise the deck would carry on after "Stop talking".
          if (status === 'cancelled' || st.afterCancel) {
            dropPending('cancelled')
            const next = st.afterCancel
            st.afterCancel = null
            if (next) next()
            else if (!st.userSpeaking) setState('listening')
            break
          }
          if (status === 'completed') {
            // Work out when this response's audio ends. It plays straight
            // after whatever is already queued.
            const now = performance.now()
            const tokens = event.response?.usage?.output_token_details?.audio_tokens ?? 0
            if (!st.audioPlaying && st.runTail < now) st.runTail = now
            st.runTail += tokens * MS_PER_AUDIO_TOKEN
            if (st.turn !== 'reply' && !st.requestedDone) {
              st.requestedDone = true
              st.requestedEndsAt = st.runTail
              if (st.requested > st.cursor) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                st.prefetchedItems = (event.response?.output ?? []).map((item: any) => item.id)
              } else {
                st.audibleEndsAt = st.runTail
                tryPrefetch()
              }
            }
          }
          maybeFinishTurn()
          break
        }

        case 'output_audio_buffer.started': {
          // Audio (re)starts now, e.g. after the pause between blocks. Keep a
          // tail already computed into the future; reset a stale one.
          const now = performance.now()
          if (st.runTail < now) st.runTail = now
          st.audioPlaying = true
          st.audioDone = false
          st.turnHasAudio = true
          setState('speaking')
          if (st.speechStoppedAt !== null) {
            const ms = Math.round(performance.now() - st.speechStoppedAt)
            st.speechStoppedAt = null
            setLatencyMs(ms)
            log('latency', { ms })
          }
          break
        }

        case 'output_audio_buffer.stopped':
          st.audioPlaying = false
          st.audioDone = true
          maybeFinishTurn()
          break

        case 'output_audio_buffer.cleared':
          st.audioPlaying = false
          break

        case 'error': {
          const code = event.error?.code
          // Cancelling when nothing is in flight is expected and harmless.
          if (code === 'response_cancel_not_active') {
            const next = st.afterCancel
            st.afterCancel = null
            st.responseActive = false
            if (next) next()
            break
          }
          const message = event.error?.message ?? 'Realtime error'
          setError(message)
          log('error', { code, message })
          break
        }
      }
    },
    [cancelResumeTimer, dropPending, log, markAgentInterrupted, maybeFinishTurn, resetChain, tryPrefetch, upsertLine],
  )

  // ---- lifecycle ----------------------------------------------------------

  const teardown = useCallback(
    (finalState: AgentState) => {
      const st = s.current
      window.clearInterval(st.flushTimer)
      window.clearInterval(st.clockTimer)
      window.clearTimeout(st.resumeTimer)
      window.clearTimeout(st.boundaryTimer)
      window.clearTimeout(st.prefetchTimer)
      log('session_end', { state: finalState })
      flushLogs()
      st.dc?.close()
      st.pc?.close()
      st.stream?.getTracks().forEach((track) => track.stop())
      if (st.audio) st.audio.srcObject = null
      s.current = fresh()
      setSecondsLeft(null)
      setMuted(false)
      setPaused(false)
      setState(finalState)
    },
    [flushLogs, log],
  )

  const stop = useCallback(() => {
    if (s.current.pc) teardown('ended')
  }, [teardown])

  const start = useCallback(
    async (accessCode: string) => {
      if (s.current.pc) return
      setError(null)
      setNotice(null)
      setTranscript([])
      setLatencyMs(null)
      setState('connecting')
      const st = s.current
      try {
        // Mic first: a denied prompt should not spend a session from the rate limit.
        const stream = new URLSearchParams(window.location.search).has('silent')
          ? silentStream()
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            })
        st.stream = stream
        const session = await createSession(accessCode)
        st.sessionId = session.session_id
        st.maxSeconds = session.max_seconds
        // ?lead=<ms> overrides the server setting, for tuning the pause by ear.
        const params = new URLSearchParams(window.location.search)
        const leadMs = params.has('lead') ? Number(params.get('lead')) : session.next_block_lead_ms
        st.leadMs = Number.isFinite(leadMs) && leadMs >= 0 ? leadMs : 700

        const pc = new RTCPeerConnection()
        st.pc = pc
        const audio = new Audio()
        audio.autoplay = true
        st.audio = audio
        pc.ontrack = (event) => {
          audio.srcObject = event.streams[0]
        }
        pc.addTrack(stream.getAudioTracks()[0], stream)
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setError('The call dropped. Check your connection and start again.')
            if (s.current.pc === pc) teardown('error')
          }
        }

        const dc = pc.createDataChannel('oai-events')
        st.dc = dc
        dc.onmessage = (message) => handleEvent(JSON.parse(message.data))
        dc.onopen = () => {
          st.startedAt = performance.now()
          log('session_start', { model: session.model, lead_ms: st.leadMs })
          presentFrom(0, 'greeting')
          setSecondsLeft(st.maxSeconds)
          st.flushTimer = window.setInterval(flushLogs, LOG_FLUSH_MS)
          st.clockTimer = window.setInterval(() => {
            const elapsed = (performance.now() - st.startedAt) / 1000
            const left = Math.max(0, Math.ceil(st.maxSeconds - elapsed))
            setSecondsLeft(left)
            if (left === 0) {
              setNotice(
                `The call reached its ${Math.round(st.maxSeconds / 60)}-minute limit and ended. Start again to continue.`,
              )
              teardown('ended')
            }
          }, 1000)
        }

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const answer = await fetch(CALLS_URL, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${session.client_secret}`,
            'Content-Type': 'application/sdp',
          },
        })
        if (!answer.ok) throw new Error(`OpenAI rejected the call (${answer.status}).`)
        await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
      } catch (cause) {
        const message =
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Microphone access was blocked. Allow the microphone and try again.'
            : cause instanceof Error
              ? cause.message
              : 'Could not start the session.'
        setError(message)
        teardown('error')
      }
    },
    [flushLogs, handleEvent, log, presentFrom, teardown],
  )

  /** Manual barge-in: silence the agent and wait. It does not auto-resume after this. */
  const stopSpeaking = useCallback(() => {
    if (!s.current.pc) return
    markAgentInterrupted()
    log('interruption', { via: 'button' })
    cancelSpeech(null)
  }, [cancelSpeech, log, markAgentInterrupted])

  /** The user clicked a slide: stop whatever is being said and present that slide. */
  const presentSlide = useCallback(
    (slide: Slide) => {
      const st = s.current
      if (!st.pc) return
      const index = flatBlocks().findIndex((entry) => entry.slide.id === slide.id)
      if (index === -1) return
      if (st.audioPlaying || st.responseActive) markAgentInterrupted()
      if (st.paused) {
        // A click while paused just moves the bookmark; Resume starts from there.
        cancelSpeech(null)
        st.cursor = index
        st.requested = index
        st.deckFinished = false
        setState('paused')
        return
      }
      log('manual_nav', { slide_id: slide.id })
      cancelSpeech(() => presentFrom(index, 'jump'))
    },
    [cancelSpeech, flatBlocks, log, markAgentInterrupted, presentFrom],
  )

  /**
   * Pause: stop speaking, stop listening, and hold position. The audio is a
   * live stream, so it cannot be frozen mid-word; resuming repeats the block
   * that was cut off.
   */
  const pause = useCallback(() => {
    const st = s.current
    if (!st.pc || st.paused) return
    st.paused = true
    setPaused(true)
    const track = st.stream?.getAudioTracks()[0]
    if (track) {
      st.mutedBeforePause = !track.enabled
      track.enabled = false
    }
    if (st.audioPlaying || st.responseActive) markAgentInterrupted()
    log('pause')
    cancelSpeech(() => setState('paused'))
  }, [cancelSpeech, log, markAgentInterrupted])

  const resume = useCallback(() => {
    const st = s.current
    if (!st.pc || !st.paused) return
    st.paused = false
    setPaused(false)
    const track = st.stream?.getAudioTracks()[0]
    if (track) track.enabled = !st.mutedBeforePause
    log('resume')
    if (st.deckFinished) setState('listening')
    else presentFrom(st.cursor, 'jump')
  }, [log, presentFrom])

  const toggleMute = useCallback(() => {
    const track = s.current.stream?.getAudioTracks()[0]
    if (!track || s.current.paused) return
    track.enabled = !track.enabled
    setMuted(!track.enabled)
  }, [])

  useEffect(() => {
    const onHide = () => flushLogs()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      if (s.current.pc) teardown('ended')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const live = state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'paused'

  return {
    state,
    live,
    transcript,
    latencyMs,
    error,
    notice,
    muted,
    paused,
    secondsLeft,
    start,
    stop,
    stopSpeaking,
    pause,
    resume,
    toggleMute,
    presentSlide,
  }
}
