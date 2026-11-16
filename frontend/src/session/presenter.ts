/**
 * The presentation flow, with no React, WebRTC or DOM in it.
 *
 * The model is the voice and the judgement (which block answers a question).
 * The Presenter is the sequencer: it decides which block is presented next,
 * when to resume after a question, and where to resume from.
 *
 * It reacts to two kinds of input:
 *   - server events from the Realtime data channel: handle(event)
 *   - the user's buttons: start, stopSpeaking, resume, goToSlide
 * and acts only through the PresenterIO functions it is given, so tests can
 * drive it with a fake `send` and fake timers.
 *
 * Two helpers keep it to deck logic only:
 *   - ResponseTracker (responses.ts) knows when the model has finished a turn
 *     and how to cancel one safely.
 *   - Transcript (transcript.ts) records what was said.
 */
import type { AgentState, Deck, FocusMode, ServerEvent, TranscriptLine } from '../types'
import { flattenDeck, firstBlockOfSlide, type FlatBlock } from './deck'
import { answerInstruction, closeNote, presentNote, type Lead } from './notes'
import { ResponseTracker } from './responses'
import { resolveToolCall, type ToolCall } from './tools'
import { Transcript } from './transcript'

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
  private readonly responses: ResponseTracker
  private readonly transcript: Transcript

  /** The block being presented, and the one to resume from after a question. */
  cursor = 0
  deckFinished = false

  private turn: TurnKind = 'block'
  /** The call is open. Until then nothing can be said, so a slide click only moves the cursor. */
  private started = false
  /** Tool calls from the current response, run once its turn finishes. */
  private pending: ToolCall[] = []
  private userSpeaking = false
  private speechStoppedAt: number | null = null
  /** The auto-resume or end-of-call wait, whichever is running. */
  private quietTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deck: Deck, io: PresenterIO) {
    this.deck = deck
    this.io = io
    this.blocks = flattenDeck(deck)
    this.transcript = new Transcript(io.setTranscript, io.log)
    this.responses = new ResponseTracker({
      send: io.send,
      log: io.log,
      onAudioStart: () => this.onAudioStart(),
      onSettle: () => this.maybeFinishTurn(),
      onCancelled: (next) => {
        this.dropPending('cancelled')
        if (next) next()
        else if (!this.userSpeaking) this.io.setState('listening')
      },
      onFailed: (message) => this.showError(message),
      onRejected: (message, code) => {
        this.showError(message, code)
        this.io.setState('listening')
      },
    })
  }

  // ---- user actions ---------------------------------------------------------

  /**
   * The call is open: greet over the first block (the title page) and carry on
   * from there. If the user already picked a slide while connecting, start on it.
   */
  start(): void {
    this.started = true
    this.presentFrom(this.cursor, this.cursor === 0 ? 'greeting' : 'jump')
  }

  /** Stop button: silence the agent and wait. No auto-resume after this. */
  stopSpeaking(): void {
    if (!this.started) return
    this.io.log('interruption', { via: 'button' })
    this.cancelSpeech(() => this.io.setState('listening'))
  }

  /** Continue button: carry on from the block that was stopped or interrupted. */
  resume(): void {
    if (!this.started || this.deckFinished) return
    this.io.log('manual_resume')
    this.cancelSpeech(() => this.presentFrom(this.cursor, 'resume'))
  }

  /** The user picked a slide: stop whatever is being said and present it. */
  goToSlide(slideId: string): void {
    const index = firstBlockOfSlide(this.deck, slideId)
    if (index === -1) return
    this.io.log('manual_nav', { slide_id: slideId })
    if (!this.started) {
      this.cursor = index
      return
    }
    this.cancelSpeech(() => this.presentFrom(index, 'jump'))
  }

  /** The call is over: stop any pending timer. */
  dispose(): void {
    this.cancelTimer()
  }

  // ---- server events --------------------------------------------------------

  handle(event: ServerEvent): void {
    // Record every non-streaming event so a call can be replayed from its log.
    if (!event.type.endsWith('.delta')) this.io.log('ev', { t: event.type, status: event.response?.status })

    this.transcript.handle(event)
    this.responses.handle(event)

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in. The server cancels the response and clears its audio for
        // us (interrupt_response). The cursor is left alone, so the deck later
        // resumes from the block that was cut off. What the model says next is a reply.
        if (this.responses.talking) {
          this.transcript.markInterrupted()
          this.io.log('interruption')
        }
        this.responses.userInterrupted()
        this.userSpeaking = true
        this.turn = 'reply'
        this.cancelTimer()
        this.dropPending('the user interrupted')
        this.io.setState('listening')
        break

      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false
        this.speechStoppedAt = performance.now()
        this.io.setState('thinking')
        break

      case 'conversation.item.input_audio_transcription.completed':
        if (!(event.transcript ?? '').trim()) this.removeNoise(event.item_id ?? '')
        break

      case 'response.function_call_arguments.done':
        this.pending.push({ call_id: event.call_id ?? '', name: event.name ?? '', arguments: event.arguments ?? '' })
        break

      case 'error': {
        const { code, message, event_id } = event.error ?? {}
        if (event_id?.startsWith('delete_')) {
          // Removing a noise turn is housekeeping; if it fails, the call goes on.
          this.io.log('error', { code, event_id })
        } else if (!this.responses.handleError(event.error)) {
          this.showError(message ?? 'Realtime error', code)
        }
        break
      }
    }
  }

  // ---- the sequencer --------------------------------------------------------

  /** Present block `index` (or the closing line past the last block), from silence. */
  private presentFrom(index: number, lead: Lead): void {
    this.cancelTimer()
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

  /** If generation and playback have both finished, decide what happens next. */
  private maybeFinishTurn(): void {
    if (this.responses.active) return
    if (this.userSpeaking) {
      // The user is mid-sentence; their turn decides what happens next.
      this.dropPending('the user is speaking')
      return
    }
    // The model generates faster than it speaks; wait for the audio to drain
    // so the slide never moves mid-sentence.
    if (!this.responses.audioDrained) return

    if (this.pending.length > 0) {
      this.runToolCall()
      return
    }
    switch (this.turn) {
      case 'block':
        this.presentFrom(this.cursor + 1, 'next')
        break
      case 'reply':
      case 'closing':
        this.io.setState('listening')
        this.waitForQuiet()
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
    this.responses.request(tools ? {} : { tool_choice: 'none' })
    this.io.setState('thinking')
  }

  /**
   * Ask the model to speak a GREET, PRESENT or CLOSE note, with a clean prompt: the
   * session instructions and this note only, not the conversation so far.
   * In the shared conversation, leftovers (a tool result's "Answer now",
   * noise, an unanswered question) sometimes won over the note, and the model
   * re-answered or went off script. What it says still joins the conversation,
   * so later answers know what was presented. Tools are off: the app already
   * knows what this turn should say.
   */
  private speakNote(text: string): void {
    this.responses.request({
      tool_choice: 'none',
      conversation: 'auto',
      input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text }] }],
    })
  }

  /** A button was pressed: stop the agent mid-speech, then run `next`. */
  private cancelSpeech(next: () => void): void {
    if (this.responses.talking) this.transcript.markInterrupted()
    // Whatever was being said no longer leads anywhere; `next` decides what follows.
    this.turn = 'idle'
    this.cancelTimer()
    this.dropPending('cancelled by the user')
    this.responses.cancel(next)
  }

  // ---- small helpers --------------------------------------------------------

  /**
   * The agent has finished and is listening. If the user stays quiet, carry on:
   * resume the deck (nobody should have to say "continue" after every answer),
   * or, once the deck is finished, end the call so it does not sit open.
   */
  private waitForQuiet(): void {
    this.cancelTimer()
    this.quietTimer = setTimeout(
      () => {
        this.quietTimer = undefined
        if (this.userSpeaking || this.responses.active) return
        if (this.deckFinished) {
          this.io.log('auto_end')
          this.io.endCall()
        } else {
          this.io.log('auto_resume')
          this.presentFrom(this.cursor, 'resume')
        }
      },
      this.deckFinished ? END_AFTER_CLOSE_MS : AUTO_RESUME_MS,
    )
  }

  /** Something happened (speech, a click, a new block): the quiet wait is off. */
  private cancelTimer(): void {
    clearTimeout(this.quietTimer)
    this.quietTimer = undefined
  }

  private onAudioStart(): void {
    this.io.setState('speaking')
    if (this.speechStoppedAt === null) return
    const ms = Math.round(performance.now() - this.speechStoppedAt)
    this.speechStoppedAt = null
    this.io.setLatency(ms)
    this.io.log('latency', { ms })
  }

  /**
   * A "user turn" with an empty transcript was noise. Remove it from the
   * model's conversation too: left there, it stays an unanswered user turn
   * and the model keeps trying to answer it instead of presenting.
   */
  private removeNoise(itemId: string): void {
    this.io.send({ type: 'conversation.item.delete', event_id: `delete_${itemId}`, item_id: itemId })
    this.io.log('noise_removed', { item_id: itemId })
    // After the close, noise must not keep the call open: if no reply
    // follows, the end wait starts again. A reply restarts it anyway.
    if (this.deckFinished && !this.responses.active && !this.userSpeaking) this.waitForQuiet()
  }

  /** Close out queued tool calls without acting on them, e.g. after a barge-in. */
  private dropPending(reason: string): void {
    for (const call of this.pending.splice(0)) this.toolOutput(call.call_id, { ok: false, not_done: true, reason })
  }

  private toolOutput(callId: string, output: unknown): void {
    this.io.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    })
  }

  private showError(message: string, code?: string): void {
    this.io.setError(message)
    this.io.log('error', { code, message })
  }
}
