import { describe, expect, it } from 'vitest'
import { answerInstruction, closeNote, greetingNote, presentNote } from './notes'
import { testDeck } from './testDeck'

describe('greetingNote', () => {
  it('says what the deck is about and presents nothing yet', () => {
    const note = greetingNote({ ...testDeck, description: 'A test drug.' })
    expect(note).toMatch(/^GREET: Welcome the physician/)
    expect(note).toContain('It is about Testex: A test drug.')
    expect(note).not.toContain('Talking point')
  })
})

describe('presentNote', () => {

  it('names the topic when a new slide starts, and carries on within a slide', () => {
    expect(presentNote(testDeck, 1, 'next')).toContain('This starts a new slide')
    expect(presentNote(testDeck, 2, 'next')).toContain('Carry straight on')
  })

  it('names the slide topic when jumping to the start of a slide', () => {
    expect(presentNote(testDeck, 1, 'jump')).toContain("naming this slide's topic")
    expect(presentNote(testDeck, 2, 'jump')).toContain('\nPresent this now.\n')
  })

  it('tells the model the call is already under way, so it does not greet again', () => {
    // Replays call 37fb52af: the first block after the greeting came out as
    // "Hey there. I'm ready whenever you are."
    expect(presentNote(testDeck, 0, 'next')).toMatch(/^PRESENT: The call is already under way and you have already greeted the physician/)
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
