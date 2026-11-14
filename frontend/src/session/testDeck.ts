/** A small deck for unit tests: two slides, three blocks. Not used by the app. */
import type { Block, Deck } from '../types'

const block = (id: string, facts: string[]): Block => ({
  id,
  type: 'callout',
  talking_point: `Talking point for ${id}`,
  facts,
  content: { title: id, text: '' },
})

export const testDeck: Deck = {
  id: 'test',
  name: 'Testex',
  agent: { audience: 'physician' },
  slides: [
    {
      id: 'intro',
      title: 'Introduction',
      nav: 'Intro',
      layout: 'single',
      blocks: [block('intro.what', ['Testex is a test drug.'])],
    },
    {
      id: 'dosing',
      title: 'Dosing',
      nav: 'Dosing',
      layout: 'split',
      blocks: [block('dosing.schedule', ['Once daily.']), block('dosing.renal', ['No renal adjustment.'])],
    },
  ],
}
