import { describe, expect, it } from 'vitest'
import { answerInstruction, closeNote, presentNote } from './notes'
import { testDeck } from './testDeck'

describe('presentNote', () => {
  it('greets with the agenda on the first block', () => {
    const note = presentNote(testDeck, 0, 'greeting')
    expect(note).toMatch(/^PRESENT: First greet the physician/)
    expect(note).toContain('(intro, dosing)')
    expect(note).toContain('Talking point: Talking point for intro.what')
  })

  it('names the topic when a new slide starts, and carries on within a slide', () => {
    expect(presentNote(testDeck, 1, 'next')).toContain('This starts a new slide')
    expect(presentNote(testDeck, 2, 'next')).toContain('Carry straight on')
  })

  it('names the slide topic when jumping to the start of a slide', () => {
    expect(presentNote(testDeck, 1, 'jump')).toContain("naming this slide's topic")
    expect(presentNote(testDeck, 2, 'jump')).toMatch(/^PRESENT: Present this now\./)
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
