/**
 * Tracks the model's response: the one being generated or still being played.
 *
 * The Realtime API allows one response at a time, and three things about it
 * are easy to get wrong. They are all handled here so the Presenter never has to:
 *   - A turn is over only when generation has finished AND the audio has
 *     finished playing. The model generates faster than it speaks.
 *   - A response counts as active from the moment we ask for it, not from the
 *     server's response.created, so a click in between cancels it instead of
 *     racing it with a second response.create.
 *   - Cancelling is not instant. `cancel(then)` runs `then` once the server
 *     confirms, or at once if there was nothing to cancel.
 */
import type { ServerEvent } from '../types'

const ALREADY_ACTIVE = 'conversation_already_has_active_response'

export interface ResponseHooks {
  /** Send a client event to the Realtime API. */
  send: (event: Record<string, unknown>) => void
  log: (type: string, data?: Record<string, unknown>) => void
  /** The agent's audio started playing. */
  onAudioStart: () => void
  /** Generation or playback just finished. The turn is over when `active` is false and `audioDrained` is true. */
  onSettle: () => void
  /**
   * The response was cancelled. `next` is what our own cancel() asked to run
   * afterwards; it is null when the server cancelled it (the user barged in).
   */
  onCancelled: (next: (() => void) | null) => void
  /** The response started but failed. The flow still carries on. */
  onFailed: (message: string) => void
  /** The server refused to start a response, so nothing will be said. */
  onRejected: (message: string, code?: string) => void
}

export class ResponseTracker {
  private readonly hooks: ResponseHooks

  /** A response is in flight: from the moment we ask for one until response.done. */
  private inFlight = false
  /** We sent response.create and the server has not confirmed it with response.created yet. */
  private awaitingCreated = false
  /** event_id of our latest response.create, so an error can be matched to it. */
  private createEventId = ''
  private createCount = 0
  private turnHasAudio = false
  private audioDone = false
  private audioPlaying = false
  /** Runs once the response we asked to cancel has finished cancelling. */
  private afterCancel: (() => void) | null = null

  constructor(hooks: ResponseHooks) {
    this.hooks = hooks
  }

  /** A response has been requested or is being generated. */
  get active(): boolean {
    return this.inFlight
  }

  /** The agent is generating or audibly speaking. */
  get talking(): boolean {
    return this.audioPlaying || this.inFlight
  }

  /** Everything the current turn generated has been played (or it had no audio). */
  get audioDrained(): boolean {
    return !this.turnHasAudio || this.audioDone
  }

  /** Ask the model to speak. `response` is the body of a response.create event. */
  request(response: Record<string, unknown>): void {
    this.inFlight = true
    this.awaitingCreated = true
    this.createEventId = `create_${++this.createCount}`
    this.hooks.send({ type: 'response.create', event_id: this.createEventId, response })
  }

  /** Stop the agent mid-speech, then run `then` once the server confirms. */
  cancel(then: () => void): void {
    if (this.audioPlaying || this.turnHasAudio) this.hooks.send({ type: 'output_audio_buffer.clear' })
    this.audioPlaying = false
    if (!this.inFlight) return then()
    this.afterCancel = then
    // Not confirmed yet: the cancel is sent when response.created arrives.
    if (!this.awaitingCreated) this.hooks.send({ type: 'response.cancel' })
  }

  /** The user barged in. The server cancels the response and clears its audio for us. */
  userInterrupted(): void {
    this.audioPlaying = false
    this.afterCancel = null
  }

  handle(event: ServerEvent): void {
    switch (event.type) {
      case 'response.created':
        this.inFlight = true
        this.awaitingCreated = false
        this.turnHasAudio = false
        this.audioDone = false
        // A cancel requested before the server confirmed the response is sent now.
        if (this.afterCancel) this.hooks.send({ type: 'response.cancel' })
        break

      case 'response.output_audio_transcript.delta':
        this.turnHasAudio = true
        break

      case 'response.done': {
        this.inFlight = false
        const status = event.response?.status
        if (status === 'failed') {
          this.hooks.onFailed(event.response?.status_details?.error?.message ?? 'The model response failed.')
        }
        // A cancel we asked for wins even if the response managed to finish
        // first; otherwise the deck would carry on after "Stop".
        if (status === 'cancelled' || this.afterCancel) this.hooks.onCancelled(this.takeAfterCancel())
        else this.hooks.onSettle()
        break
      }

      case 'output_audio_buffer.started':
        this.audioPlaying = true
        this.audioDone = false
        this.turnHasAudio = true
        this.hooks.onAudioStart()
        break

      case 'output_audio_buffer.stopped':
        this.audioPlaying = false
        this.audioDone = true
        this.hooks.onSettle()
        break

      case 'output_audio_buffer.cleared':
        this.audioPlaying = false
        break
    }
  }

  /** Deals with a server error if it is about a response. Returns false if it is someone else's. */
  handleError(error: ServerEvent['error'] = {}): boolean {
    const { code, message, event_id } = error

    if (this.awaitingCreated && event_id === this.createEventId) {
      // Our response.create was refused, so no response.created or
      // response.done will come for it. Undo "active", or every later cancel
      // would wait forever for a response that never started.
      this.awaitingCreated = false
      if (code === ALREADY_ACTIVE) {
        // Another response is running; its response.done carries the flow on.
        this.hooks.log('error', { code })
        return true
      }
      this.inFlight = false
      const next = this.takeAfterCancel()
      if (next) next() // a cancel was waiting on this request: there is nothing to cancel
      else this.hooks.onRejected(message ?? 'The model could not start a response.', code)
      return true
    }

    if (code === 'response_cancel_not_active') {
      // Cancelling when nothing is in flight is expected and harmless. If our
      // response is still being set up, the cancel goes out on response.created.
      if (this.awaitingCreated) return true
      this.inFlight = false
      this.takeAfterCancel()?.()
      return true
    }

    if (code === ALREADY_ACTIVE) {
      this.awaitingCreated = false
      this.hooks.log('error', { code })
      return true
    }
    return false
  }

  private takeAfterCancel(): (() => void) | null {
    const next = this.afterCancel
    this.afterCancel = null
    return next
  }
}
