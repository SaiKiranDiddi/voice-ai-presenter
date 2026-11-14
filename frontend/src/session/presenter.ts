/**
 * The presentation flow, with no React, WebRTC or DOM in it.
 *
 * The model is the voice and the judgement (which block answers a question).
 * The Presenter is the sequencer: it decides which block is presented next,
 * when to resume after a question, and where to resume from.
 *
 * It reacts to two kinds of input:
 *   - server events from the Realtime data channel: handle(event)
 *   - the user's buttons: start, stopSpeaking, goToSlide, pause, resume
 * and acts only through the PresenterIO functions it is given, so tests can
 * drive it with a fake `send` and fake timers.
 *
 * The rule that keeps it simple: a turn is finished only when the model has
 * stopped generating AND its audio has stopped playing. Then, and only then,
 * the next thing happens (next block, a tool call, or waiting for the user).
 */
import type { AgentState, Deck, FocusMode, TranscriptLine } from '../types'
import { flattenDeck, firstBlockOfSlide, type FlatBlock } from './deck'
import { answerInstruction, closeNote, presentNote, type Lead } from './notes'
import { resolveToolCall, type ToolCall } from './tools'
import { markAgentInterrupted, removeLine, upsertLine } from './transcript'

/** After an answer, carry on with the deck if the user stays quiet this long. */
export const AUTO_RESUME_MS = 5000
/** Once the deck is finished, end the call if the user stays quiet this long. */
export const END_AFTER_CLOSE_MS = 15000

export interface PresenterIO {
  /** Send a client event to the Realtime API over the data channel. */
  send: (event: Record<string, unknown>) => void
  /** Show a slide and highlight a block. */
  focus: (slideId: string, blockId: string, mode: FocusMode) => void
  /** Drop the highlight but keep the slide. */
  clearHighlight: () => void
  setState: (state: AgentState) => void
  setTranscript: (lines: TranscriptLine[]) => void
  setError: (message: string) => void
  /** Time from the end of the user's speech to the agent's first audio. */
  setLatency: (ms: number) => void
  log: (type: string, data?: Record<string, unknown>) => void
  /** The deck is finished and the user went quiet: hang up. */
  endCall: () => void
}

/** The fields of a Realtime server event that the presenter reads. */
export interface ServerEvent {
  type: string
  item_id?: string
  delta?: string
  transcript?: string
  call_id?: string
  name?: string
  arguments?: string
  response?: { status?: string; status_details?: { error?: { message?: string } } }
  /** event_id names the client event that caused the error, when there is one. */
  error?: { code?: string; message?: string; event_id?: string }
}

/**
 * What the response being generated or spoken is for. It decides what happens
 * when that turn finishes:
 *   block   -> present the next block
 *   reply   -> wait, then resume the deck if the user stays quiet
 *   closing -> the deck is finished; listen, and end the call if the user stays quiet
 *   idle    -> speech was cancelled by a button; do nothing until told
 */
type TurnKind = 'block' | 'reply' | 'closing' | 'idle'

export class Presenter {
  private readonly deck: Deck
  private readonly io: PresenterIO
  private readonly blocks: FlatBlock[]

  /** The block being presented, and the one to resume from after a question. */
  cursor = 0
  deckFinished = false
  paused = false
  transcript: TranscriptLine[] = []

  private turn: TurnKind = 'block'
  /** Tool calls from the current response, run once its turn finishes. */
  private pending: ToolCall[] = []
  /** A response is in flight: from the moment we ask for one until response.done. */
  private responseActive = false
  /** We sent response.create and the server has not confirmed it with response.created yet. */
  private awaitingCreated = false
  /** event_id of our latest response.create, so an error can be matched to it. */
  private createEventId = ''
  private createCount = 0
  private turnHasAudio = false
  private audioDone = false
  private audioPlaying = false
  private userSpeaking = false
  private speechStoppedAt: number | null = null
  /** Runs once the response we asked to cancel has finished cancelling. */
  private afterCancel: (() => void) | null = null
  private resumeTimer: ReturnType<typeof setTimeout> | undefined
  private endTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deck: Deck, io: PresenterIO) {
    this.deck = deck
    this.io = io
    this.blocks = flattenDeck(deck)
  }

  // ---- user actions ---------------------------------------------------------

  /** The call is open: greet and present the first block. */
  start(): void {
    this.presentFrom(0, 'greeting')
  }

  /** Stop button: silence the agent and wait. No auto-resume after this. */
  stopSpeaking(): void {
    this.markInterruptedIfTalking()
    this.io.log('interruption', { via: 'button' })
    this.cancelSpeech(null)
  }

  /** The user picked a slide: stop whatever is being said and present it. */
  goToSlide(slideId: string): void {
    const index = firstBlockOfSlide(this.deck, slideId)
    if (index === -1) return
    if (this.paused) {
      // Speech was already cancelled by pause; just move the bookmark.
      this.cursor = index
      this.deckFinished = false
      return
    }
    this.markInterruptedIfTalking()
    this.io.log('manual_nav', { slide_id: slideId })
    this.cancelSpeech(() => this.presentFrom(index, 'jump'))
  }

  /** Stop speaking and hold position. Resuming repeats the block that was cut off. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.markInterruptedIfTalking()
    this.io.log('pause')
    this.cancelSpeech(() => this.io.setState('paused'))
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.io.log('resume')
    const go = () => {
      if (!this.deckFinished) return this.presentFrom(this.cursor, 'jump')
      this.io.setState('listening')
      this.scheduleEnd()
    }
    // If the pause's cancel has not landed yet, resume once it has.
    if (this.responseActive) this.afterCancel = go
    else go()
  }

  /** The call is over: stop any pending timer. */
  dispose(): void {
    this.cancelTimers()
  }

  // ---- server events --------------------------------------------------------

  handle(event: ServerEvent): void {
    // Record every non-streaming event so a call can be replayed from its log.
    if (!event.type.endsWith('.delta')) this.io.log('ev', { t: event.type, status: event.response?.status })

    switch (event.type) {
      case 'response.created':
        this.responseActive = true
        this.awaitingCreated = false
        this.turnHasAudio = false
        this.audioDone = false
        // A cancel requested before the server confirmed the response is sent now.
        if (this.afterCancel) this.io.send({ type: 'response.cancel' })
        break

      case 'input_audio_buffer.speech_started': {
        // Barge-in. The server cancels the response and clears its audio for
        // us (interrupt_response). The cursor is left alone, so the deck later
        // resumes from the block that was cut off. What the model says next is a reply.
        const wasTalking = this.audioPlaying || this.responseActive
        this.userSpeaking = true
        this.audioPlaying = false
        this.afterCancel = null
        this.turn = 'reply'
        this.cancelTimers()
        if (wasTalking) {
          this.updateTranscript(markAgentInterrupted)
          this.io.log('interruption')
        }
        this.dropPending('the user interrupted')
        this.io.setState('listening')
        const id = event.item_id ?? ''
        this.updateTranscript((lines) => upsertLine(lines, id, 'user', (line) => ({ ...line, text: line.text || '…' })))
        break
      }

      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false
        this.speechStoppedAt = performance.now()
        this.io.setState('thinking')
        break

      case 'conversation.item.input_audio_transcription.completed': {
        const id = event.item_id ?? ''
        const text = (event.transcript ?? '').trim()
        if (text) {
          this.updateTranscript((lines) => upsertLine(lines, id, 'user', (line) => ({ ...line, text })))
          this.io.log('user_transcript', { text })
        } else {
          // Noise, not speech: a cough, a door. Remove it from the model's
          // conversation too. Left there, it stays an unanswered user turn
          // and the model keeps trying to answer it instead of presenting.
          this.updateTranscript((lines) => removeLine(lines, id))
          this.io.send({ type: 'conversation.item.delete', event_id: `delete_${id}`, item_id: id })
          this.io.log('noise_removed', { item_id: id })
          // After the close, noise must not keep the call open: if no reply
          // follows, the end timer starts again. A reply restarts it anyway.
          if (this.deckFinished && !this.responseActive && !this.userSpeaking && !this.paused) this.scheduleEnd()
        }
        break
      }

      case 'response.output_audio_transcript.delta': {
        this.turnHasAudio = true
        const delta = event.delta ?? ''
        this.updateTranscript((lines) =>
          upsertLine(lines, event.item_id ?? '', 'agent', (line) => ({ ...line, text: line.text + delta })),
        )
        break
      }

      case 'response.output_audio_transcript.done': {
        const full = event.transcript
        this.updateTranscript((lines) =>
          upsertLine(lines, event.item_id ?? '', 'agent', (line) => ({ ...line, text: full ?? line.text })),
        )
        this.io.log('agent_transcript', { text: full })
        break
      }

      case 'response.function_call_arguments.done':
        this.pending.push({ call_id: event.call_id ?? '', name: event.name ?? '', arguments: event.arguments ?? '' })
        break

      case 'response.done': {
        this.responseActive = false
        const status = event.response?.status
        if (status === 'failed') {
          const message = event.response?.status_details?.error?.message ?? 'The model response failed.'
          this.io.setError(message)
          this.io.log('error', { message })
        }
        // A cancel we asked for wins even if the response managed to finish
        // first; otherwise the deck would carry on after "Stop".
        if (status === 'cancelled' || this.afterCancel) {
          this.dropPending('cancelled')
          const next = this.afterCancel
          this.afterCancel = null
          if (next) next()
          else if (!this.userSpeaking) this.io.setState('listening')
          break
        }
        this.maybeFinishTurn()
        break
      }

      case 'output_audio_buffer.started':
        this.audioPlaying = true
        this.audioDone = false
        this.turnHasAudio = true
        this.io.setState('speaking')
        if (this.speechStoppedAt !== null) {
          const ms = Math.round(performance.now() - this.speechStoppedAt)
          this.speechStoppedAt = null
          this.io.setLatency(ms)
          this.io.log('latency', { ms })
        }
        break

      case 'output_audio_buffer.stopped':
        this.audioPlaying = false
        this.audioDone = true
        this.maybeFinishTurn()
        break

      case 'output_audio_buffer.cleared':
        this.audioPlaying = false
        break

      case 'error': {
        const code = event.error?.code
        if (this.awaitingCreated && event.error?.event_id === this.createEventId) {
          this.onCreateRejected(code, event.error?.message)
          break
        }
        if (event.error?.event_id?.startsWith('delete_')) {
          // Removing a noise turn is housekeeping; if it fails, the call goes on.
          this.io.log('error', { code, event_id: event.error.event_id })
          break
        }
        // Cancelling when nothing is in flight is expected and harmless.
        if (code === 'response_cancel_not_active') {
          // Our response is still being set up; the cancel goes out on response.created.
          if (this.awaitingCreated) break
          const next = this.afterCancel
          this.afterCancel = null
          this.responseActive = false
          if (next) next()
          break
        }
        if (code === 'conversation_already_has_active_response') {
          // Our request was refused because another response is running. Its
          // response.done will arrive and the flow carries on from there.
          this.awaitingCreated = false
          this.io.log('error', { code })
          break
        }
        const message = event.error?.message ?? 'Realtime error'
        this.io.setError(message)
        this.io.log('error', { code, message })
        break
      }
    }
  }

  // ---- the sequencer --------------------------------------------------------

  /** Present block `index` (or the closing line past the last block), from silence. */
  private presentFrom(index: number, lead: Lead): void {
    this.cancelTimers()
    this.cursor = Math.min(index, this.blocks.length)
    if (this.cursor === this.blocks.length) {
      this.turn = 'closing'
      this.deckFinished = true
      this.io.clearHighlight()
      this.io.log('deck_finished')
      this.speakNote(closeNote(this.deck))
    } else {
      this.turn = 'block'
      this.deckFinished = false
      const { slide, block } = this.blocks[this.cursor]
      this.io.focus(slide.id, block.id, 'presenting')
      this.io.log('present_block', { block_id: block.id })
      this.speakNote(presentNote(this.deck, this.cursor, lead))
    }
    this.io.setState('thinking')
  }

  /** Generation and playback have both finished: decide what happens next. */
  private maybeFinishTurn(): void {
    if (this.responseActive) return
    if (this.userSpeaking) {
      // The user is mid-sentence; their turn decides what happens next.
      this.dropPending('the user is speaking')
      return
    }
    // The model generates faster than it speaks; wait for the audio to drain
    // so the slide never moves mid-sentence.
    if (this.turnHasAudio && !this.audioDone) return

    if (this.pending.length > 0) {
      this.runToolCall()
      return
    }
    switch (this.turn) {
      case 'block':
        this.presentFrom(this.cursor + 1, 'next')
        break
      case 'reply':
        this.io.setState('listening')
        if (this.deckFinished) this.scheduleEnd()
        else this.scheduleAutoResume()
        break
      case 'closing':
        this.io.setState('listening')
        this.scheduleEnd()
        break
      case 'idle':
        this.io.setState('listening')
        break
    }
  }

  /** Act on the model's tool call. Only the first one acts; a turn does one thing. */
  private runToolCall(): void {
    const [call, ...extra] = this.pending.splice(0)
    for (const other of extra) this.toolOutput(other.call_id, { ok: false, ignored: 'one tool call per turn' })

    const action = resolveToolCall(this.deck, call)
    this.io.log('tool_call', { name: call.name, arguments: call.arguments, action: action.kind })

    switch (action.kind) {
      case 'answer':
        this.io.focus(action.slideId, action.blockId, 'answering')
        this.toolOutput(call.call_id, {
          ok: true,
          facts: action.facts,
          instruction: answerInstruction(this.deckFinished),
        })
        this.requestReply({ tools: false })
        break
      case 'resume':
        this.toolOutput(call.call_id, { ok: true })
        this.presentFrom(this.cursor, 'resume')
        break
      case 'jump':
        this.toolOutput(call.call_id, { ok: true })
        this.presentFrom(action.index, 'jump')
        break
      case 'invalid':
        // Let the model see the error and try again with valid ids.
        this.toolOutput(call.call_id, action.output)
        this.requestReply({ tools: true })
        break
    }
  }

  private requestReply({ tools }: { tools: boolean }): void {
    this.turn = 'reply'
    this.requestResponse(tools ? {} : { tool_choice: 'none' })
    this.io.setState('thinking')
  }

  /**
   * Ask the model to speak. The response counts as active from this moment,
   * not from response.created, so a click in between cancels it instead of
   * racing it with a second response.create.
   */
  private requestResponse(response: Record<string, unknown>): void {
    this.responseActive = true
    this.awaitingCreated = true
    this.createEventId = `create_${++this.createCount}`
    this.io.send({ type: 'response.create', event_id: this.createEventId, response })
  }

  /**
   * The server refused our response.create, so no response.created or
   * response.done will come for it. Undo "active", or every later cancel
   * would wait forever for a response that never started.
   */
  private onCreateRejected(code: string | undefined, message: string | undefined): void {
    this.awaitingCreated = false
    if (code === 'conversation_already_has_active_response') {
      // Another response is running; its response.done carries the flow on.
      this.io.log('error', { code })
      return
    }
    this.responseActive = false
    const next = this.afterCancel
    this.afterCancel = null
    if (next) {
      next() // a cancel was waiting on this request: there is nothing to cancel
      return
    }
    this.io.setError(message ?? 'The model could not start a response.')
    this.io.log('error', { code, message })
    this.io.setState('listening')
  }

  /** Stop the agent mid-speech, then run `next` once the server confirms. */
  private cancelSpeech(next: (() => void) | null): void {
    // Whatever was being said no longer leads anywhere; `next` decides what follows.
    this.turn = 'idle'
    this.cancelTimers()
    this.dropPending('cancelled by the user')
    if (this.audioPlaying || this.turnHasAudio) this.io.send({ type: 'output_audio_buffer.clear' })
    this.audioPlaying = false
    const then = next ?? (() => this.io.setState('listening'))
    if (this.responseActive) {
      this.afterCancel = then
      // Not confirmed yet: the cancel is sent when response.created arrives.
      if (!this.awaitingCreated) this.io.send({ type: 'response.cancel' })
    } else {
      then()
    }
  }

  // ---- small helpers --------------------------------------------------------

  /** Hands-free: nobody should have to say "continue" after every answer. */
  private scheduleAutoResume(): void {
    this.cancelTimers()
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined
      if (this.userSpeaking || this.responseActive || this.paused) return
      this.io.log('auto_resume')
      this.presentFrom(this.cursor, 'resume')
    }, AUTO_RESUME_MS)
  }

  /** A finished demo should not hold the session open until the time limit. */
  private scheduleEnd(): void {
    this.cancelTimers()
    this.endTimer = setTimeout(() => {
      this.endTimer = undefined
      if (this.userSpeaking || this.responseActive || this.paused) return
      this.io.log('auto_end')
      this.io.endCall()
    }, END_AFTER_CLOSE_MS)
  }

  /** Something happened (speech, a click, a new block): no timer should fire now. */
  private cancelTimers(): void {
    clearTimeout(this.resumeTimer)
    this.resumeTimer = undefined
    clearTimeout(this.endTimer)
    this.endTimer = undefined
  }

  /** Close out queued tool calls without acting on them, e.g. after a barge-in. */
  private dropPending(reason: string): void {
    for (const call of this.pending.splice(0)) this.toolOutput(call.call_id, { ok: false, not_done: true, reason })
  }

  private markInterruptedIfTalking(): void {
    if (this.audioPlaying || this.responseActive) this.updateTranscript(markAgentInterrupted)
  }

  /**
   * Ask the model to speak a PRESENT or CLOSE note, with a clean prompt: the
   * session instructions and this note only, not the conversation so far.
   * In the shared conversation, leftovers (a tool result's "Answer now",
   * noise, an unanswered question) sometimes won over the note, and the model
   * re-answered or went off script. What it says still joins the conversation,
   * so later answers know what was presented. Tools are off: the app already
   * knows what this turn should say.
   */
  private speakNote(text: string): void {
    this.requestResponse({
      tool_choice: 'none',
      conversation: 'auto',
      input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text }] }],
    })
  }

  private toolOutput(callId: string, output: unknown): void {
    this.io.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    })
  }

  private updateTranscript(update: (lines: TranscriptLine[]) => TranscriptLine[]): void {
    const next = update(this.transcript)
    if (next === this.transcript) return
    this.transcript = next
    this.io.setTranscript(next)
  }
}
