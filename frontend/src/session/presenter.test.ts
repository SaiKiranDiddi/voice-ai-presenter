/**
 * The presentation flow, driven with scripted Realtime server events.
 * Each test is one thing a listener can do; the first group maps to GOAL.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, FocusMode, ServerEvent, TranscriptLine } from '../types'
import { AUTO_RESUME_MS, END_AFTER_CLOSE_MS, Presenter } from './presenter'
import { testDeck } from './testDeck'

type Sent = Record<string, any>

function setup() {
  const sent: Sent[] = []
  const focus: [string, string, FocusMode][] = []
  const states: AgentState[] = []
  let transcript: TranscriptLine[] = []
  const io = {
    send: (event: Sent) => sent.push(event),
    focus: (slideId: string, blockId: string, mode: FocusMode) => focus.push([slideId, blockId, mode]),
    clearHighlight: vi.fn(),
    setState: (state: AgentState) => states.push(state),
    setTranscript: (lines: TranscriptLine[]) => (transcript = lines),
    setError: vi.fn(),
    setLatency: vi.fn(),
    log: vi.fn(),
    endCall: vi.fn(),
  }
  const p = new Presenter(testDeck, io)
  const ev = (event: ServerEvent) => p.handle(event)
  let n = 0

  /** The model speaks one turn, from generation to the end of playback. */
  const agentSays = (text: string, { cutBeforeAudioEnds = false } = {}) => {
    const item_id = `agent${++n}`
    ev({ type: 'response.created' })
    ev({ type: 'response.output_audio_transcript.delta', item_id, delta: text })
    ev({ type: 'response.output_audio_transcript.done', item_id, transcript: text })
    ev({ type: 'response.done', response: { status: 'completed' } })
    ev({ type: 'output_audio_buffer.started' })
    if (!cutBeforeAudioEnds) ev({ type: 'output_audio_buffer.stopped' })
  }

  /** The model answers the user with one tool call and no audio. */
  const agentCalls = (name: string, args: object) => {
    ev({ type: 'response.created' })
    ev({ type: 'response.function_call_arguments.done', call_id: `call${++n}`, name, arguments: JSON.stringify(args) })
    ev({ type: 'response.done', response: { status: 'completed' } })
  }

  /** The user talks over whatever is happening. */
  const userSays = (text: string) => {
    const item_id = `user${++n}`
    ev({ type: 'input_audio_buffer.speech_started', item_id })
    ev({ type: 'input_audio_buffer.speech_stopped' })
    ev({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text })
  }

  /** Every note sent so far; notes travel inside response.create as a clean prompt. */
  const allNotes = () =>
    sent.filter((e) => e.type === 'response.create' && e.response?.input).map((e) => e.response.input[0].content[0].text as string)
  /** PRESENT / CLOSE notes: everything after the greeting. */
  const notes = () => allNotes().filter((text) => !text.startsWith('GREET:'))
  const lastNote = () => notes().at(-1) ?? ''
  const toolOutputs = () =>
    sent.filter((e) => e.item?.type === 'function_call_output').map((e) => JSON.parse(e.item.output))
  const lastFocus = () => focus.at(-1)

  /** Open the call and let the greeting play, so block 0 is the next thing spoken. */
  const begin = () => {
    p.start()
    agentSays('Hello, I will cover the intro and dosing.')
  }

  return { p, io, ev, begin, allNotes, sent, focus, states, getTranscript: () => transcript, agentSays, agentCalls, userSays, notes, lastNote, toolOutputs, lastFocus }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('presenting the deck', () => {
  it('greets over the cover first, then presents the first block with tools off', () => {
    const t = setup()
    t.p.start()
    expect(t.allNotes()).toHaveLength(1)
    expect(t.allNotes()[0]).toMatch(/^GREET: Greet the physician/)
    expect(t.sent.at(-1)).toMatchObject({ type: 'response.create', response: { tool_choice: 'none' } })
    expect(t.focus).toHaveLength(0) // the cover stays up: no slide is shown yet

    t.agentSays('Hello, I will cover the intro and dosing.')
    expect(t.lastNote()).toMatch(/^PRESENT: This starts a new slide/)
    expect(t.lastFocus()).toEqual(['intro', 'intro.what', 'presenting'])
  })

  it('a question during the greeting is answered, then the deck starts at the first block', () => {
    const t = setup()
    t.p.start()
    t.userSays('What is it?')
    t.agentCalls('show_answer', { block_id: 'intro.what' })
    t.agentSays('A test drug. Anything else, or shall I carry on?')
    vi.advanceTimersByTime(AUTO_RESUME_MS)
    expect(t.lastFocus()).toEqual(['intro', 'intro.what', 'presenting'])
  })

  it('speaks each note from a clean prompt, without adding it to the conversation', () => {
    // Replays call e57157bb: after an answer, the resume note must not be
    // read next to the tool result's "Answer now" instruction.
    const t = setup()
    t.begin()
    t.userSays('Tell me about safety')
    t.agentCalls('show_answer', { block_id: 'dosing.renal' })
    t.agentSays('No adjustment. Anything else, or shall I carry on?')
    vi.advanceTimersByTime(AUTO_RESUME_MS)

    const resume = t.sent.at(-1)
    expect(resume).toMatchObject({ type: 'response.create', response: { tool_choice: 'none', conversation: 'auto' } })
    expect(resume?.response.input).toHaveLength(1)
    expect(resume?.response.input[0]).toMatchObject({ type: 'message', role: 'system' })
    expect(t.lastNote()).toContain('Back to the presentation')
    expect(t.sent.some((e) => e.type === 'conversation.item.create' && e.item?.role === 'system')).toBe(false)
  })

  it('moves to the next block only once the audio has finished playing', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is a test drug.', { cutBeforeAudioEnds: true })
    expect(t.notes()).toHaveLength(1) // generation done, still speaking: no slide change
    t.ev({ type: 'output_audio_buffer.stopped' })
    expect(t.notes()).toHaveLength(2)
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
    expect(t.lastNote()).toContain('This starts a new slide')
  })

  it('walks every block and then closes', () => {
    const t = setup()
    t.begin()
    for (let i = 0; i < 3; i++) t.agentSays(`block ${i}`)
    expect(t.lastNote()).toMatch(/^CLOSE:/)
    expect(t.io.clearHighlight).toHaveBeenCalled()
    t.agentSays('Thanks, any questions?')
    expect(t.states.at(-1)).toBe('listening')
    vi.advanceTimersByTime(AUTO_RESUME_MS * 2)
    expect(t.lastNote()).toMatch(/^CLOSE:/) // nothing more happens
  })
})

describe('ending on its own after the deck', () => {
  /** Present every block and speak the closing line. */
  const finishDeck = (t: ReturnType<typeof setup>) => {
    t.begin()
    for (let i = 0; i < 3; i++) t.agentSays(`block ${i}`)
    t.agentSays('Thanks, any questions?')
  }

  it('ends the call once the user stays quiet after the closing line', () => {
    const t = setup()
    finishDeck(t)
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS - 1)
    expect(t.io.endCall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(t.io.endCall).toHaveBeenCalledTimes(1)
    expect(t.io.log).toHaveBeenCalledWith('auto_end')
  })

  it('a question cancels it; the quiet after the answer starts it again', () => {
    const t = setup()
    finishDeck(t)
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS - 1000)
    t.userSays('Does it need a renal adjustment?')
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS)
    expect(t.io.endCall).not.toHaveBeenCalled() // still waiting for the answer

    t.agentCalls('show_answer', { block_id: 'dosing.renal' })
    t.agentSays('No adjustment. Anything else?')
    vi.advanceTimersByTime(AUTO_RESUME_MS)
    expect(t.lastNote()).toMatch(/^CLOSE:/) // no auto-resume after the deck
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS - AUTO_RESUME_MS)
    expect(t.io.endCall).toHaveBeenCalledTimes(1)
  })

  it('noise after the close does not keep the call open', () => {
    const t = setup()
    finishDeck(t)
    t.ev({ type: 'input_audio_buffer.speech_started', item_id: 'n' })
    t.ev({ type: 'input_audio_buffer.speech_stopped' })
    t.ev({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'n', transcript: '' })
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS)
    expect(t.io.endCall).toHaveBeenCalledTimes(1)
  })

  it('going back to a slide after the close cancels it', () => {
    const t = setup()
    finishDeck(t)
    t.p.goToSlide('dosing')
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
    vi.advanceTimersByTime(END_AFTER_CLOSE_MS * 2)
    expect(t.io.endCall).not.toHaveBeenCalled()
  })

})

describe('goal: the slide changes to answer a question', () => {
  it('show_answer jumps to the answering block and hands the model its facts', () => {
    const t = setup()
    t.begin()
    t.userSays('Does it need a renal adjustment?')
    t.agentCalls('show_answer', { slide_id: 'dosing', block_id: 'dosing.renal' })
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.renal', 'answering'])
    expect(t.toolOutputs().at(-1)).toMatchObject({ ok: true, facts: ['No renal adjustment.'] })
    expect(t.sent.at(-1)).toMatchObject({ type: 'response.create', response: { tool_choice: 'none' } })
  })

  it('present_slide goes to the slide the user asked for', () => {
    const t = setup()
    t.begin()
    t.userSays('Show me dosing')
    t.agentCalls('present_slide', { slide_id: 'dosing' })
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
    expect(t.lastNote()).toMatch(/^PRESENT: Begin by naming this slide's topic/)
  })

  it('a bad id is returned to the model with tools on, so it can retry', () => {
    const t = setup()
    t.begin()
    t.userSays('What about pricing?')
    t.agentCalls('present_slide', { slide_id: 'pricing' })
    expect(t.toolOutputs().at(-1)).toMatchObject({ ok: false, valid_slide_ids: ['intro', 'dosing'] })
    expect(t.sent.at(-1)).toMatchObject({ type: 'response.create' })
    expect(t.sent.at(-1)?.response).toEqual({})
  })

  it('acts on only the first of several tool calls', () => {
    const t = setup()
    t.begin()
    t.userSays('Dosing?')
    t.ev({ type: 'response.created' })
    t.ev({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'present_slide', arguments: '{"slide_id":"dosing"}' })
    t.ev({ type: 'response.function_call_arguments.done', call_id: 'b', name: 'present_slide', arguments: '{"slide_id":"intro"}' })
    t.ev({ type: 'response.done', response: { status: 'completed' } })
    expect(t.lastFocus()?.[0]).toBe('dosing')
    expect(t.toolOutputs()).toContainEqual({ ok: false, ignored: 'one tool call per turn' })
  })
})

describe('goal: the user can interrupt', () => {
  it('barge-in marks the agent line interrupted and keeps the place in the deck', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is')
    t.agentSays('Once daily', { cutBeforeAudioEnds: true }) // block 1 playing
    t.ev({ type: 'input_audio_buffer.speech_started', item_id: 'u' })
    expect(t.states.at(-1)).toBe('listening')
    expect(t.getTranscript().find((l) => l.text === 'Once daily')?.interrupted).toBe(true)
    expect(t.p.cursor).toBe(1)
  })

  it('after an answer it resumes the cut-off block on its own if the user stays quiet', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is')
    t.agentSays('Once daily', { cutBeforeAudioEnds: true })
    t.userSays('Any renal adjustment?')
    t.agentCalls('show_answer', { slide_id: 'dosing', block_id: 'dosing.renal' })
    t.agentSays('No adjustment needed. Anything else, or shall I carry on?')
    expect(t.states.at(-1)).toBe('listening')

    vi.advanceTimersByTime(AUTO_RESUME_MS - 1)
    expect(t.lastNote()).not.toContain('Back to the presentation')
    vi.advanceTimersByTime(1)
    expect(t.lastNote()).toContain('Back to the presentation')
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

  it('does not auto-resume if the user speaks again', () => {
    const t = setup()
    t.begin()
    t.userSays('What is it?')
    t.agentCalls('show_answer', { block_id: 'intro.what' })
    t.agentSays('A test drug. Anything else?')
    const before = t.notes().length
    t.ev({ type: 'input_audio_buffer.speech_started', item_id: 'u2' })
    vi.advanceTimersByTime(AUTO_RESUME_MS * 2)
    expect(t.notes()).toHaveLength(before)
  })

  it('"continue" resumes from the interrupted block', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is')
    t.userSays('Hmm, okay, go on')
    t.agentCalls('continue_presentation', {})
    expect(t.lastNote()).toContain('Back to the presentation')
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

  it('the Stop button cancels speech, then waits without resuming', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'response.created' })
    t.ev({ type: 'output_audio_buffer.started' })
    t.p.stopSpeaking()
    expect(t.sent.slice(-2)).toEqual([{ type: 'output_audio_buffer.clear' }, { type: 'response.cancel' }])
    t.ev({ type: 'response.done', response: { status: 'cancelled' } })
    expect(t.states.at(-1)).toBe('listening')
    vi.advanceTimersByTime(AUTO_RESUME_MS * 2)
    expect(t.notes()).toHaveLength(1)
  })

  it('the Continue button resumes the block that Stop cut off', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is')
    t.ev({ type: 'response.created' })
    t.ev({ type: 'output_audio_buffer.started' }) // block 1 playing
    t.p.stopSpeaking()
    t.ev({ type: 'response.done', response: { status: 'cancelled' } })
    t.p.resume()
    expect(t.lastNote()).toContain('Back to the presentation')
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

  it('a cancel we asked for wins even if the response completed first', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'response.created' })
    t.p.stopSpeaking()
    t.ev({ type: 'response.done', response: { status: 'completed' } })
    t.ev({ type: 'output_audio_buffer.stopped' })
    expect(t.notes()).toHaveLength(1)
  })
})

describe('buttons', () => {
  it('clicking a slide while the agent speaks cancels, then presents that slide', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'response.created' })
    t.p.goToSlide('dosing')
    expect(t.notes()).toHaveLength(1) // waits for the cancel to land
    t.ev({ type: 'response.done', response: { status: 'cancelled' } })
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

  it('a click just after the next block was requested cancels it, not races it', () => {
    const t = setup()
    t.begin()
    t.agentSays('Testex is a test drug.') // block 0 ends; block 1 is requested
    const creates = () => t.sent.filter((e) => e.type === 'response.create').length
    expect(creates()).toBe(3)

    t.p.goToSlide('intro') // before the server confirmed block 1's response
    expect(creates()).toBe(3) // no second response.create while one is in flight
    t.ev({ type: 'response.created' })
    expect(t.sent.at(-1)).toEqual({ type: 'response.cancel' })
    t.ev({ type: 'response.done', response: { status: 'cancelled' } })
    expect(t.lastFocus()).toEqual(['intro', 'intro.what', 'presenting'])

    // The clicked slide is presented from its first block, then the deck carries on in order.
    t.agentSays('Testex is a test drug.')
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

})

describe('when the server refuses a response.create', () => {
  const lastCreateId = (sent: Sent[]) => sent.filter((e) => e.type === 'response.create').at(-1)?.event_id

  it('a refused request does not leave the buttons waiting forever', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'error', error: { code: 'invalid_request_error', message: 'nope', event_id: lastCreateId(t.sent) } })
    expect(t.io.setError).toHaveBeenCalledWith('nope')
    expect(t.states.at(-1)).toBe('listening')

    // A slide click now goes straight through: there is nothing to cancel.
    t.p.goToSlide('dosing')
    expect(t.sent.some((e) => e.type === 'response.cancel')).toBe(false)
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
  })

  it('a click waiting on a refused request runs at once', () => {
    const t = setup()
    t.begin()
    t.p.goToSlide('dosing') // queued until the first response is confirmed
    t.ev({ type: 'error', error: { code: 'invalid_request_error', event_id: lastCreateId(t.sent) } })
    expect(t.lastFocus()).toEqual(['dosing', 'dosing.schedule', 'presenting'])
    expect(t.io.setError).not.toHaveBeenCalled()
  })

  it('"already has an active response" waits for that response instead', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'error', error: { code: 'conversation_already_has_active_response', event_id: lastCreateId(t.sent) } })
    expect(t.io.setError).not.toHaveBeenCalled()
    t.ev({ type: 'response.created' })
    t.ev({ type: 'response.done', response: { status: 'completed' } })
    expect(t.lastFocus()?.[1]).toBe('dosing.schedule') // the flow carried on
  })

  it('an error about some other event leaves the request in flight', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'error', error: { code: 'item_not_found', event_id: 'something_else' } })
    t.p.goToSlide('dosing')
    expect(t.lastFocus()?.[1]).toBe('intro.what') // still waits for the cancel to land
  })
})

describe('noise mistaken for speech', () => {
  it('a turn with an empty transcript is removed from the model\'s conversation', () => {
    // Replays call dc382645: a cough cut a block off, the model called
    // continue_presentation, and the empty transcript arrived just after.
    const t = setup()
    t.begin()
    t.agentSays('Testex is', { cutBeforeAudioEnds: true })
    t.ev({ type: 'input_audio_buffer.speech_started', item_id: 'cough' })
    t.ev({ type: 'input_audio_buffer.speech_stopped' })
    t.agentCalls('continue_presentation', {})
    expect(t.lastNote()).toContain('Back to the presentation')

    t.ev({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'cough', transcript: '  ' })
    expect(t.sent.at(-1)).toEqual({ type: 'conversation.item.delete', event_id: 'delete_cough', item_id: 'cough' })
    expect(t.getTranscript().some((l) => l.id === 'cough')).toBe(false)
  })

  it('a failed delete is logged, not shown to the user', () => {
    const t = setup()
    t.begin()
    t.ev({ type: 'error', error: { code: 'item_not_found', event_id: 'delete_cough' } })
    expect(t.io.setError).not.toHaveBeenCalled()
  })

  it('real speech stays in the conversation', () => {
    const t = setup()
    t.begin()
    t.userSays('Is it once daily?')
    expect(t.sent.some((e) => e.type === 'conversation.item.delete')).toBe(false)
  })
})
