import { describe, expect, it } from 'vitest'
import { answerInstruction, closeNote, presentNote } from './notes'
import { testDeck } from './testDeck'

describe('presentNote', () => {
  it('opens the call by saying what the deck is about, from the first block', () => {
    const note = presentNote(testDeck, 0, 'greeting')
    expect(note).toMatch(/^GREET: Welcome the physician/)
    expect(note).toContain('from this: Talking point for intro.what')
    expect(note).toContain('interrupt')
  })

  it('tells the model the call is already under way, so it does not greet again', () => {
    // Replays call 37fb52af: a block after the greeting came out as
    // "Hey there. I'm ready whenever you are."
    expect(presentNote(testDeck, 1, 'next')).toMatch(/^PRESENT: The call is already under way and you have already greeted the physician/)
  })

  it('adds no lead-in, not even on a new slide, so the model has no phrase to repeat', () => {
    // Replays a live call where "Turning to..." opened every slide.
    for (const lead of ['next', 'jump'] as const) {
      const note = presentNote(testDeck, 1, lead)
      expect(note).not.toMatch(/topic|turning/i)
    }
    expect(presentNote(testDeck, 1, 'next')).toContain('Carry straight on')
    expect(presentNote(testDeck, 2, 'jump')).toContain('\nPresent this now.\n')
  })

  it('sends the talking point, never the fact list', () => {
    expect(presentNote(testDeck, 1, 'jump')).not.toContain('Once daily.')
  })
})

describe('closeNote and answerInstruction', () => {
  it('closes by addressing the audience', () => {
    expect(closeNote(testDeck)).toMatch(/^CLOSE: .*physician/)
  })

  it('offers to carry on only while the deck is unfinished', () => {
    expect(answerInstruction(false)).toContain('shall I carry on?')
    expect(answerInstruction(true)).not.toContain('carry on')
  })
})
